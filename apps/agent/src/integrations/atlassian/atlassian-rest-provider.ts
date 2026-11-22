/**
 * Runtime-owned Atlassian provider for one admin-managed instance: scoped
 * read-only tokens, per-product readiness probes and the
 * site/cloud-ID/credential binding.
 * Tokens stay in this process; readiness exposes only categories and
 * fingerprints.
 */
import { createHash } from 'node:crypto';
import {
  ATLASSIAN_ADAPTER,
  ATLASSIAN_CONTRACT_VERSION,
  ATLASSIAN_READ_OPERATIONS,
  atlassianProduct,
  type AtlassianProduct,
  type ValidatedAtlassianArgs,
} from './atlassian-operations.js';
import {
  buildAtlassianRequest,
  buildReadinessRequest,
  CLOUD_ID_PATTERN,
  normalizeAtlassianResponse,
  sendAtlassianRequest,
  type AtlassianCredential,
  type AtlassianFetch,
  type AtlassianReadinessProbe,
  type AtlassianResult,
} from './atlassian-rest-adapter.js';
import type { AtlassianRuntimeProviderStatus } from '../tools/tool-runtime-readiness.js';
import {
  ReadinessGrace,
  probeWithRetry,
  type ReadinessRetryOptions,
} from '../tools/readiness-grace.js';

export const ATLASSIAN_PRODUCTS = ['jira', 'confluence'] as const;
/** Readiness is re-probed at most this often (on /readyz). */
export const ATLASSIAN_READINESS_REFRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 200_000;

export function normalizeAtlassianSite(site: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,61}\.atlassian\.net$/.test(site))
    throw new Error('the Atlassian site must be an exact Atlassian Cloud site hostname');
  return site;
}
/** Stable, non-reversible per-product credential identity (rotates sessions only on token change). */
export function credentialFingerprint(product: AtlassianProduct, token: string): string {
  return createHash('sha256')
    .update(`support-agent-atlassian-v1\0${product}\0${token}`)
    .digest('hex')
    .slice(0, 16);
}

/** One admin-managed Atlassian instance: site binding plus the scoped product tokens. */
export interface AtlassianInstanceConfig {
  site: string;
  cloudId: string;
  email: string;
  tokens: Partial<Record<AtlassianProduct, string>>;
}

export class AtlassianRestProvider {
  readonly state: AtlassianRuntimeProviderStatus;
  private readonly credentials: Partial<Record<AtlassianProduct, AtlassianCredential>> = {};
  private checkedAtMs = 0;
  private probing: Promise<AtlassianRuntimeProviderStatus> | null = null;
  /** Per product: a transient failure of a ready product keeps it ready. */
  readonly graces: Record<AtlassianProduct, ReadinessGrace>;

