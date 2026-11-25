import { MODEL_SETTING_NAMES } from './generated/model-catalog.js';
/**
 * Isolated credential-owning runtime for the admin-managed tool instances of
 * kind GitLab (typed REST requests), Atlassian (scoped read-only REST),
 * Datadog (read-only remote MCP), Cloudflare (read-only REST and GraphQL
 * Analytics API) and Slack (read-only user lookups and public-channel message
 * search with the workspace's bot token).
 *
 * Instances come from the admin service (`GET /internal/tool-instances`,
 * polled, D7); each instance's credential is fetched when its credential
 * version changes and held in memory only. Every request from the runner
 * names an `instanceId` and the run's `teamId`; the runtime binds host, site
 * and credential itself and refuses unknown, foreign, unready or blocked
 * instances. An instance whose host is not in the static egress allowlist
 * (GITLAB_HOSTS, ATLASSIAN_SITES, DATADOG_SITES, CLOUDFLARE_HOSTS, D8) is
 * reported `blocked` and never probed; a Slack instance's only legal host
 * is the fixed `slack.com`. Readiness outcomes go back to the admin service.
 *
 * Egress: the runtime sits on internal networks only. Its provider calls
 * (fetch) tunnel through the instance's egress proxy (EGRESS_PROXY_URL),
 * which admits the same host lists for the tools network.
 */

import {
  configureOutbound,
  egressProxyUrlFromEnv,
} from '../../agent/src/infrastructure/outbound.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  GITLAB_CONTRACT_VERSION,
  isGitlabTransportOperationName,
  validateTransportGitlabArgs,
  type ValidatedGitlabArgs,
} from '../../agent/src/integrations/gitlab/gitlab-operations.js';
import {
  buildGitlabRequest,
  decodeRepositoryFileOutput,
  sendGitlabRequest,
  type GitlabFetch,
  type GitlabHttpResult,
} from '../../agent/src/integrations/gitlab/gitlab-rest-adapter.js';
import {
  ATLASSIAN_CONTRACT_VERSION,
  ATLASSIAN_ADAPTER,
  atlassianProduct,
  validateTransportAtlassianArgs,
} from '../../agent/src/integrations/atlassian/atlassian-operations.js';
import { AtlassianRestProvider } from '../../agent/src/integrations/atlassian/atlassian-rest-provider.js';
import type { ReadinessRetryOptions } from '../../agent/src/integrations/tools/readiness-grace.js';
import type {
  AtlassianFetch,
  AtlassianResult,
} from '../../agent/src/integrations/atlassian/atlassian-rest-adapter.js';
import type {
  AtlassianRuntimeProviderStatus,
  CloudflareRuntimeProviderStatus,
  DatadogRuntimeProviderStatus,
  SlackRuntimeProviderStatus,
} from '../../agent/src/integrations/tools/tool-runtime-readiness.js';
import { SlackApiProvider } from '../../agent/src/integrations/slack/slack-api-provider.js';
import {
  SLACK_ADAPTER,
  SLACK_CONTRACT_VERSION,
  SLACK_ENDPOINT,
  type SlackCallResult,
  type SlackFetch,
} from '../../agent/src/integrations/slack/slack-api-adapter.js';
import { CloudflareApiProvider } from '../../agent/src/integrations/cloudflare/cloudflare-api-provider.js';
import {
  CLOUDFLARE_ADAPTER,
  CLOUDFLARE_CONTRACT_VERSION,
  CLOUDFLARE_ENDPOINT,
  type CloudflareCallResult,
  type CloudflareFetch,
} from '../../agent/src/integrations/cloudflare/cloudflare-api-adapter.js';
import { DatadogMcpProvider } from '../../agent/src/integrations/datadog/datadog-mcp-provider.js';
import {
  DATADOG_ADAPTER,
  DATADOG_CONTRACT_VERSION,
  type DatadogCallResult,
  type DatadogFetch,
} from '../../agent/src/integrations/datadog/datadog-mcp-adapter.js';
import {
  hostAllowlist,
  probeIntervalMs,
  ToolInstanceSync,
  type SyncedToolInstance,
  type ToolInstanceStatusReport,
} from '../../agent/src/integrations/tools/tool-instances.js';
import {
  SLACK_API_HOST,
  parseAtlassianCredential,
  type ToolKind,
} from '../../agent/src/contracts/tool-kinds.js';

/**
 * Sanitized GitLab readiness categories (no raw auth output, no
 * credentials): ready = bounded authenticated read succeeded; invalid_auth /
 * forbidden / unreachable = probe classifications.
 */
export type ProviderStatus =
  | 'ready'
  | 'pending'
  | 'invalid_auth'
  | 'forbidden'
  | 'unreachable'
  | 'error';

/** GitLab readiness of one instance (sanitized; never the credential). */
export interface ProviderState {
  tool: 'gitlab';
  ready: boolean;
  status: ProviderStatus;
  /** Actionable, sanitized diagnostic (no secret values, no raw auth output). */
  detail: string;
  host: string;
  contractVersion: number;
}

/**
 * Controller, Slack and model provider credentials must never reach the CLI runtime's
 * environment. (A Slack tool instance's bot token is read per instance from
 * the admin service and held in memory only.)
 */
const FORBIDDEN_CLI_RUNTIME_ENV = [
  'SERVICE_TOKEN',
  'SUPPORT_AGENT_SERVICE_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  ...MODEL_SETTING_NAMES,
  'NATIVE_WEB_FETCH_API_KEY',
  'NATIVE_WEB_FETCH_API_KEY_FILE',
  'OPENAI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'EXECUTOR_TOKEN',
  'CLI_RUNTIME_TOKEN_SENDER',
];

