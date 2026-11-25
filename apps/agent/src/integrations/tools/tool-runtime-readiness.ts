/**
 * Runner-side consumption of the tool runtime's per-instance readiness.
 *
 * Every GitLab, Atlassian, Datadog, Cloudflare and Slack instance assigned to the
 * task's channel is checked before the first model turn: the runtime must
 * serve it for the run's workspace, report it ready for the credential
 * version the admin document names, and (per kind) the same host, the same
 * site/cloud-ID/credential binding, a pinned Datadog catalog that matches
 * the readiness catalog hash, or a Cloudflare zone snapshot that matches its
 * zone-set hash, or a Slack bot token of the thread's own workspace. A
 * failing check drops only that tool.
 *
 * Readiness metadata is sanitized by the runtime (versions/digests/status
 * categories, never credentials or raw auth/upstream output).
 */

import type { EffectiveGitlab, EffectiveTool } from './tool-profile.js';
import { GITLAB_CONTRACT_VERSION } from '../gitlab/gitlab-operations.js';
import {
  ATLASSIAN_ADAPTER,
  ATLASSIAN_CONTRACT_VERSION,
  ATLASSIAN_READ_OPERATIONS,
  atlassianProduct,
} from '../atlassian/atlassian-operations.js';
import {
  DATADOG_ADAPTER,
  DATADOG_CONTRACT_VERSION,
  DATADOG_UPSTREAM_NAME_PATTERN,
  datadogCatalogHash,
  datadogEndpoint,
  type DatadogCatalogTool,
} from '../datadog/datadog-mcp-adapter.js';
import {
  CLOUDFLARE_ADAPTER,
  CLOUDFLARE_CONTRACT_VERSION,
  CLOUDFLARE_ENDPOINT,
  CLOUDFLARE_ID_PATTERN,
  cloudflareZoneSetHash,
} from '../cloudflare/cloudflare-api-adapter.js';
import {
  SLACK_ADAPTER,
  SLACK_CONTRACT_VERSION,
  SLACK_ENDPOINT,
  SLACK_TEAM_ID,
  SLACK_USER_ID,
} from '../slack/slack-api-adapter.js';

export interface AtlassianRuntimeProviderStatus {
  tool: 'atlassian';
  enabled: boolean;
  ready: boolean;
  status: string;
  detail: string;
  site: string | null;
  cloudId: string | null;
  adapter: string;
  contractVersion: string;
  operations: string[];
  /** Per-product readiness category (ready, not_configured, pending, or a failure category). */
  products: Record<'jira' | 'confluence', string>;
  /** Stable per-product token identity; changes only when a token is rotated. */
  credentialFingerprints: Partial<Record<'jira' | 'confluence', string>>;
  checkedAt: string | null;
}

export interface DatadogRuntimeProviderStatus {
  tool: 'datadog';
  enabled: boolean;
  ready: boolean;
  status: string;
  detail: string;
  site: string | null;
  /** Fixed MCP endpoint derived from the site. */
  endpoint: string | null;
  adapter: string;
  contractVersion: string;
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  toolsets: string | null;
  /** Hash of the pinned read catalog (names, descriptions, schemas, exclusions). */
  toolCatalogHash: string | null;
  /** Allowed upstream tool names. */
  tools: string[];
  /** Upstream names filtered out as mutating (or unregistrable). */
  excludedTools: string[];
  /** Stable token identity; changes only when the token is rotated. */
  credentialFingerprint: string | null;
  checkedAt: string | null;
}

/** One zone a Cloudflare instance exposes (metadata only). */
export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  plan: string | null;
}

