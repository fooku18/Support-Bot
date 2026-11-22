/**
 * Runtime-owned Cloudflare provider for one admin-managed instance: a
 * read-only API token, the readiness probe (`GET /zones`, paginated, plus
 * `GET /accounts/{id}` when an account is configured), the resolved zone
 * snapshot and the endpoint/account/zone-set/credential binding. The token
 * stays in this process; readiness exposes only categories, zone metadata,
 * a hash and a fingerprint.
 */
import {
  CLOUDFLARE_ADAPTER,
  CLOUDFLARE_CONTRACT_VERSION,
  CLOUDFLARE_ENDPOINT,
  CLOUDFLARE_ID_PATTERN,
  CloudflareRequestError,
  buildCloudflareRequest,
  cloudflareCredentialFingerprint,
  cloudflareZoneSetHash,
  normalizeCloudflareGraphql,
  normalizeCloudflareRest,
  sendCloudflareRequest,
  validateCloudflareRequest,
  type CloudflareCallResult,
  type CloudflareFetch,
  type CloudflareOperation,
  type CloudflareScope,
} from './cloudflare-api-adapter.js';
import type {
  CloudflareRuntimeProviderStatus,
  CloudflareZone,
} from '../tools/tool-runtime-readiness.js';
import {
  ReadinessGrace,
  probeWithRetry,
  type ReadinessRetryOptions,
} from '../tools/readiness-grace.js';

/** Readiness is re-probed at most this often (on /readyz). */
export const CLOUDFLARE_READINESS_REFRESH_MS = 60_000;
/** Zones listed per readiness page and the most zones an instance exposes. */
export const CLOUDFLARE_ZONE_PAGE_SIZE = 50;
export const CLOUDFLARE_MAX_ZONES = 200;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 1_000_000;

/** One admin-managed Cloudflare instance: optional account and zone names, and the token. */
export interface CloudflareInstanceConfig {
  accountId: string | null;
  zones: string[] | null;
  token: string;
}

export class CloudflareApiProvider {
  readonly state: CloudflareRuntimeProviderStatus;
  private readonly token: string;
  private readonly zoneNames: string[] | null;
  private checkedAtMs = 0;
  private probing: Promise<CloudflareRuntimeProviderStatus> | null = null;
  readonly grace: ReadinessGrace;
  private readyDetail = '';

  constructor(
    config: CloudflareInstanceConfig,
    private readonly fetchImpl?: CloudflareFetch,
    private readonly now: () => number = Date.now,
    private readonly retry: ReadinessRetryOptions = {},
  ) {
    this.grace = new ReadinessGrace(now, retry);
    const accountId = (config.accountId ?? '').trim().toLowerCase() || null;
    const token = config.token.trim();
    this.token = token;
    this.zoneNames =
      config.zones === null || config.zones.length === 0
        ? null
        : [...new Set(config.zones.map((name) => name.trim().toLowerCase()))].sort();
    this.state = {
      tool: 'cloudflare',
      enabled: true,
      ready: false,
      status: 'missing_config',
      detail: '',
      endpoint: CLOUDFLARE_ENDPOINT,
      adapter: CLOUDFLARE_ADAPTER,
      contractVersion: CLOUDFLARE_CONTRACT_VERSION,
      accountId: accountId !== null && CLOUDFLARE_ID_PATTERN.test(accountId) ? accountId : null,
      restrictedZones: this.zoneNames !== null,
      zones: [],
      zoneSetHash: null,
      credentialFingerprint: null,
      checkedAt: null,
    };
    const missing: string[] = [];
    if (accountId !== null && this.state.accountId === null)
      missing.push('account ID (32 hex characters)');
    if (!token) missing.push('API token (Read permissions only)');
    else if (/[\s\0]/.test(token) || token.length < 8) missing.push('API token (malformed)');
    if (missing.length) {
      this.state.detail = `the Cloudflare instance is incomplete: ${missing.join('; ')}`;
      return;
    }
    this.state.credentialFingerprint = cloudflareCredentialFingerprint(token);
    this.state.status = 'error';
    this.state.detail = 'readiness has not been established yet';
  }