/** Tool configuration that moved into admin-managed tool instances (D14). */
const REMOVED_TOOL_ENV = [
  'GITLAB_HOST',
  'GITLAB_TOKEN',
  'ATLASSIAN_ENABLED',
  'ATLASSIAN_SITE',
  'ATLASSIAN_CLOUD_ID',
  'ATLASSIAN_EMAIL',
  'ATLASSIAN_JIRA_API_TOKEN',
  'ATLASSIAN_CONFLUENCE_API_TOKEN',
  'ATLASSIAN_API_TOKEN',
  'DATADOG_ENABLED',
  'DATADOG_SITE',
  'DATADOG_ACCESS_TOKEN',
  'DATADOG_TOOLSETS',
];

function cliRuntimeToken(): string {
  return (process.env.CLI_RUNTIME_TOKEN ?? '').trim();
}

/** Initial (pre-probe) GitLab state of one instance. */
export function initialGitlabState(host: string): ProviderState {
  return {
    tool: 'gitlab',
    ready: false,
    status: 'pending',
    detail: 'readiness has not been established yet',
    host,
    contractVersion: GITLAB_CONTRACT_VERSION,
  };
}

export function assertCliRuntimeEnvClean(env: NodeJS.ProcessEnv = process.env): void {
  const present = FORBIDDEN_CLI_RUNTIME_ENV.filter((name) => (env[name] ?? '').length > 0);
  if (present.length > 0) {
    throw new Error(`CLI runtime must not receive controller credentials (${present.join(',')})`);
  }
  if ((env.CLI_RUNTIME_TOKEN ?? '').trim().length === 0) {
    throw new Error('CLI_RUNTIME_TOKEN is required');
  }
  const removed = [
    ...REMOVED_TOOL_ENV,
    'CLI_ACLI_ENABLED',
    'MCP_ATLASSIAN_ENABLED',
    'ATLASSIAN_MCP_API_KEY',
    'TOOL_ACLI_BIN',
    'CLI_RUNTIME_AUTH_DIR',
  ].filter((name) => env[name] !== undefined);
  if (removed.length)
    throw new Error(
      `obsolete tool variables (tools are admin-managed instances now): ${removed.join(', ')}`,
    );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('request body exceeds the bounded size');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Result of one typed GitLab request (redacted; a repository file decoded first). */
export interface GitlabRuntimeResponse extends Omit<GitlabHttpResult, 'status'> {
  status: GitlabHttpResult['status'] | 'not_run';
  refused?: string;
}

// --- Instance registry --------------------------------------------------------------

/** Readiness of one instance as the runner sees it on /readyz (sanitized). */
export interface RuntimeInstanceStatus {
  instanceId: string;
  teamId: string;
  kind: ToolKind;
  label: string;
  credentialVersion: number;
  state: 'ready' | 'pending' | 'error' | 'blocked';
  detail: string;
  gitlab?: ProviderState;
  atlassian?: AtlassianRuntimeProviderStatus;
  datadog?: DatadogRuntimeProviderStatus;
  cloudflare?: CloudflareRuntimeProviderStatus;
  slack?: SlackRuntimeProviderStatus;
}

/** One served instance: its settings plus the kind's provider (credential in memory only). */
export interface CliInstanceEntry {
  instance: SyncedToolInstance;
  /** Set when the instance cannot be used before any probe (host not admitted, no credential). */
  unusable: {
    state: 'blocked' | 'error';
    detail: string;
    /** A transient failure (the credential could not be read): retried. */
    retry?: boolean;
  } | null;
  gitlab?: { credential: string; state: ProviderState; fetchImpl?: GitlabFetch };
  atlassian?: AtlassianRestProvider;
  datadog?: DatadogMcpProvider;
  cloudflare?: CloudflareApiProvider;
  slack?: SlackApiProvider;
}

/** Kinds this runtime serves. */
export type CliRuntimeKind = 'gitlab' | 'atlassian' | 'datadog' | 'cloudflare' | 'slack';
const CLI_RUNTIME_KINDS: readonly CliRuntimeKind[] = [
  'gitlab',
  'atlassian',
  'datadog',
  'cloudflare',
  'slack',
];

/** Kinds whose hosts the operator admits through an egress allowlist (Slack's host is fixed). */
export type AdmittedKind = Exclude<CliRuntimeKind, 'slack'>;
export type AdmittedHosts = Record<AdmittedKind, ReadonlySet<string>>;

const ADMITTED_ENV: Record<AdmittedKind, string> = {
  gitlab: 'GITLAB_HOSTS',
  atlassian: 'ATLASSIAN_SITES',
  datadog: 'DATADOG_SITES',
  cloudflare: 'CLOUDFLARE_HOSTS',
};

export function admittedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): AdmittedHosts {
  return {
    gitlab: hostAllowlist(env.GITLAB_HOSTS),
    atlassian: hostAllowlist(env.ATLASSIAN_SITES),
    datadog: hostAllowlist(env.DATADOG_SITES),
    cloudflare: hostAllowlist(env.CLOUDFLARE_HOSTS),
  };
}

export interface CliInstanceRegistryDeps {
  admitted: AdmittedHosts;
  /** Reads an instance's credential (the admin service in production). */
  secret?(instanceId: string): Promise<{ credential: string; credentialVersion: number }>;
  /** Receives readiness outcomes (the admin service in production). */
  report?(statuses: ToolInstanceStatusReport[]): Promise<void>;
  gitlabFetch?: GitlabFetch;
  atlassianFetch?: AtlassianFetch;
  datadogFetch?: DatadogFetch;
  /** Retry and grace bounds of the Atlassian/Datadog/Cloudflare/Slack probes (tests shorten them). */
  readinessRetry?: ReadinessRetryOptions;
  cloudflareFetch?: CloudflareFetch;
  slackFetch?: SlackFetch;
  /** GitLab readiness probe (injected in tests). */
  probeGitlab?(host: string, credential: string): Promise<ProbeResult>;
  log?(line: string): void;
}

/** The instances this runtime serves, keyed by instance ID. */
export class CliInstanceRegistry {
  private readonly entries = new Map<string, CliInstanceEntry>();
  private applying: Promise<void> = Promise.resolve();
  private listing: ReadonlyMap<string, SyncedToolInstance> = new Map();