export interface CloudflareRuntimeProviderStatus {
  tool: 'cloudflare';
  enabled: boolean;
  ready: boolean;
  status: string;
  detail: string;
  /** Fixed API endpoint (`https://api.cloudflare.com/client/v4`). */
  endpoint: string;
  adapter: string;
  contractVersion: string;
  /** Account the account-level datasets are limited to (null: zone-level only). */
  accountId: string | null;
  /** The zones are an operator-chosen subset of what the token can see. */
  restrictedZones: boolean;
  /** Exposed zones (bounded to 200), sorted by name. */
  zones: CloudflareZone[];
  /** Hash of the exposed zone set (`id:name` pairs). */
  zoneSetHash: string | null;
  /** Stable token identity; changes only when the token is rotated. */
  credentialFingerprint: string | null;
  checkedAt: string | null;
}

export interface SlackRuntimeProviderStatus {
  tool: 'slack';
  enabled: boolean;
  ready: boolean;
  status: string;
  detail: string;
  /** Fixed API endpoint (`https://slack.com/api`). */
  endpoint: string;
  adapter: string;
  contractVersion: string;
  /** Workspace the bot token belongs to (from auth.test; must be the instance's). */
  teamId: string | null;
  botUserId: string | null;
  /** Granted bot scopes (from x-oauth-scopes). */
  scopes: string[];
  /** `search:read.public` is granted (message search possible; never a readiness condition). */
  searchScope: boolean;
  /** Stable token identity; changes only when the token is rotated (reinstall). */
  credentialFingerprint: string | null;
  checkedAt: string | null;
}

/** One instance on the tool runtime's /readyz (sanitized; see cli-runtime-service.ts). */
export interface RuntimeInstanceReadiness {
  instanceId: string;
  teamId: string;
  kind: string;
  label: string;
  credentialVersion: number;
  state: 'ready' | 'pending' | 'error' | 'blocked';
  detail: string;
  gitlab?: {
    ready: boolean;
    status: string;
    detail: string;
    host: string;
    contractVersion: number;
  };
  atlassian?: AtlassianRuntimeProviderStatus;
  datadog?: DatadogRuntimeProviderStatus;
  cloudflare?: CloudflareRuntimeProviderStatus;
  slack?: SlackRuntimeProviderStatus;
}

export interface CliRuntimeReadiness {
  service: string;
  configVersion: number | null;
  syncError: string | null;
  instances: RuntimeInstanceReadiness[];
}

/** Qualified GitLab binding for this run (instance, host, contract). */
export interface GitlabBinding {
  instanceId: string;
  host: string;
  contractVersion: number;
}

/** Trusted Atlassian site/cloud-ID/credential binding for brokered Jira and Confluence calls. */
export interface AtlassianBinding {
  site: string;
  cloudId: string;
  adapter: string;
  contractVersion: string;
  operations: string[];
  credentialFingerprints: Partial<Record<'jira' | 'confluence', string>>;
}

/** Trusted Datadog site/endpoint/catalog/credential binding for brokered MCP reads. */
export interface DatadogBinding {
  site: string;
  endpoint: string;
  adapter: string;
  contractVersion: string;
  toolCatalogHash: string;
  credentialFingerprint: string;
}

/** Qualified Datadog provider for one run: binding plus the registrable read catalog. */
export interface DatadogQualification {
  binding: DatadogBinding;
  /** Upstream tools registered for this run (config denyTools already removed). */
  tools: DatadogCatalogTool[];
  /** Mutating names the runtime excluded plus the operator's denyTools. */
  excludedTools: string[];
}

/** Trusted Cloudflare endpoint/account/zone-set/credential binding for brokered API reads. */
export interface CloudflareBinding {
  endpoint: string;
  adapter: string;
  contractVersion: string;
  accountId: string | null;
  zoneSetHash: string;
  credentialFingerprint: string;
}

/** Qualified Cloudflare provider for one run: binding plus the exposed zones. */
export interface CloudflareQualification {
  binding: CloudflareBinding;
  zones: CloudflareZone[];
  restrictedZones: boolean;
}