  /** Values this runtime must redact. */
  secrets(): string[] {
    return this.token.length >= 4 ? [this.token] : [];
  }

  get configured(): boolean {
    return this.state.credentialFingerprint !== null;
  }

  /** What the instance exposes (for validating requests against the snapshot). */
  scope(): CloudflareScope {
    return {
      accountId: this.state.accountId,
      zoneIds: this.state.zones.map((zone) => zone.id),
      restrictedZones: this.state.restrictedZones,
    };
  }

  private async get(
    path: string,
    query: Record<string, string> = {},
  ): Promise<{ category: string } | { body: Record<string, unknown> }> {
    const request = buildCloudflareRequest('get', { path, query });
    const http = await sendCloudflareRequest(request, this.token, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: PROBE_MAX_BYTES,
      fetchImpl: this.fetchImpl,
    });
    if (http.errorCategory) return { category: http.errorCategory };
    try {
      const body = JSON.parse(http.body) as unknown;
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        return { category: 'invalid_shape' };
      const record = body as Record<string, unknown>;
      return record.success === true ? { body: record } : { category: 'invalid_shape' };
    } catch {
      return { category: 'invalid_shape' };
    }
  }

  /** Lists the zones the token can see (bounded pages), optionally within the account. */
  private async listZones(): Promise<
    { category: string } | { zones: CloudflareZone[]; more: boolean }
  > {
    const zones: CloudflareZone[] = [];
    const pages = Math.ceil(CLOUDFLARE_MAX_ZONES / CLOUDFLARE_ZONE_PAGE_SIZE);
    for (let page = 1; page <= pages; page += 1) {
      const answer = await this.get('/zones', {
        page: String(page),
        per_page: String(CLOUDFLARE_ZONE_PAGE_SIZE),
        ...(this.state.accountId !== null ? { 'account.id': this.state.accountId } : {}),
      });
      if ('category' in answer) return answer;
      const result = answer.body.result;
      if (!Array.isArray(result)) return { category: 'invalid_shape' };
      for (const raw of result) {
        const zone = (raw ?? {}) as Record<string, unknown>;
        const id = typeof zone.id === 'string' ? zone.id : '';
        const name = typeof zone.name === 'string' ? zone.name.toLowerCase() : '';
        if (!CLOUDFLARE_ID_PATTERN.test(id) || !/^[a-z0-9.-]{1,253}$/.test(name))
          return { category: 'invalid_shape' };
        const plan = (zone.plan ?? {}) as Record<string, unknown>;
        zones.push({
          id,
          name,
          status: typeof zone.status === 'string' ? zone.status.slice(0, 32) : 'unknown',
          plan: typeof plan.name === 'string' ? plan.name.slice(0, 64) : null,
        });
      }
      const info = (answer.body.result_info ?? {}) as Record<string, unknown>;
      const totalPages = typeof info.total_pages === 'number' ? info.total_pages : page;
      if (page >= totalPages || result.length < CLOUDFLARE_ZONE_PAGE_SIZE)
        return { zones, more: false };
    }
    return { zones, more: true };
  }

  /** One probe: the account (if configured) and the zone listing. */
  private async probeOnce(): Promise<{
    category: string | null;
    detail: string;
    zones: CloudflareZone[];
    more: boolean;
  }> {
    let category: string | null = null;
    let detail = '';
    let zones: CloudflareZone[] = [];
    let more = false;
    try {
      if (this.state.accountId !== null) {
        const account = await this.get(`/accounts/${this.state.accountId}`);
        if ('category' in account)
          category =
            account.category === 'forbidden_scope' || account.category === 'not_found'
              ? 'account_not_visible'
              : account.category;
      }
      if (category === null) {
        const listed = await this.listZones();
        if ('category' in listed) category = listed.category;
        else {
          zones = listed.zones;
          more = listed.more;
        }
      }
      if (category === null && this.zoneNames !== null) {
        const byName = new Map(zones.map((zone) => [zone.name, zone]));
        const unknown = this.zoneNames.filter((name) => !byName.has(name));
        if (unknown.length > 0) {
          category = 'zone_not_visible';
          detail = `zone not visible to the token: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` (+${unknown.length - 5})` : ''}`;
        } else zones = this.zoneNames.map((name) => byName.get(name)!);
      }
      if (category === null && zones.length === 0) category = 'no_zones';
    } catch {
      category = 'network';
    }
    return { category, detail, zones, more };
  }

  /**
   * Probes the token, resolves the zone snapshot and recomputes the binding.
   * Transient failures are retried, and while the instance was ready they
   * keep the last good snapshot within the grace bounds.
   */
  async refresh(): Promise<CloudflareRuntimeProviderStatus> {
    if (!this.configured) return this.state;
    this.probing ??= (async () => {
      try {
        const outcome = await probeWithRetry(
          () => this.probeOnce(),
          (o) => o.category,
          this.retry,
        );
        const { category, detail, zones, more } = outcome;
        if (this.grace.hold(category, this.state.ready)) {
          this.state.detail = `${this.readyDetail}${this.grace.note()}`;
          this.checkedAtMs = this.now();
          this.state.checkedAt = new Date(this.checkedAtMs).toISOString();
          return this.state;
        }
        zones.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        this.state.ready = category === null;
        this.state.status = category ?? 'ready';
        this.state.zones = category === null ? zones : [];
        this.state.zoneSetHash = category === null ? cloudflareZoneSetHash(zones) : null;
        this.state.detail =
          category === null
            ? `read-only API access to ${zones.length} zone${zones.length === 1 ? '' : 's'}${more ? ` (the first ${CLOUDFLARE_MAX_ZONES} the token can see)` : ''}${this.state.accountId !== null ? ' and the configured account' : ''}`
            : `${detail || category} (see docs/cloudflare.md troubleshooting)`;
        if (category === null) this.readyDetail = this.state.detail;
        this.checkedAtMs = this.now();
        this.state.checkedAt = new Date(this.checkedAtMs).toISOString();
        return this.state;
      } finally {
        this.probing = null;
      }
    })();
    return this.probing;
  }

  /** Readiness is older than the bounded refresh interval (an expired token turns it not-ready). */
  isStale(): boolean {
    return (
      this.configured &&
      this.probing === null &&
      this.now() - this.checkedAtMs >= CLOUDFLARE_READINESS_REFRESH_MS
    );
  }

  /** One read with the request re-validated against this instance's snapshot. */
  async call(
    operation: CloudflareOperation,
    input: unknown,
    bounds: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<CloudflareCallResult> {
    if (!this.state.ready)
      return { status: 'not_run', output: 'Cloudflare is not ready', refused: 'not ready' };
    let validated;
    try {
      validated = validateCloudflareRequest(operation, input, this.scope());
    } catch (err) {
      const reason = err instanceof CloudflareRequestError ? err.message : 'invalid request';
      return { status: 'not_run', output: reason, refused: reason };
    }
    const http = await sendCloudflareRequest(
      buildCloudflareRequest(operation, validated),
      this.token,
      {
        timeoutMs: bounds.timeoutMs,
        signal: bounds.signal,
        fetchImpl: this.fetchImpl,
      },
    );
    const result =
      operation === 'graphql'
        ? normalizeCloudflareGraphql(http, bounds.maxOutputBytes)
        : normalizeCloudflareRest(http, bounds.maxOutputBytes);
    // A rejected credential turns readiness stale at once (next /readyz re-probes).
    if (result.errorCategory === 'invalid_auth') this.checkedAtMs = 0;
    return result;
  }
}