  constructor(private readonly deps: CliInstanceRegistryDeps) {}

  get(instanceId: string): CliInstanceEntry | undefined {
    return this.entries.get(instanceId);
  }

  /** Installs a prepared entry (tests and qualification). */
  install(entry: CliInstanceEntry): void {
    this.entries.set(entry.instance.id, entry);
  }

  /** Reconciles with a new listing; serialized so concurrent listings apply in order. */
  apply(instances: ReadonlyMap<string, SyncedToolInstance>): Promise<void> {
    this.listing = instances;
    this.applying = this.applying.then(
      () => this.reconcile(instances),
      () => this.reconcile(instances),
    );
    return this.applying;
  }

  private async reconcile(instances: ReadonlyMap<string, SyncedToolInstance>): Promise<void> {
    for (const id of [...this.entries.keys()]) if (!instances.has(id)) this.entries.delete(id);
    for (const instance of instances.values()) {
      if (!(CLI_RUNTIME_KINDS as readonly string[]).includes(instance.kind)) continue;
      const existing = this.entries.get(instance.id);
      if (
        existing !== undefined &&
        existing.unusable?.retry !== true &&
        sameInstance(existing.instance, instance)
      )
        continue;
      const entry = await this.prepare(instance);
      this.entries.set(instance.id, entry);
      if (entry.unusable !== null) await this.report([entry]);
      else void this.probe(instance.id);
    }
  }

  private async prepare(instance: SyncedToolInstance): Promise<CliInstanceEntry> {
    const kind = instance.kind as CliRuntimeKind;
    const host = instance.host ?? '';
    if (kind === 'slack' && host !== SLACK_API_HOST)
      return {
        instance,
        unusable: {
          state: 'blocked',
          detail: `host not admitted: ${host} is not ${SLACK_API_HOST}`,
        },
      };
    // The allowlists name host names; a GitLab host may carry a port.
    if (kind !== 'slack' && !this.deps.admitted[kind].has(host.split(':')[0] ?? ''))
      return {
        instance,
        unusable: {
          state: 'blocked',
          detail: `host not admitted: ${host} is not in ${ADMITTED_ENV[kind]} (operator egress allowlist)`,
        },
      };
    if (!instance.hasCredential || this.deps.secret === undefined)
      return { instance, unusable: { state: 'error', detail: 'no credential' } };
    let secret: { credential: string; credentialVersion: number };
    try {
      secret = await this.deps.secret(instance.id);
    } catch (err) {
      return {
        instance,
        unusable: {
          state: 'error',
          detail: `credential unavailable: ${err instanceof Error ? err.message.slice(0, 120) : 'error'}`,
          retry: true,
        },
      };
    }
    const bound = { ...instance, credentialVersion: secret.credentialVersion };
    if (kind === 'gitlab')
      return {
        instance: bound,
        unusable: null,
        gitlab: {
          credential: secret.credential,
          state: initialGitlabState(host),
          fetchImpl: this.deps.gitlabFetch,
        },
      };
    if (kind === 'atlassian') {
      const settings = instance.settings as { cloudId: string; email: string };
      let tokens;
      try {
        tokens = parseAtlassianCredential(secret.credential);
      } catch {
        return { instance: bound, unusable: { state: 'error', detail: 'credential is malformed' } };
      }
      return {
        instance: bound,
        unusable: null,
        atlassian: new AtlassianRestProvider(
          { site: host, cloudId: settings.cloudId, email: settings.email, tokens },
          this.deps.atlassianFetch,
          undefined,
          this.deps.readinessRetry,
        ),
      };
    }
    if (kind === 'slack') {
      return {
        instance: bound,
        unusable: null,
        slack: new SlackApiProvider(
          { teamId: instance.teamId, token: secret.credential },
          this.deps.slackFetch,
          undefined,
          this.deps.readinessRetry,
        ),
      };
    }
    if (kind === 'cloudflare') {
      const settings = instance.settings as { accountId: string | null; zones: string[] | null };
      return {
        instance: bound,
        unusable: null,
        cloudflare: new CloudflareApiProvider(
          { accountId: settings.accountId, zones: settings.zones, token: secret.credential },
          this.deps.cloudflareFetch,
          undefined,
          this.deps.readinessRetry,
        ),
      };
    }
    const settings = instance.settings as { toolsets: string };
    return {
      instance: bound,
      unusable: null,
      datadog: new DatadogMcpProvider(
        { site: host, toolsets: settings.toolsets, token: secret.credential },
        this.deps.datadogFetch,
        undefined,
        this.deps.readinessRetry,
      ),
    };
  }

