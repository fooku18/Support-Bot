/**
 * Runtime-owned Datadog provider for one admin-managed instance: a read-only
 * Personal or Service Access Token (scope `mcp_read`), the readiness probe
 * (`initialize` + paginated `tools/list`), the pinned read catalog and the
 * site/endpoint/catalog/credential binding. The token stays in this process;
 * readiness exposes only categories, names, hashes and a fingerprint.
 */
import { createHash } from 'node:crypto';
import {
  DATADOG_ADAPTER,
  DATADOG_CONTRACT_VERSION,
  DatadogMcpSession,
  classifyDatadogError,
  datadogCatalogHash,
  datadogEndpoint,
  normalizeDatadogSite,
  normalizeDatadogToolsets,
  partitionDatadogCatalog,
  type DatadogCallResult,
  type DatadogCatalog,
  type DatadogFetch,
} from './datadog-mcp-adapter.js';
import { DatadogArgumentError, validateDatadogArguments } from './datadog-schema.js';
import type { DatadogRuntimeProviderStatus } from '../tools/tool-runtime-readiness.js';
import {
  ReadinessGrace,
  probeWithRetry,
  type ReadinessRetryOptions,
} from '../tools/readiness-grace.js';

/** Readiness is re-probed at most this often (on /readyz). */
export const DATADOG_READINESS_REFRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;

/** Stable, non-reversible token identity (changes only when the token is rotated). */
export function datadogCredentialFingerprint(token: string): string {
  return createHash('sha256')
    .update(`support-agent-datadog-v1\0${token}`)
    .digest('hex')
    .slice(0, 16);
}

/** One admin-managed Datadog instance: site, toolsets and the read-only access token. */
export interface DatadogInstanceConfig {
  site: string;
  toolsets: string;
  token: string;
}

export class DatadogMcpProvider {
  readonly state: DatadogRuntimeProviderStatus;
  private catalog: DatadogCatalog = { tools: [], excludedTools: [] };
  private readonly session: DatadogMcpSession | null = null;
  private readonly token: string;
  private checkedAtMs = 0;
  private probing: Promise<DatadogRuntimeProviderStatus> | null = null;
  readonly grace: ReadinessGrace;
  private readyDetail = '';

  constructor(
    config: DatadogInstanceConfig,
    fetchImpl?: DatadogFetch,
    private readonly now: () => number = Date.now,
    private readonly retry: ReadinessRetryOptions = {},
  ) {
    this.grace = new ReadinessGrace(now, retry);
    let site: string | null = null;
    let siteProblem = 'site (bare site such as datadoghq.eu)';
    try {
      site = normalizeDatadogSite(config.site.trim());
    } catch (err) {
      if (err instanceof Error && /gov/.test(err.message))
        siteProblem = 'site (gov sites are not supported)';
    }
    let toolsets: string | null = null;
    try {
      toolsets = normalizeDatadogToolsets(config.toolsets.trim() || 'all');
    } catch {
      /* diagnosed below */
    }
    const token = config.token.trim();
    this.token = token;
    this.state = {
      tool: 'datadog',
      enabled: true,
      ready: false,
      status: 'missing_config',
      detail: '',
      site,
      endpoint: site ? datadogEndpoint(site) : null,
      adapter: DATADOG_ADAPTER,
      contractVersion: DATADOG_CONTRACT_VERSION,
      protocolVersion: null,
      serverName: null,
      serverVersion: null,
      toolsets,
      toolCatalogHash: null,
      tools: [],
      excludedTools: [],
      credentialFingerprint: null,
      checkedAt: null,
    };
    const missing: string[] = [];
    if (!site) missing.push(siteProblem);
    if (!toolsets) missing.push('toolsets ("all" or a comma list of toolsets)');
    if (!token) missing.push('access token (PAT or SAT with scope mcp_read)');
    else if (/[\s\0]/.test(token) || token.length < 8) missing.push('access token (malformed)');
    if (missing.length) {
      this.state.detail = `the Datadog instance is incomplete: ${missing.join('; ')}`;
      return;
    }
    this.state.credentialFingerprint = datadogCredentialFingerprint(token);
    this.session = new DatadogMcpSession({ site: site!, toolsets: toolsets!, token, fetchImpl });
    this.state.status = 'error';
    this.state.detail = 'readiness has not been established yet';
  }