/** Trusted Slack endpoint/workspace/credential binding for brokered user lookups. */
export interface SlackBinding {
  endpoint: string;
  adapter: string;
  contractVersion: string;
  /** The thread's workspace, which the bot token belongs to. */
  teamId: string;
  botUserId: string;
  credentialFingerprint: string;
}

const READINESS_TIMEOUT_MS = 10_000;
const READINESS_ATTEMPTS = 3;

export async function fetchCliRuntimeReadiness(
  cliRuntimeUrl: string,
  cliRuntimeToken: string,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<CliRuntimeReadiness> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(new URL('/readyz', cliRuntimeUrl), {
        headers: { authorization: `Bearer ${cliRuntimeToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          'CLI runtime rejected the runner readiness request (CLI_RUNTIME_TOKEN mismatch)',
        );
      }
      if (!response.ok) throw new Error(`CLI runtime /readyz returned HTTP ${response.status}`);
      const parsed = (await response.json()) as Partial<CliRuntimeReadiness>;
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.instances))
        throw new Error('CLI runtime /readyz returned an invalid readiness report');
      return {
        service: String(parsed.service ?? 'cli-runtime'),
        configVersion: typeof parsed.configVersion === 'number' ? parsed.configVersion : null,
        syncError: typeof parsed.syncError === 'string' ? parsed.syncError : null,
        instances: parsed.instances,
      };
    } catch (err) {
      lastError = err;
      if (attempt < READINESS_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CLI runtime /readyz request failed');
}

/** Common checks: the runtime serves the instance, for the run's workspace, and it is ready. */
function requireReady(
  status: RuntimeInstanceReadiness | undefined,
  kind: string,
  teamId: string,
): RuntimeInstanceReadiness {
  if (status === undefined)
    throw new Error('the tool runtime does not serve this instance yet (it syncs within seconds)');
  if (status.kind !== kind || status.teamId !== teamId)
    throw new Error('the tool runtime serves this instance for another kind or workspace');
  if (status.state !== 'ready')
    throw new Error(`the tool runtime reports it ${status.state}: ${status.detail.slice(0, 200)}`);
  return status;
}

/**
 * Qualifies the channel's GitLab instance against the tool runtime: ready,
 * the same host the admin document names, the same typed contract.
 */
export function verifyGitlabInstance(
  status: RuntimeInstanceReadiness | undefined,
  gitlab: EffectiveGitlab,
  teamId: string,
): GitlabBinding {
  const ready = requireReady(status, 'gitlab', teamId);
  const state = ready.gitlab;
  if (state === undefined || !state.ready) throw new Error('GitLab readiness is missing');
  if (state.host.toLowerCase() !== gitlab.host)
    throw new Error('the tool runtime serves a different host for this instance');
  if (state.contractVersion !== GITLAB_CONTRACT_VERSION)
    throw new Error(
      `GitLab contract v${String(state.contractVersion)} of the tool runtime does not match this runner (v${GITLAB_CONTRACT_VERSION}); rebuild both images from the same revision`,
    );
  if (ready.credentialVersion !== gitlab.credentialVersion)
    throw new Error('the tool runtime holds another credential version; retry shortly');
  return {
    instanceId: gitlab.instanceId,
    host: gitlab.host,
    contractVersion: GITLAB_CONTRACT_VERSION,
  };
}

/**
 * Intersects the channel's Atlassian instance with the tool runtime's
 * scoped REST readiness. Returns the trusted site/cloud-ID/credential
 * binding for brokered Jira/Confluence calls (never supplied by the model).
 */
export function verifyAtlassianInstance(
  status: RuntimeInstanceReadiness | undefined,
  tool: EffectiveTool,
  teamId: string,
): AtlassianBinding {
  const ready = requireReady(status, 'atlassian', teamId);
  const state = ready.atlassian;
  if (state === undefined || !state.ready) throw new Error('Atlassian readiness is missing');
  const fingerprints = state.credentialFingerprints ?? {};
  if (
    !state.site ||
    !/^[0-9a-f-]{36}$/.test(state.cloudId ?? '') ||
    state.adapter !== ATLASSIAN_ADAPTER ||
    !Object.keys(fingerprints).length ||
    Object.entries(fingerprints).some(
      ([product, value]) =>
        (product !== 'jira' && product !== 'confluence') || !/^[a-f0-9]{16}$/.test(value ?? ''),
    )
  )
    throw new Error('the tool runtime did not report a site/cloud-ID/credential binding');
  if (state.contractVersion !== ATLASSIAN_CONTRACT_VERSION)
    throw new Error(
      `Atlassian contract ${state.contractVersion} is not supported by this runner (expected ${ATLASSIAN_CONTRACT_VERSION})`,
    );
  if (ready.credentialVersion !== tool.credentialVersion)
    throw new Error('the tool runtime holds another credential version; retry shortly');
  const known = new Set<string>(ATLASSIAN_READ_OPERATIONS);
  const configured = new Set<string>(tool.operations ?? ATLASSIAN_READ_OPERATIONS);
  for (const op of configured) {
    if (!known.has(op)) throw new Error(`unknown Atlassian operation ${op.slice(0, 64)}`);
  }
  const operations = ATLASSIAN_READ_OPERATIONS.filter(
    (op) => configured.has(op) && state.products?.[atlassianProduct(op)] === 'ready',
  );
  for (const op of operations) {
    if (!state.operations.includes(op))
      throw new Error(
        `operation ${op} is not ready (jira=${state.products?.jira ?? 'unknown'}, confluence=${state.products?.confluence ?? 'unknown'}); fix that product's token or remove the operation`,
      );
  }
  return {
    site: state.site,
    cloudId: state.cloudId!,
    adapter: state.adapter,
    contractVersion: ATLASSIAN_CONTRACT_VERSION,
    operations: operations.sort(),
    credentialFingerprints: {
      ...(fingerprints.jira ? { jira: fingerprints.jira } : {}),
      ...(fingerprints.confluence ? { confluence: fingerprints.confluence } : {}),
    },
  };
}

/** Fetches one instance's pinned Datadog read catalog from the runtime (authenticated, bounded). */
export async function fetchDatadogCatalog(
  runtime: { url: string; token: string },
  instance: { instanceId: string; teamId: string },
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<{ tools: unknown; excludedTools: unknown; toolCatalogHash: unknown }> {
  const url = new URL('/datadog/catalog', runtime.url);
  url.searchParams.set('instanceId', instance.instanceId);
  url.searchParams.set('teamId', instance.teamId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${runtime.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`CLI runtime /datadog/catalog returned HTTP ${response.status}`);
  const parsed = (await response.json()) as Record<string, unknown> | null;
  if (parsed === null || typeof parsed !== 'object')
    throw new Error('CLI runtime /datadog/catalog returned an invalid catalog');
  if (typeof parsed.refused === 'string') throw new Error(parsed.refused.slice(0, 200));
  return {
    tools: parsed.tools,
    excludedTools: parsed.excludedTools,
    toolCatalogHash: parsed.toolCatalogHash,
  };
}

function isCatalogTool(value: unknown): value is DatadogCatalogTool {
  const entry = value as Partial<DatadogCatalogTool> | null;
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.name === 'string' &&
    DATADOG_UPSTREAM_NAME_PATTERN.test(entry.name) &&
    typeof entry.description === 'string' &&
    entry.inputSchema !== null &&
    typeof entry.inputSchema === 'object' &&
    !Array.isArray(entry.inputSchema) &&
    (entry.inputSchema as { type?: unknown }).type === 'object'
  );
}

/**
 * Intersects the channel's Datadog instance with the tool runtime's MCP
 * readiness. Returns the trusted site/endpoint/catalog/credential binding
 * and the catalog to register (never supplied by the model).
 */
export async function verifyDatadogInstance(
  status: RuntimeInstanceReadiness | undefined,
  tool: EffectiveTool,
  teamId: string,
  runtime: { url: string; token: string },
  catalogFetch: typeof fetchDatadogCatalog = fetchDatadogCatalog,
): Promise<DatadogQualification> {
  const ready = requireReady(status, 'datadog', teamId);
  const state = ready.datadog;
  if (state === undefined || !state.ready) throw new Error('Datadog readiness is missing');
  let endpoint: string | null = null;
  try {
    endpoint = state.site ? datadogEndpoint(state.site) : null;
  } catch {
    endpoint = null;
  }
  if (
    endpoint === null ||
    state.endpoint !== endpoint ||
    state.adapter !== DATADOG_ADAPTER ||
    !/^[a-f0-9]{16}$/.test(state.credentialFingerprint ?? '') ||
    !/^[a-f0-9]{32}$/.test(state.toolCatalogHash ?? '')
  )
    throw new Error('the tool runtime did not report a site/endpoint/catalog/credential binding');
  if (state.contractVersion !== DATADOG_CONTRACT_VERSION)
    throw new Error(
      `Datadog contract ${state.contractVersion} is not supported by this runner (expected ${DATADOG_CONTRACT_VERSION})`,
    );
  if (ready.credentialVersion !== tool.credentialVersion)
    throw new Error('the tool runtime holds another credential version; retry shortly');
  const catalog = await catalogFetch(runtime, { instanceId: tool.instanceId, teamId });
  const excludedByRuntime = catalog.excludedTools;
  if (
    !Array.isArray(catalog.tools) ||
    !catalog.tools.every(isCatalogTool) ||
    !Array.isArray(excludedByRuntime) ||
    !excludedByRuntime.every((name) => typeof name === 'string') ||
    catalog.toolCatalogHash !== state.toolCatalogHash ||
    datadogCatalogHash({
      tools: catalog.tools,
      excludedTools: excludedByRuntime as string[],
    }) !== state.toolCatalogHash
  )
    throw new Error(
      'the Datadog catalog changed during qualification (it does not match the readiness hash); retry the request',
    );
  const deny = new Set(tool.denyTools ?? []);
  return {
    binding: {
      site: state.site!,
      endpoint,
      adapter: DATADOG_ADAPTER,
      contractVersion: DATADOG_CONTRACT_VERSION,
      toolCatalogHash: state.toolCatalogHash!,
      credentialFingerprint: state.credentialFingerprint!,
    },
    tools: catalog.tools.filter((entry) => !deny.has(entry.name)),
    excludedTools: [
      ...new Set([
        ...(excludedByRuntime as string[]),
        ...catalog.tools.filter((entry) => deny.has(entry.name)).map((entry) => entry.name),
      ]),
    ].sort(),
  };
}

function isZone(value: unknown): value is CloudflareZone {
  const zone = value as Partial<CloudflareZone> | null;
  return (
    zone !== null &&
    typeof zone === 'object' &&
    typeof zone.id === 'string' &&
    CLOUDFLARE_ID_PATTERN.test(zone.id) &&
    typeof zone.name === 'string' &&
    /^[a-z0-9.-]{1,253}$/.test(zone.name) &&
    typeof zone.status === 'string' &&
    (zone.plan === null || typeof zone.plan === 'string')
  );
}

/**
 * Intersects the channel's Cloudflare instance with the tool runtime's
 * readiness. Returns the trusted endpoint/account/zone-set/credential
 * binding and the zone snapshot (never supplied by the model).
 */
export function verifyCloudflareInstance(
  status: RuntimeInstanceReadiness | undefined,
  tool: EffectiveTool,
  teamId: string,
): CloudflareQualification {
  const ready = requireReady(status, 'cloudflare', teamId);
  const state = ready.cloudflare;
  if (state === undefined || !state.ready) throw new Error('Cloudflare readiness is missing');
  if (
    state.endpoint !== CLOUDFLARE_ENDPOINT ||
    state.adapter !== CLOUDFLARE_ADAPTER ||
    !/^[a-f0-9]{16}$/.test(state.credentialFingerprint ?? '') ||
    !/^[a-f0-9]{32}$/.test(state.zoneSetHash ?? '') ||
    (state.accountId !== null && !CLOUDFLARE_ID_PATTERN.test(state.accountId ?? ''))
  )
    throw new Error('the tool runtime did not report an endpoint/zone/credential binding');
  if (state.contractVersion !== CLOUDFLARE_CONTRACT_VERSION)
    throw new Error(
      `Cloudflare contract ${state.contractVersion} is not supported by this runner (expected ${CLOUDFLARE_CONTRACT_VERSION})`,
    );
  if (ready.credentialVersion !== tool.credentialVersion)
    throw new Error('the tool runtime holds another credential version; retry shortly');
  if (
    !Array.isArray(state.zones) ||
    state.zones.length === 0 ||
    state.zones.length > 200 ||
    !state.zones.every(isZone) ||
    cloudflareZoneSetHash(state.zones) !== state.zoneSetHash
  )
    throw new Error(
      'the Cloudflare zone list does not match its readiness hash; retry the request',
    );
  if ((tool.accountId ?? null) !== state.accountId)
    throw new Error('the tool runtime serves another Cloudflare account for this instance');
  const configured = tool.zones ?? null;
  if (
    configured !== null &&
    JSON.stringify([...configured].sort()) !==
      JSON.stringify(state.zones.map((zone) => zone.name).sort())
  )
    throw new Error(
      'the tool runtime serves other Cloudflare zones for this instance; retry shortly',
    );
  return {
    binding: {
      endpoint: CLOUDFLARE_ENDPOINT,
      adapter: CLOUDFLARE_ADAPTER,
      contractVersion: CLOUDFLARE_CONTRACT_VERSION,
      accountId: state.accountId,
      zoneSetHash: state.zoneSetHash!,
      credentialFingerprint: state.credentialFingerprint!,
    },
    zones: state.zones.map((zone) => ({ ...zone })),
    restrictedZones: configured !== null,
  };
}

/**
 * Intersects the channel's Slack instance with the tool runtime's readiness.
 * Besides the common checks, the bot token must belong to the thread's own
 * workspace: a thread in workspace A never binds workspace B's token.
 */
export function verifySlackInstance(
  status: RuntimeInstanceReadiness | undefined,
  tool: EffectiveTool,
  teamId: string,
): SlackBinding {
  const ready = requireReady(status, 'slack', teamId);
  const state = ready.slack;
  if (state === undefined || !state.ready) throw new Error('Slack readiness is missing');
  if (
    state.endpoint !== SLACK_ENDPOINT ||
    state.adapter !== SLACK_ADAPTER ||
    !/^[a-f0-9]{16}$/.test(state.credentialFingerprint ?? '') ||
    !SLACK_TEAM_ID.test(state.teamId ?? '') ||
    !SLACK_USER_ID.test(state.botUserId ?? '')
  )
    throw new Error('the tool runtime did not report an endpoint/workspace/credential binding');
  if (state.contractVersion !== SLACK_CONTRACT_VERSION)
    throw new Error(
      `Slack contract ${state.contractVersion} is not supported by this runner (expected ${SLACK_CONTRACT_VERSION})`,
    );
  if (state.teamId !== teamId)
    throw new Error("the Slack bot token belongs to another workspace than this thread's");
  if (ready.credentialVersion !== tool.credentialVersion)
    throw new Error('the tool runtime holds another bot token version; retry shortly');
  return {
    endpoint: SLACK_ENDPOINT,
    adapter: SLACK_ADAPTER,
    contractVersion: SLACK_CONTRACT_VERSION,
    teamId,
    botUserId: state.botUserId!,
    credentialFingerprint: state.credentialFingerprint!,
  };
}