  /** Probes one instance and reports the outcome. */
  async probe(instanceId: string): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (entry === undefined || entry.unusable !== null) return;
    try {
      if (entry.gitlab !== undefined) {
        const { state, credential, fetchImpl } = entry.gitlab;
        const probe =
          this.deps.probeGitlab ??
          ((host: string, token: string) => probeGitlab(host, token, fetchImpl));
        let last: ProbeResult = { ok: false, status: 'error', detail: 'probe did not run' };
        for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
          last = await probe(state.host, credential);
          if (last.ok) break;
          if (attempt < PROBE_ATTEMPTS)
            await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_MS));
        }
        state.ready = last.ok;
        state.status = last.status;
        state.detail = last.detail;
      }
      await entry.atlassian?.refresh();
      await entry.datadog?.refresh();
      await entry.cloudflare?.refresh();
      await entry.slack?.refresh();
      const held = [
        ...(entry.atlassian === undefined
          ? []
          : Object.entries(entry.atlassian.graces).map(([product, grace]) =>
              grace.held === null ? null : `${product} ${grace.held}`,
            )),
        entry.datadog?.grace.held ?? null,
        entry.cloudflare?.grace.held ?? null,
        entry.slack?.grace.held ?? null,
      ].filter((note): note is string => note !== null);
      if (held.length > 0)
        this.deps.log?.(
          `tool instance ${instanceId} probe failed transiently, keeping the last good readiness: ${held.join('; ')}`,
        );
    } catch (err) {
      this.deps.log?.(
        `tool instance ${instanceId} probe failed: ${err instanceof Error ? err.name : 'error'}`,
      );
    }
    // A newer listing may have replaced the entry while probing.
    if (this.entries.get(instanceId) === entry) await this.report([entry]);
  }

  /**
   * Re-prepares instances whose credential could not be read (an admin
   * outage or timeout): the unchanged listing would never retry them.
   */
  retryTransient(): Promise<void> {
    if (![...this.entries.values()].some((entry) => entry.unusable?.retry === true))
      return this.applying;
    return this.apply(this.listing);
  }

  async probeAll(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.probe(id);
  }

  /** Bounded re-probe of stale Atlassian/Datadog/Cloudflare/Slack readiness (on /readyz). */
  refreshIfStale(): void {
    for (const entry of this.entries.values()) {
      if (entry.unusable !== null) continue;
      if (
        entry.atlassian?.isStale() ||
        entry.datadog?.isStale() ||
        entry.cloudflare?.isStale() ||
        entry.slack?.isStale()
      )
        void this.probe(entry.instance.id);
    }
  }

  statuses(): RuntimeInstanceStatus[] {
    return [...this.entries.values()].map(statusOf);
  }

  /** Every credential this runtime holds, for output redaction. */
  secrets(): string[] {
    return [...this.entries.values()].flatMap((entry) => [
      ...(entry.gitlab !== undefined && entry.gitlab.credential.length >= 4
        ? [entry.gitlab.credential]
        : []),
      ...(entry.atlassian?.secrets() ?? []),
      ...(entry.datadog?.secrets() ?? []),
      ...(entry.cloudflare?.secrets() ?? []),
      ...(entry.slack?.secrets() ?? []),
    ]);
  }

  private async report(entries: CliInstanceEntry[]): Promise<void> {
    if (this.deps.report === undefined) return;
    await this.deps.report(
      entries
        .map(statusOf)
        .filter((status) => status.state !== 'pending')
        .map((status) => ({
          instanceId: status.instanceId,
          state:
            status.state === 'ready' ? 'ready' : status.state === 'blocked' ? 'blocked' : 'error',
          detail: status.detail,
          credentialVersion: status.credentialVersion,
          toolsCount: status.datadog?.ready === true ? status.datadog.tools.length : null,
        })),
    );
  }
}

function sameInstance(a: SyncedToolInstance, b: SyncedToolInstance): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function statusOf(entry: CliInstanceEntry): RuntimeInstanceStatus {
  const base = {
    instanceId: entry.instance.id,
    teamId: entry.instance.teamId,
    kind: entry.instance.kind,
    label: entry.instance.label,
    credentialVersion: entry.instance.credentialVersion,
  };
  if (entry.unusable !== null)
    return { ...base, state: entry.unusable.state, detail: entry.unusable.detail };
  const provider =
    entry.gitlab !== undefined
      ? {
          ready: entry.gitlab.state.ready,
          status: entry.gitlab.state.status,
          detail: entry.gitlab.state.detail,
        }
      : (entry.atlassian?.state ??
        entry.datadog?.state ??
        entry.cloudflare?.state ??
        entry.slack?.state);
  const state: RuntimeInstanceStatus['state'] =
    provider === undefined
      ? 'error'
      : provider.ready
        ? 'ready'
        : provider.status === 'pending' || /not been established/.test(provider.detail)
          ? 'pending'
          : 'error';
  return {
    ...base,
    state,
    detail: provider?.detail ?? 'no provider',
    ...(entry.gitlab !== undefined ? { gitlab: { ...entry.gitlab.state } } : {}),
    ...(entry.atlassian !== undefined ? { atlassian: structuredClone(entry.atlassian.state) } : {}),
    ...(entry.datadog !== undefined ? { datadog: structuredClone(entry.datadog.state) } : {}),
    ...(entry.cloudflare !== undefined
      ? { cloudflare: structuredClone(entry.cloudflare.state) }
      : {}),
    ...(entry.slack !== undefined ? { slack: structuredClone(entry.slack.state) } : {}),
  };
}

let registry: CliInstanceRegistry | null = null;

/** Test/qualification hook: installs an explicit registry. */
export function setInstanceRegistry(next: CliInstanceRegistry | null): void {
  registry = next;
}

function currentRegistry(): CliInstanceRegistry {
  registry ??= new CliInstanceRegistry({ admitted: admittedHostsFromEnv() });
  return registry;
}

/**
 * Looks up the instance a runner request names. The runtime, not the
 * request, binds host and credential; the run's workspace must own the
 * instance (no cross-workspace use).
 */
function resolveInstance(
  parsed: Record<string, unknown>,
  kind: CliRuntimeKind,
): { entry: CliInstanceEntry } | { refused: string } {
  const instanceId = typeof parsed.instanceId === 'string' ? parsed.instanceId : '';
  const teamId = typeof parsed.teamId === 'string' ? parsed.teamId : '';
  const entry = currentRegistry().get(instanceId);
  if (entry === undefined || entry.instance.kind !== kind)
    return { refused: `unknown ${kind} tool instance` };
  if (entry.instance.teamId !== teamId)
    return { refused: `tool instance ${instanceId} belongs to another workspace` };
  if (entry.unusable !== null)
    return {
      refused: `tool instance ${instanceId} is ${entry.unusable.state}: ${entry.unusable.detail}`,
    };
  return { entry };
}

// --- Credential redaction (credential-owning runtime) ---------------------------------