  /** Values this runtime must redact. */
  secrets(): string[] {
    return this.token.length >= 4 ? [this.token] : [];
  }

  get configured(): boolean {
    return this.session !== null;
  }

  /** The pinned read catalog (schemas included) for the runner's registration. */
  snapshotCatalog(): DatadogCatalog & { toolCatalogHash: string | null } {
    return { ...structuredClone(this.catalog), toolCatalogHash: this.state.toolCatalogHash };
  }

  /** `initialize` + paginated `tools/list`; recomputes the catalog and its hash. */
  async refresh(): Promise<DatadogRuntimeProviderStatus> {
    if (!this.configured) return this.state;
    this.probing ??= (async () => {
      try {
        // initialize + tools/list, retried on a transient failure.
        const { category: probed, raw } = await probeWithRetry(
          async (): Promise<{ category: string | null; raw: unknown[] }> => {
            try {
              return { category: null, raw: await this.session!.listTools(PROBE_TIMEOUT_MS) };
            } catch (err) {
              return { category: classifyDatadogError(err), raw: [] };
            }
          },
          (o) => o.category,
          this.retry,
        );
        let category = probed;
        if (this.grace.hold(category, this.state.ready)) {
          this.state.detail = `${this.readyDetail}${this.grace.note()}`;
          this.checkedAtMs = this.now();
          this.state.checkedAt = new Date(this.checkedAtMs).toISOString();
          return this.state;
        }
        this.state.protocolVersion = this.session!.info.protocolVersion;
        this.state.serverName = this.session!.info.serverName;
        this.state.serverVersion = this.session!.info.serverVersion;
        if (category === null) {
          const catalog = partitionDatadogCatalog(raw);
          if (catalog.tools.length === 0) category = 'empty_catalog';
          else {
            this.catalog = catalog;
            this.state.toolCatalogHash = datadogCatalogHash(catalog);
            this.state.tools = catalog.tools.map((tool) => tool.name);
            this.state.excludedTools = catalog.excludedTools;
          }
        }
        this.state.ready = category === null;
        this.state.status = category ?? 'ready';
        if (category !== null) {
          this.catalog = { tools: [], excludedTools: [] };
          this.state.tools = [];
          this.state.excludedTools = [];
          this.state.toolCatalogHash = null;
        }
        this.state.detail =
          category === null
            ? `read-only MCP tools available (${this.state.tools.length} tools, ${this.state.excludedTools.length} excluded)`
            : `${category} (see docs/datadog.md troubleshooting)`;
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
      this.now() - this.checkedAtMs >= DATADOG_READINESS_REFRESH_MS
    );
  }

  /** One read call of a pinned catalog tool with arguments re-validated here. */
  async call(
    name: string,
    args: unknown,
    bounds: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<DatadogCallResult> {
    const tool = this.catalog.tools.find((entry) => entry.name === name);
    if (!this.state.ready || !this.session || !tool)
      return { status: 'not_run', output: 'tool not in the pinned catalog', refused: 'catalog' };
    let validated: Record<string, unknown>;
    try {
      validated = validateDatadogArguments(tool.inputSchema, args);
    } catch (err) {
      const reason = err instanceof DatadogArgumentError ? err.message : 'invalid arguments';
      return { status: 'not_run', output: reason, refused: reason };
    }
    const result = await this.session.callTool(name, validated, bounds);
    // A rejected credential turns readiness stale at once (next /readyz re-probes).
    if (result.errorCategory === 'invalid_auth') this.checkedAtMs = 0;
    return result;
  }
}