  constructor(
    config: AtlassianInstanceConfig,
    private readonly fetchImpl?: AtlassianFetch,
    private readonly now: () => number = Date.now,
    private readonly retry: ReadinessRetryOptions = {},
  ) {
    this.graces = {
      jira: new ReadinessGrace(now, retry),
      confluence: new ReadinessGrace(now, retry),
    };
    let site: string | null = null;
    try {
      site = normalizeAtlassianSite(config.site.trim());
    } catch {
      /* diagnosed below */
    }
    const cloudId = CLOUD_ID_PATTERN.test(config.cloudId.trim()) ? config.cloudId.trim() : null;
    const email = config.email.trim();
    this.state = {
      tool: 'atlassian',
      enabled: true,
      ready: false,
      status: 'missing_config',
      detail: '',
      site,
      cloudId,
      adapter: ATLASSIAN_ADAPTER,
      contractVersion: ATLASSIAN_CONTRACT_VERSION,
      operations: [],
      products: { jira: 'not_configured', confluence: 'not_configured' },
      credentialFingerprints: {},
      checkedAt: null,
    };
    const missing: string[] = [];
    if (!site) missing.push('site (bare *.atlassian.net hostname)');
    if (!cloudId) missing.push('cloud ID (site UUID)');
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) missing.push('email');
    for (const product of ATLASSIAN_PRODUCTS) {
      const token = (config.tokens[product] ?? '').trim();
      if (!token) continue;
      if (/[\s\0]/.test(token)) {
        missing.push(`${product} token (malformed)`);
        continue;
      }
      this.credentials[product] = { email, token };
      this.state.credentialFingerprints[product] = credentialFingerprint(product, token);
      this.state.products[product] = 'pending';
    }
    if (!Object.keys(this.credentials).length) missing.push('a Jira and/or Confluence token');
    if (missing.length) {
      this.state.detail = `the Atlassian instance is incomplete: ${missing.join('; ')}`;
      return;
    }
    this.state.status = 'error';
    this.state.detail = 'readiness has not been established yet';
  }

  /** Token material this runtime must redact: raw, base64 and base64 `email:token`. */
  secrets(): string[] {
    return Object.values(this.credentials).flatMap((credential) =>
      credential.token.length >= 4
        ? [
            credential.token,
            Buffer.from(credential.token).toString('base64'),
            Buffer.from(`${credential.email}:${credential.token}`).toString('base64'),
          ]
        : [],
    );
  }

  get configured(): boolean {
    return this.state.status !== 'missing_config';
  }

  private async probe(product: AtlassianProduct): Promise<string> {
    const site = this.state.site!;
    const cloudId = this.state.cloudId!;
    const get = async (
      probe: AtlassianReadinessProbe,
    ): Promise<{ category?: string; body?: Record<string, unknown> }> => {
      const http = await sendAtlassianRequest(
        buildReadinessRequest(probe, cloudId),
        this.credentials,
        { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: PROBE_MAX_BYTES, fetchImpl: this.fetchImpl },
      );
      if (http.errorCategory) return { category: http.errorCategory };
      try {
        const body = JSON.parse(http.body) as unknown;
        if (body === null || typeof body !== 'object' || Array.isArray(body))
          return { category: 'invalid_shape' };
        return { body: body as Record<string, unknown> };
      } catch {
        return { category: 'invalid_json' };
      }
    };
    if (product === 'jira') {
      const info = await get('jiraServerInfo');
      if (info.category) return info.category;
      if (String(info.body?.baseUrl ?? '').replace(/\/$/, '') !== `https://${site}`)
        return 'site_mismatch';
      const me = await get('jiraMyself');
      if (me.category) return me.category;
      return typeof me.body?.accountId === 'string' && me.body.accountId
        ? 'ready'
        : 'invalid_shape';
    }
    const spaces = await get('confluenceSpaces');
    if (spaces.category) return spaces.category;
    const links = spaces.body?._links as Record<string, unknown> | undefined;
    if (String(links?.base ?? '').replace(/\/$/, '') !== `https://${site}/wiki`)
      return 'site_mismatch';
    return Array.isArray(spaces.body?.results) ? 'ready' : 'invalid_shape';
  }

  /**
   * Probes every configured product and recomputes the ready operation set.
   * A transient failure is retried, and a product that was ready stays ready
   * through it within the grace bounds.
   */
  async refresh(): Promise<AtlassianRuntimeProviderStatus> {
    if (!this.configured) return this.state;
    this.probing ??= (async () => {
      try {
        for (const product of ATLASSIAN_PRODUCTS) {
          if (!this.credentials[product]) continue;
          const outcome = await probeWithRetry(
            () => this.probe(product).catch(() => 'error'),
            (o) => (o === 'ready' ? null : o),
            this.retry,
          );
          const wasReady = this.state.products[product] === 'ready';
          if (this.graces[product].hold(outcome === 'ready' ? null : outcome, wasReady)) continue;
          this.state.products[product] = outcome;
        }
        this.state.operations = ATLASSIAN_READ_OPERATIONS.filter(
          (op) => this.state.products[atlassianProduct(op)] === 'ready',
        ).sort();
        this.state.ready = this.state.operations.length > 0;
        const failed = ATLASSIAN_PRODUCTS.filter(
          (p) => this.credentials[p] && this.state.products[p] !== 'ready',
        );
        this.state.status = this.state.ready
          ? 'ready'
          : (this.state.products[failed[0] ?? 'jira'] ?? 'error');
        const held = ATLASSIAN_PRODUCTS.filter((p) => this.graces[p].held !== null);
        const heldNote = held.length
          ? `; the last probe failed transiently: ${held.map((p) => `${p}: ${this.graces[p].held}`).join('; ')}, the last good readiness is kept`
          : '';
        this.state.detail = failed.length
          ? `${failed.map((p) => `${p}: ${this.state.products[p]}`).join('; ')} (see docs/atlassian.md troubleshooting)${heldNote}`
          : `scoped read-only REST reads available${heldNote}`;
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
      this.now() - this.checkedAtMs >= ATLASSIAN_READINESS_REFRESH_MS
    );
  }

  async read(
    args: ValidatedAtlassianArgs,
    timeoutMs: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<AtlassianResult> {
    const http = await sendAtlassianRequest(
      buildAtlassianRequest(args, this.state.cloudId!),
      this.credentials,
      { timeoutMs, maxBytes: maxOutputBytes, signal, fetchImpl: this.fetchImpl },
    );
    return normalizeAtlassianResponse(args, http, this.state.site!, maxOutputBytes);
  }
}