/** Redacts every held credential and generic token-shaped material. Exported for MCP paths. */
export function redactRuntimeOutput(text: string, requestSecrets: readonly string[] = []): string {
  let out = text;
  // Longest first: base64(`email:token`) must go before base64(token).
  for (const secret of [
    ...currentRegistry().secrets(),
    ...requestSecrets.filter((value) => value.length >= 4),
  ].sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(secret, '[redacted]');
  }
  return out
    .replace(/glpat-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/(?:Basic|Bearer)\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/xox[bap]-[A-Za-z0-9-]+/g, '[redacted]')
    .replace(/ATP[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/dd(?:pat|sat)_[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

/**
 * Job-trace redaction: the runtime's redaction plus credential shapes a CI
 * job prints itself (HTTP auth headers, token query values, URL
 * credentials). A safety net, not a guarantee; GitLab masks masked
 * variables as [MASKED] before this.
 */
export function redactTraceOutput(text: string): string {
  return redactRuntimeOutput(text)
    .replace(/\b((?:proxy-)?authorization\s*:\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(/\b((?:private|job|deploy)-token\s*:\s*)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b((?:access_|private_|auth_|refresh_|job_)?token=)[^&\s"'#]+/gi, '$1[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi, '$1[redacted]@');
}

// --- Deterministic authentication (background probes, never a model tool call) -------

export interface ProbeResult {
  ok: boolean;
  status: ProviderStatus;
  detail: string;
}

/** Bounded readiness probe: the authenticated `GET /user` read. Details are fixed sentences. */
export async function probeGitlab(
  host: string,
  credential: string,
  fetchImpl?: GitlabFetch,
): Promise<ProbeResult> {
  const failed = (status: ProviderStatus, detail: string): ProbeResult => ({
    ok: false,
    status,
    detail,
  });
  let result: GitlabHttpResult;
  try {
    result = await sendGitlabRequest(
      buildGitlabRequest(validateTransportGitlabArgs('get_current_user', {})),
      host,
      credential,
      { timeoutMs: 30_000, maxOutputBytes: 100_000, fetchImpl },
    );
  } catch {
    return failed('error', 'the instance host is not usable');
  }
  if (result.httpStatus === 401)
    return failed('invalid_auth', 'GitLab rejected the token (wrong, expired or revoked)');
  if (result.httpStatus === 403)
    return failed('forbidden', 'GitLab refused the token (blocked user or missing API scope)');
  if (result.status === 'timed_out') return failed('unreachable', 'GitLab did not answer in time');
  if (result.httpStatus === null) return failed('unreachable', 'GitLab could not be reached');
  if (result.status !== 'completed')
    return failed('error', `GitLab answered the user read with HTTP ${result.httpStatus}`);
  try {
    const user = JSON.parse(result.output) as { id?: unknown } | null;
    if (typeof user?.id === 'number')
      return { ok: true, status: 'ready', detail: 'authenticated against the instance host' };
  } catch {
    // Reported below: not a GitLab API answer (e.g. a sign-in page).
  }
  return failed('error', 'GitLab answered the user read with an unexpected response');
}

/** Retry interval for an instance whose credential could not be read. */
export const TRANSIENT_RETRY_MS = 30_000;

export const PROBE_ATTEMPTS = 3;
export const PROBE_RETRY_MS = 3_000;

// --- Typed GitLab requests ---------------------------------------------------------

const TRANSPORT_KEYS = [
  'instanceId',
  'teamId',
  'credentialVersion',
  'operation',
  'operationArgs',
  'timeoutMs',
  'maxOutputBytes',
];

/**
 * Runs one typed GitLab request against the named instance. The runtime
 * builds the fixed REST request from the re-validated operation; host and
 * credential come from the instance, never the request.
 */
export async function handleGitlab(
  body: unknown,
  signal?: AbortSignal,
): Promise<GitlabRuntimeResponse> {
  const refuse = (refused: string): GitlabRuntimeResponse => ({
    status: 'not_run',
    httpStatus: null,
    output: refused,
    truncated: false,
    refused,
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid request');
  const parsed = body as Record<string, unknown>;
  if (Object.keys(parsed).some((key) => !TRANSPORT_KEYS.includes(key)))
    return refuse('unknown transport field');
  const resolved = resolveInstance(parsed, 'gitlab');
  if ('refused' in resolved) return refuse(resolved.refused);
  if (
    parsed.credentialVersion !== undefined &&
    (!Number.isSafeInteger(parsed.credentialVersion) ||
      parsed.credentialVersion !== resolved.entry.instance.credentialVersion)
  )
    return refuse('GitLab credential binding changed');
  const gitlab = resolved.entry.gitlab!;
  const state = gitlab.state;
  if (!state.ready) {
    return refuse(`GitLab instance is not ready (status ${state.status}): ${state.detail}`);
  }
  const opName = typeof parsed.operation === 'string' ? parsed.operation : '';
  if (!isGitlabTransportOperationName(opName)) {
    return refuse(`unknown GitLab operation "${opName.slice(0, 64)}"`);
  }
  let validated: ValidatedGitlabArgs;
  try {
    validated = validateTransportGitlabArgs(opName, parsed.operationArgs);
  } catch (err) {
    return refuse(
      err instanceof Error ? err.message.slice(0, 200) : 'invalid GitLab operation arguments',
    );
  }
  const maxOutputBytes = Math.min(
    typeof parsed.maxOutputBytes === 'number' && Number.isFinite(parsed.maxOutputBytes)
      ? Math.max(1, Math.floor(parsed.maxOutputBytes))
      : 200_000,
    200_000,
  );
  const timeoutMs = Math.min(
    typeof parsed.timeoutMs === 'number' && Number.isFinite(parsed.timeoutMs)
      ? Math.max(1, Math.floor(parsed.timeoutMs))
      : 60_000,
    300_000,
  );
  let outcome: GitlabHttpResult;
  try {
    outcome = await sendGitlabRequest(
      buildGitlabRequest(validated),
      state.host,
      gitlab.credential,
      {
        timeoutMs,
        maxOutputBytes,
        signal,
        fetchImpl: gitlab.fetchImpl,
      },
    );
  } catch {
    return refuse('GitLab request refused: outside the pinned API surface');
  }
  if (outcome.textMeta !== undefined)
    return { ...outcome, output: redactTraceOutput(outcome.output) };
  // A repository file arrives base64-encoded: decode it before redaction,
  // so the redaction sees the text that reaches the model.
  const output =
    validated.kind === 'get_repository_file' && outcome.status === 'completed'
      ? decodeRepositoryFileOutput(outcome.output, outcome.truncated ? maxOutputBytes : undefined)
      : outcome.output;
  return { ...outcome, output: redactRuntimeOutput(output) };
}

/** Readiness metadata (sanitized: states, versions, digests, never credentials). */
export interface RuntimeReadinessReport {
  service: 'cli-runtime';
  /** Admin document version of the last instance listing, or null before the first sync. */
  configVersion: number | null;
  syncError: string | null;
  instances: RuntimeInstanceStatus[];
}

let instanceSync: ToolInstanceSync | null = null;

function readinessReport(): RuntimeReadinessReport {
  return {
    service: 'cli-runtime',
    configVersion: instanceSync?.configVersion ?? null,
    syncError: instanceSync?.lastError ?? null,
    instances: currentRegistry().statuses(),
  };
}

const ATLASSIAN_BINDING_KEYS = [
  'site',
  'cloudId',
  'adapter',
  'contractVersion',
  'operations',
  'credentialFingerprints',
];
export type AtlassianRuntimeResponse = AtlassianResult;

/** Scoped read-only Atlassian REST read against the named instance. */
export async function handleAtlassian(
  body: unknown,
  signal?: AbortSignal,
): Promise<AtlassianRuntimeResponse> {
  const refuse = (refused: string): AtlassianRuntimeResponse => ({
    status: 'not_run',
    output: refused,
    refused,
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid request');
  const parsed = body as Record<string, unknown>;
  if (
    Object.keys(parsed).some(
      (key) =>
        ![
          'instanceId',
          'teamId',
          'operation',
          'operationArgs',
          'binding',
          'timeoutMs',
          'maxOutputBytes',
        ].includes(key),
    )
  )
    return refuse('unknown transport field');
  const resolved = resolveInstance(parsed, 'atlassian');
  if ('refused' in resolved) return refuse(resolved.refused);
  const provider = resolved.entry.atlassian!;
  const state = provider.state;
  if (!state.ready || !state.site || !state.cloudId)
    return refuse(`atlassian not ready: ${state.status}`);
  let validated;
  try {
    validated = validateTransportAtlassianArgs(String(parsed.operation), parsed.operationArgs);
  } catch {
    return refuse('invalid Atlassian operation or arguments');
  }
  if (!state.operations.includes(validated.kind))
    return refuse(`operation not ready: ${atlassianProduct(validated.kind)} unavailable`);
  const binding = parsed.binding as Record<string, unknown> | null;
  const fingerprints = (value: unknown): string =>
    JSON.stringify(
      ['jira', 'confluence'].map((p) => (value as Record<string, unknown> | null)?.[p] ?? null),
    );
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    Object.keys(binding).some((k) => !ATLASSIAN_BINDING_KEYS.includes(k)) ||
    binding.site !== state.site ||
    binding.cloudId !== state.cloudId ||
    binding.adapter !== ATLASSIAN_ADAPTER ||
    binding.contractVersion !== ATLASSIAN_CONTRACT_VERSION ||
    state.adapter !== ATLASSIAN_ADAPTER ||
    state.contractVersion !== ATLASSIAN_CONTRACT_VERSION ||
    !binding.credentialFingerprints ||
    typeof binding.credentialFingerprints !== 'object' ||
    fingerprints(binding.credentialFingerprints) !== fingerprints(state.credentialFingerprints) ||
    !Array.isArray(binding.operations) ||
    !binding.operations.includes(validated.kind) ||
    binding.operations.some((op) => typeof op !== 'string')
  )
    return refuse('Atlassian site/cloud-ID/credential binding mismatch');
  const timeoutMs = parsed.timeoutMs ?? 60000;
  const maxOutputBytes = parsed.maxOutputBytes ?? 200000;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000 ||
    typeof maxOutputBytes !== 'number' ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 200000
  )
    return refuse('invalid execution bounds');
  try {
    const result = await provider.read(validated, timeoutMs, maxOutputBytes, signal);
    return { ...result, output: redactRuntimeOutput(result.output) };
  } catch {
    return refuse('Atlassian request unavailable');
  }
}

/** The pinned read catalog (names, descriptions, schemas) of one Datadog instance. */
export function datadogCatalogReport(query: { instanceId: string; teamId: string }): {
  tools: unknown[];
  excludedTools: string[];
  toolCatalogHash: string | null;
  refused?: string;
} {
  const resolved = resolveInstance(query, 'datadog');
  if ('refused' in resolved)
    return { tools: [], excludedTools: [], toolCatalogHash: null, refused: resolved.refused };
  const provider = resolved.entry.datadog!;
  if (!provider.state.ready) return { tools: [], excludedTools: [], toolCatalogHash: null };
  return provider.snapshotCatalog();
}

const DATADOG_BINDING_KEYS = [
  'site',
  'endpoint',
  'adapter',
  'contractVersion',
  'toolCatalogHash',
  'credentialFingerprint',
];
export type DatadogRuntimeResponse = DatadogCallResult;

/** One read-only Datadog MCP call against the named instance's pinned catalog. */
export async function handleDatadog(
  body: unknown,
  signal?: AbortSignal,
): Promise<DatadogRuntimeResponse> {
  const refuse = (refused: string): DatadogRuntimeResponse => ({
    status: 'not_run',
    output: refused,
    refused,
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid request');
  const parsed = body as Record<string, unknown>;
  if (
    Object.keys(parsed).some(
      (key) =>
        ![
          'instanceId',
          'teamId',
          'tool',
          'arguments',
          'binding',
          'timeoutMs',
          'maxOutputBytes',
        ].includes(key),
    )
  )
    return refuse('unknown transport field');
  const resolved = resolveInstance(parsed, 'datadog');
  if ('refused' in resolved) return refuse(resolved.refused);
  const provider = resolved.entry.datadog!;
  const state = provider.state;
  if (!state.ready) return refuse(`datadog not ready: ${state.status}`);
  const tool = typeof parsed.tool === 'string' ? parsed.tool : '';
  if (!state.tools.includes(tool)) return refuse('tool not in the pinned read catalog');
  const binding = parsed.binding as Record<string, unknown> | null;
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    Object.keys(binding).some((key) => !DATADOG_BINDING_KEYS.includes(key)) ||
    binding.site !== state.site ||
    binding.endpoint !== state.endpoint ||
    binding.adapter !== DATADOG_ADAPTER ||
    binding.contractVersion !== DATADOG_CONTRACT_VERSION ||
    binding.toolCatalogHash !== state.toolCatalogHash ||
    binding.credentialFingerprint !== state.credentialFingerprint
  )
    return refuse('Datadog site/catalog/credential binding mismatch');
  const timeoutMs = parsed.timeoutMs ?? 60000;
  const maxOutputBytes = parsed.maxOutputBytes ?? 200000;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000 ||
    typeof maxOutputBytes !== 'number' ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 200000
  )
    return refuse('invalid execution bounds');
  try {
    const result = await provider.call(tool, parsed.arguments, {
      timeoutMs,
      maxOutputBytes,
      signal,
    });
    return { ...result, output: redactRuntimeOutput(result.output) };
  } catch {
    return refuse('Datadog request unavailable');
  }
}

const CLOUDFLARE_BINDING_KEYS = [
  'endpoint',
  'adapter',
  'contractVersion',
  'accountId',
  'zoneSetHash',
  'credentialFingerprint',
];
export type CloudflareRuntimeResponse = CloudflareCallResult;

/** One read-only Cloudflare API read (GraphQL query or REST GET) against the named instance. */
export async function handleCloudflare(
  body: unknown,
  signal?: AbortSignal,
): Promise<CloudflareRuntimeResponse> {
  const refuse = (refused: string): CloudflareRuntimeResponse => ({
    status: 'not_run',
    output: refused,
    refused,
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid request');
  const parsed = body as Record<string, unknown>;
  if (
    Object.keys(parsed).some(
      (key) =>
        ![
          'instanceId',
          'teamId',
          'operation',
          'request',
          'binding',
          'timeoutMs',
          'maxOutputBytes',
        ].includes(key),
    )
  )
    return refuse('unknown transport field');
  const resolved = resolveInstance(parsed, 'cloudflare');
  if ('refused' in resolved) return refuse(resolved.refused);
  const provider = resolved.entry.cloudflare!;
  const state = provider.state;
  if (!state.ready) return refuse(`cloudflare not ready: ${state.status}`);
  const operation = parsed.operation;
  if (operation !== 'graphql' && operation !== 'get') return refuse('unknown Cloudflare operation');
  const binding = parsed.binding as Record<string, unknown> | null;
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    Object.keys(binding).some((key) => !CLOUDFLARE_BINDING_KEYS.includes(key)) ||
    binding.endpoint !== CLOUDFLARE_ENDPOINT ||
    state.endpoint !== CLOUDFLARE_ENDPOINT ||
    binding.adapter !== CLOUDFLARE_ADAPTER ||
    binding.contractVersion !== CLOUDFLARE_CONTRACT_VERSION ||
    (binding.accountId ?? null) !== state.accountId ||
    binding.zoneSetHash !== state.zoneSetHash ||
    binding.credentialFingerprint !== state.credentialFingerprint
  )
    return refuse('Cloudflare endpoint/zone/credential binding mismatch');
  const timeoutMs = parsed.timeoutMs ?? 60000;
  const maxOutputBytes = parsed.maxOutputBytes ?? 200000;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000 ||
    typeof maxOutputBytes !== 'number' ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 200000
  )
    return refuse('invalid execution bounds');
  try {
    const result = await provider.call(operation, parsed.request, {
      timeoutMs,
      maxOutputBytes,
      signal,
    });
    return { ...result, output: redactRuntimeOutput(result.output) };
  } catch {
    return refuse('Cloudflare request unavailable');
  }
}

const SLACK_BINDING_KEYS = [
  'endpoint',
  'adapter',
  'contractVersion',
  'teamId',
  'botUserId',
  'credentialFingerprint',
];
export type SlackRuntimeResponse = SlackCallResult;

/** Shape of a forwarded Slack `action_token` (no published grammar). */
const ACTION_TOKEN_SHAPE = /^[\x21-\x7e]{1,4096}$/;

/**
 * One read-only Slack user lookup or public-channel message search against
 * the named instance (the thread's workspace). A search carries the
 * triggering mention's `action_token`, which joins this request's redaction
 * set and is never logged; the other operations refuse one.
 */
export async function handleSlack(
  body: unknown,
  signal?: AbortSignal,
): Promise<SlackRuntimeResponse> {
  const refuse = (refused: string): SlackRuntimeResponse => ({
    status: 'not_run',
    output: refused,
    refused,
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid request');
  const parsed = body as Record<string, unknown>;
  if (
    Object.keys(parsed).some(
      (key) =>
        ![
          'instanceId',
          'teamId',
          'operation',
          'arguments',
          'binding',
          'timeoutMs',
          'maxOutputBytes',
          'actionToken',
        ].includes(key),
    )
  )
    return refuse('unknown transport field');
  const resolved = resolveInstance(parsed, 'slack');
  if ('refused' in resolved) return refuse(resolved.refused);
  const provider = resolved.entry.slack!;
  const state = provider.state;
  if (!state.ready) return refuse(`slack not ready: ${state.status}`);
  const operation = parsed.operation;
  if (operation !== 'getUser' && operation !== 'lookupByEmail' && operation !== 'searchMessages')
    return refuse('unknown Slack operation');
  const actionToken = parsed.actionToken;
  if (operation === 'searchMessages') {
    if (typeof actionToken !== 'string' || !ACTION_TOKEN_SHAPE.test(actionToken))
      return refuse("Slack message search needs the triggering mention's action token");
  } else if (actionToken !== undefined)
    return refuse('only a message search carries an action token');
  const binding = parsed.binding as Record<string, unknown> | null;
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    Object.keys(binding).some((key) => !SLACK_BINDING_KEYS.includes(key)) ||
    binding.endpoint !== SLACK_ENDPOINT ||
    state.endpoint !== SLACK_ENDPOINT ||
    binding.adapter !== SLACK_ADAPTER ||
    binding.contractVersion !== SLACK_CONTRACT_VERSION ||
    binding.teamId !== parsed.teamId ||
    binding.teamId !== state.teamId ||
    binding.botUserId !== state.botUserId ||
    binding.credentialFingerprint !== state.credentialFingerprint
  )
    return refuse('Slack endpoint/workspace/credential binding mismatch');
  const timeoutMs = parsed.timeoutMs ?? 60000;
  const maxOutputBytes = parsed.maxOutputBytes ?? 200000;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000 ||
    typeof maxOutputBytes !== 'number' ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 200000
  )
    return refuse('invalid execution bounds');
  const requestSecrets = typeof actionToken === 'string' ? [actionToken] : [];
  try {
    const bounds = { timeoutMs, maxOutputBytes, signal };
    const result =
      operation === 'searchMessages'
        ? await provider.search(parsed.arguments, actionToken as string, bounds)
        : await provider.call(operation, parsed.arguments, bounds);
    return { ...result, output: redactRuntimeOutput(result.output, requestSecrets) };
  } catch {
    return refuse('Slack request unavailable');
  }
}

export async function startCliRuntimeServer(): Promise<void> {
  assertCliRuntimeEnvClean();
  const admitted = admittedHostsFromEnv();
  instanceSync = new ToolInstanceSync({
    adminUrl: (process.env.ADMIN_URL ?? '').trim(),
    adminToken: (process.env.ADMIN_INTERNAL_TOKEN ?? '').trim(),
    caller: 'cli-runtime',
    kinds: [...CLI_RUNTIME_KINDS],
    log: (line) => console.log(line),
    onChange: (instances) => {
      void currentRegistry()
        .apply(instances)
        .catch(() => {});
    },
  });
  const sync = instanceSync;
  registry = new CliInstanceRegistry({
    admitted,
    secret: (instanceId) => sync.secret(instanceId),
    report: (statuses) => sync.report(statuses),
    log: (line) => console.log(line),
  });
  // Provider calls (fetch) leave through the egress proxy; the admin service
  // stays direct on the internal adminapi network.
  const proxyUrl = egressProxyUrlFromEnv();
  configureOutbound(proxyUrl);
  console.log(`cli-runtime outbound: ${proxyUrl !== undefined ? 'egress proxy' : 'direct'}`);
  const port = Number.parseInt((process.env.CLI_RUNTIME_PORT ?? '9877').trim(), 10) || 9877;
  // Instances sync and probe in the background: startup never waits for a
  // provider, and /readyz always exposes the current sanitized outcome.
  sync.start();
  const probeTimer = setInterval(() => {
    void registry?.probeAll().catch(() => {});
  }, probeIntervalMs());
  probeTimer.unref();
  const retryTimer = setInterval(() => {
    void registry?.retryTransient().catch(() => {});
  }, TRANSIENT_RETRY_MS);
  retryTimer.unref();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://cli-runtime');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        // Open liveness; never a readiness claim.
        json(res, 200, { ok: true, service: 'cli-runtime' });
        return;
      }
      const header = req.headers.authorization ?? '';
      const match = /^Bearer (.+)$/.exec(header);
      if (match === null || !timingSafeEqual(match[1] ?? '', cliRuntimeToken())) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/readyz') {
        await sync.syncOnce();
        currentRegistry().refreshIfStale();
        json(res, 200, readinessReport());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/datadog/catalog') {
        json(
          res,
          200,
          datadogCatalogReport({
            instanceId: url.searchParams.get('instanceId') ?? '',
            teamId: url.searchParams.get('teamId') ?? '',
          }),
        );
        return;
      }
      const handlers: Record<string, (body: unknown, signal: AbortSignal) => Promise<unknown>> = {
        '/datadog': handleDatadog,
        '/cloudflare': handleCloudflare,
        '/slack': handleSlack,
        '/gitlab': handleGitlab,
        '/atlassian': handleAtlassian,
      };
      const handler = req.method === 'POST' ? handlers[url.pathname] : undefined;
      if (handler !== undefined) {
        const raw = await readBody(req, 1_000_000);
        const body = JSON.parse(raw.toString('utf8')) as unknown;
        const controller = new AbortController();
        res.once('close', () => {
          if (!res.writableFinished) controller.abort();
        });
        json(res, 200, await handler(body, controller.signal));
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message.slice(0, 200) : 'bad request' });
    }
  });
  server.listen(port, () => {
    console.log(
      `cli runtime ready on :${port} (admitted gitlab=${admitted.gitlab.size} atlassian=${admitted.atlassian.size} datadog=${admitted.datadog.size} cloudflare=${admitted.cloudflare.size} hosts)`,
    );
  });
  const shutdown = (): void => {
    sync.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Standalone entrypoint: `node dist/coding/cli-runtime-service.js --serve`.
const invokedAsMain = process.argv[1]?.endsWith('cli-runtime-service.js') === true;
if (invokedAsMain && process.argv.includes('--serve')) {
  startCliRuntimeServer().catch((err) => {
    // Startup failures are operator-actionable and never contain secret
    // values (variable names only).
    process.stderr.write(
      `CLI runtime startup failed: ${err instanceof Error ? err.message.slice(0, 300) : 'qualification failed'}\n`,
    );
    process.exitCode = 1;
  });
}
