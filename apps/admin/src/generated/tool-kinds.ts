/**
 * GENERATED verbatim from apps/agent/src/contracts/tool-kinds.ts — do not hand-edit.
 * Regenerate with:
 *
 *   npm run generate:protocol
 */

/**
 * Tool instance kinds: the one definition of what an admin-managed tool
 * instance is, shared by the admin service (validation before storing,
 * through its generated verbatim copy apps/admin/src/generated/tool-kinds.ts)
 * and the agent and tool runtime (validation of what they receive).
 *
 * A tool instance belongs to one workspace and has one kind. Settings are
 * non-secret; the credential is stored encrypted by the admin service and is
 * never part of any document or API answer.
 *
 * This module must stay dependency-free: it is copied verbatim.
 */

export const TOOL_KINDS = [
  'gitlab',
  'atlassian',
  'datadog',
  'cloudflare',
  'slack',
  'webSearch',
  'webFetch',
  'codeMode',
  'files',
  'localExec',
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** @public */
export const TOOL_KIND_TITLES: Record<ToolKind, string> = {
  gitlab: 'GitLab',
  atlassian: 'Jira/Confluence',
  datadog: 'Datadog',
  cloudflare: 'Cloudflare',
  slack: 'Slack',
  webSearch: 'Web search',
  webFetch: 'Web fetch',
  codeMode: 'Code Mode',
  files: 'Task files',
  localExec: 'Local commands',
};

/**
 * Kinds whose instances need an operator-entered credential before they can
 * become ready. A Slack instance has none: it uses its workspace's bot token.
 */
export const CREDENTIAL_KINDS: readonly ToolKind[] = [
  'gitlab',
  'atlassian',
  'datadog',
  'cloudflare',
];

/** Kinds served by the credential-owning cli-runtime (the others need no runtime or use the web runtime). */
export const CLI_RUNTIME_KINDS = [
  'gitlab',
  'atlassian',
  'datadog',
  'cloudflare',
  'slack',
] as const satisfies readonly ToolKind[];
/**
 * Hosted search runs inside the selected model provider.
 *
 * @public
 */
export const WEB_RUNTIME_KINDS: readonly ToolKind[] = ['webFetch'];

/**
 * Kinds that are also MCP servers for authorization (`mcp.use`).
 *
 * @public
 */
export const MCP_KINDS: readonly ToolKind[] = ['atlassian', 'datadog', 'cloudflare', 'slack'];

/**
 * Short codes used in compiled policy role names (the role pattern is `[a-z][a-z0-9-]*`).
 *
 * @public
 */
export const TOOL_KIND_CODES: Record<ToolKind, string> = {
  gitlab: 'gl',
  atlassian: 'at',
  datadog: 'dd',
  cloudflare: 'cf',
  slack: 'sl',
  webSearch: 'ws',
  webFetch: 'wf',
  codeMode: 'cm',
  files: 'fs',
  localExec: 'ex',
};

/** Typed Atlassian read operations (contract atlassian-read-v4). */
export const ATLASSIAN_READ_OPERATIONS = [
  'searchJiraIssues',
  'searchJiraIssuesUsingJql',
  'getJiraIssue',
  'listJiraIssueComments',
  'listJiraProjects',
  'searchConfluencePages',
  'getConfluencePage',
] as const;

export const TOOL_INSTANCE_ID = /^ti_[a-f0-9]{16}$/;
export const MAX_LABEL_CHARS = 64;

/** GitLab: a host name, optionally with a port (self-managed instances). */
const GITLAB_HOST =
  /^(?=.{1,253}(?::|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?$/;
const ATLASSIAN_SITE = /^[a-z0-9][a-z0-9-]{0,61}\.atlassian\.net$/;
/** Commercial Datadog sites; gov sites are refused (the MCP server does not serve them). */
const DATADOG_SITE = /^(?:[a-z0-9]{2,8}\.)?datadoghq\.(?:com|eu)$/;
const DATADOG_TOOLSETS = /^(?:all|[a-z0-9-]{1,64}(?:,[a-z0-9-]{1,64}){0,31})$/;
const DATADOG_UPSTREAM_NAME = /^[a-z][a-z0-9_-]{0,79}$/;
/** The Cloudflare API host: the only legal host of a Cloudflare instance. */
export const CLOUDFLARE_API_HOST = 'api.cloudflare.com';
/** Cloudflare account and zone IDs: 32 lowercase hex characters. */
export const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;
/** Cloudflare zone names: bare host names (no port). */
export const CLOUDFLARE_ZONE_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const MAX_CLOUDFLARE_ZONES = 200;
/** The Slack Web API host: the only legal host of a Slack instance. */
export const SLACK_API_HOST = 'slack.com';
const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An e-mail address (Atlassian token owner, Slack user lookups). */
export const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,253}$/;

export class ToolKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolKindError';
  }
}

// --- Settings ----------------------------------------------------------------------

export interface AtlassianSettings {
  cloudId: string;
  email: string;
  /** Operation allowlist; null = every read operation. */
  operations: string[] | null;
}
export interface DatadogSettings {
  toolsets: string;
  /** Upstream tool names removed from the catalog on top of the mutating-tool exclusion. */
  denyTools: string[];
}
export interface CloudflareSettings {
  /** Account the account-level datasets are limited to; null = zone-level access only. */
  accountId: string | null;
  /** Zone names the instance exposes (sorted); null = every zone the token can see. */
  zones: string[] | null;
}
export interface FilesSettings {
  readOnly: boolean;
}
export type EmptySettings = Record<string, never>;

export interface ToolSettingsByKind {
  gitlab: EmptySettings;
  atlassian: AtlassianSettings;
  datadog: DatadogSettings;
  cloudflare: CloudflareSettings;
  slack: EmptySettings;
  webSearch: EmptySettings;
  webFetch: EmptySettings;
  codeMode: EmptySettings;
  files: FilesSettings;
  localExec: EmptySettings;
}
export type ToolSettings = ToolSettingsByKind[ToolKind];

export interface ToolInstanceInput {
  kind: ToolKind;
  label: string;
  /**
   * GitLab host, Atlassian site, Datadog site, the Cloudflare or Slack API
   * host; null for the other kinds.
   */
  host: string | null;
  settings: ToolSettings;
}

export function isToolKind(value: unknown): value is ToolKind {
  return typeof value === 'string' && (TOOL_KINDS as readonly string[]).includes(value);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new ToolKindError(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function noUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new ToolKindError(`unknown field ${where}.${key.slice(0, 40)}`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new ToolKindError(`${where} must be a string`);
  return value.trim();
}

/** Atlassian operations: exact names, no duplicates, sorted; null for "all". */
export function normalizeAtlassianOperationList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value))
    throw new ToolKindError('operations must be a list of operation names');
  const known = new Set<string>(ATLASSIAN_READ_OPERATIONS);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !known.has(entry))
      throw new ToolKindError(`unknown Atlassian operation "${String(entry).slice(0, 64)}"`);
    if (seen.has(entry)) throw new ToolKindError(`duplicate Atlassian operation "${entry}"`);
    seen.add(entry);
  }
  if (seen.size === 0)
    throw new ToolKindError('operations must not be empty (disable the instance instead)');
  return [...seen].sort();
}

export function normalizeDatadogDenyTools(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolKindError('denyTools must be a list of tool names');
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !DATADOG_UPSTREAM_NAME.test(entry))
      throw new ToolKindError(
        `denyTools contains "${String(entry).slice(0, 64)}" (exact upstream names such as search_datadog_logs)`,
      );
    if (seen.has(entry)) throw new ToolKindError(`denyTools contains duplicate "${entry}"`);
    seen.add(entry);
  }
  return [...seen].sort();
}

/** Cloudflare account ID: 32 lowercase hex characters; empty or null for none. */
export function normalizeCloudflareAccountId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = text(value, 'settings.accountId').toLowerCase();
  if (raw.length === 0) return null;
  if (!CLOUDFLARE_ID.test(raw))
    throw new ToolKindError(
      'settings.accountId must be a Cloudflare account ID (32 hex characters)',
    );
  return raw;
}

/** Cloudflare zone names: host names, no duplicates, sorted; null (or empty) for "all". */
export function normalizeCloudflareZones(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new ToolKindError('settings.zones must be a list of zone names');
  const seen = new Set<string>();
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!CLOUDFLARE_ZONE_NAME.test(name))
      throw new ToolKindError(
        `settings.zones contains "${String(entry).slice(0, 64)}" (zone names such as example.com)`,
      );
    if (seen.has(name)) throw new ToolKindError(`settings.zones contains duplicate "${name}"`);
    seen.add(name);
  }
  if (seen.size > MAX_CLOUDFLARE_ZONES)
    throw new ToolKindError(`settings.zones may name at most ${MAX_CLOUDFLARE_ZONES} zones`);
  return seen.size === 0 ? null : [...seen].sort();
}

/** Validates and normalizes an instance's kind, label, host and settings. */
export function validateToolInstance(input: {
  kind: unknown;
  label: unknown;
  host?: unknown;
  settings?: unknown;
}): ToolInstanceInput {
  if (!isToolKind(input.kind))
    throw new ToolKindError(`kind must be one of ${TOOL_KINDS.join(', ')}`);
  const kind = input.kind;
  const label = text(input.label ?? '', 'label');
  // eslint-disable-next-line no-control-regex -- intentional control-character rejection
  if (label.length === 0 || label.length > MAX_LABEL_CHARS || /[\u0000-\u001f\u007f]/.test(label))
    throw new ToolKindError(`label must be 1 to ${MAX_LABEL_CHARS} printable characters`);
  const settings = record(input.settings, 'settings');
  const hostRaw =
    input.host === undefined || input.host === null ? '' : text(input.host, 'host').toLowerCase();
  const requireHost = (pattern: RegExp, what: string): string => {
    if (!pattern.test(hostRaw)) throw new ToolKindError(`host must be ${what}`);
    return hostRaw;
  };
  const noHost = (): null => {
    if (hostRaw.length > 0) throw new ToolKindError(`a ${kind} instance takes no host`);
    return null;
  };
  switch (kind) {
    case 'gitlab':
      noUnknown(settings, [], 'settings');
      return {
        kind,
        label,
        host: requireHost(
          GITLAB_HOST,
          'a bare host name such as gitlab.example.com (optionally with :port)',
        ),
        settings: {},
      };
    case 'atlassian': {
      noUnknown(settings, ['cloudId', 'email', 'operations'], 'settings');
      const cloudId = text(settings.cloudId ?? '', 'settings.cloudId').toLowerCase();
      if (!CLOUD_ID.test(cloudId))
        throw new ToolKindError('settings.cloudId must be the site UUID');
      const email = text(settings.email ?? '', 'settings.email');
      if (!EMAIL.test(email))
        throw new ToolKindError('settings.email must be the token owner’s email');
      return {
        kind,
        label,
        host: requireHost(ATLASSIAN_SITE, 'an Atlassian Cloud site such as example.atlassian.net'),
        settings: {
          cloudId,
          email,
          operations: normalizeAtlassianOperationList(settings.operations),
        },
      };
    }
    case 'datadog': {
      noUnknown(settings, ['toolsets', 'denyTools'], 'settings');
      const toolsets = text(settings.toolsets ?? 'all', 'settings.toolsets') || 'all';
      if (!DATADOG_TOOLSETS.test(toolsets))
        throw new ToolKindError('settings.toolsets must be "all" or a comma list of toolsets');
      return {
        kind,
        label,
        host: requireHost(DATADOG_SITE, 'a commercial Datadog site such as datadoghq.eu'),
        settings: { toolsets, denyTools: normalizeDatadogDenyTools(settings.denyTools) },
      };
    }
    case 'cloudflare': {
      noUnknown(settings, ['accountId', 'zones'], 'settings');
      if (hostRaw.length > 0 && hostRaw !== CLOUDFLARE_API_HOST)
        throw new ToolKindError(`host must be ${CLOUDFLARE_API_HOST} (or be omitted)`);
      return {
        kind,
        label,
        host: CLOUDFLARE_API_HOST,
        settings: {
          accountId: normalizeCloudflareAccountId(settings.accountId),
          zones: normalizeCloudflareZones(settings.zones),
        },
      };
    }
    case 'slack': {
      noUnknown(settings, [], 'settings');
      if (hostRaw.length > 0 && hostRaw !== SLACK_API_HOST)
        throw new ToolKindError(`host must be ${SLACK_API_HOST} (or be omitted)`);
      return { kind, label, host: SLACK_API_HOST, settings: {} };
    }
    case 'files': {
      noUnknown(settings, ['readOnly'], 'settings');
      const readOnly = settings.readOnly ?? false;
      if (typeof readOnly !== 'boolean')
        throw new ToolKindError('settings.readOnly must be a boolean');
      return { kind, label, host: noHost(), settings: { readOnly } };
    }
    case 'webSearch':
    case 'webFetch':
    case 'codeMode':
    case 'localExec':
      noUnknown(settings, [], 'settings');
      return { kind, label, host: noHost(), settings: {} };
  }
}

// --- Credentials -------------------------------------------------------------------

/** Atlassian: one scoped read token per product; at least one. */
export interface AtlassianCredential {
  jira?: string;
  confluence?: string;
}

function token(value: unknown, where: string): string {
  const raw = text(value, where);
  // eslint-disable-next-line no-control-regex -- intentional control-character rejection
  if (raw.length < 8 || raw.length > 4096 || /[\s\u0000]/.test(raw))
    throw new ToolKindError(`${where} must be a token of 8 to 4096 characters without spaces`);
  return raw;
}

/**
 * Validates a credential for a kind and returns its stored form (a string;
 * Atlassian stores a JSON object). Kinds without a credential refuse one.
 */
export function validateToolCredential(kind: ToolKind, value: unknown): string {
  if (kind === 'slack')
    throw new ToolKindError(
      "a slack instance uses the workspace's bot token; it takes no credential",
    );
  if (!CREDENTIAL_KINDS.includes(kind))
    throw new ToolKindError(`a ${kind} instance takes no credential`);
  if (kind !== 'atlassian') return token(value, 'credential');
  const parsed = typeof value === 'string' ? parseJsonObject(value) : record(value, 'credential');
  noUnknown(parsed, ['jira', 'confluence'], 'credential');
  const result: AtlassianCredential = {};
  for (const product of ['jira', 'confluence'] as const) {
    const entry = parsed[product];
    if (entry === undefined || entry === null || entry === '') continue;
    result[product] = token(entry, `credential.${product}`);
  }
  if (result.jira === undefined && result.confluence === undefined)
    throw new ToolKindError('credential needs a Jira and/or a Confluence token');
  return JSON.stringify(result);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown, 'credential');
  } catch (err) {
    if (err instanceof ToolKindError) throw err;
    throw new ToolKindError('credential must be a JSON object with jira and/or confluence');
  }
}

/** Parses a stored Atlassian credential. */
export function parseAtlassianCredential(stored: string): AtlassianCredential {
  return JSON.parse(validateToolCredential('atlassian', stored)) as AtlassianCredential;
}

// --- Compiled channel assignment (document section `toolAssignments`) ---------------

/** One assigned instance as the agent and the runner see it: non-secret settings only. */
export interface AssignedTool {
  kind: ToolKind;
  instanceId: string;
  label: string;
  /** Bumped on every credential write; part of the run's policy hash. */
  credentialVersion: number;
  /** Latest runtime readiness (kinds without a runtime are always ready). */
  ready: boolean;
  /** Sanitized readiness detail when not ready. */
  detail: string | null;
  /** GitLab only: the host (clone/push transport and typed operations). */
  host?: string;
  /** Atlassian only: the effective operation allowlist (sorted). */
  operations?: string[];
  /** Datadog only: upstream tools removed from the catalog. */
  denyTools?: string[];
  /** Cloudflare only: the account the account-level datasets are limited to (null: none). */
  accountId?: string | null;
  /** Cloudflare only: the zone names exposed (null: every zone the token sees). */
  zones?: string[] | null;
  /** Task files only. */
  readOnly?: boolean;
}

export interface ChannelToolAssignment {
  teamId: string;
  channelId: string;
  /**
   * The channel's effective model key (channel choice, else the workspace
   * default); null runs the deployment default (`MODEL_DEFAULT_KEY`).
   * The agent pins it at a run's first claim; the runner uses the pinned model.
   */
  modelKey: string | null;
  /**
   * The channel's effective system prompt (channel prompt, else the
   * workspace prompt); null: the runner's fixed prompt alone. The runner
   * appends it after its fixed rules when it prepares a turn.
   */
  systemPrompt: string | null;
  /**
   * "Automatic thread replies": after the bot was mentioned in a
   * thread it answers clear follow-ups there without a mention. On unless
   * the channel saved it off; never at channel top level.
   */
  autoReplies: boolean;
  tools: AssignedTool[];
}

/**
 * Kinds whose readiness comes from a runtime probe; the others are ready when enabled.
 *
 * @public
 */
export function kindNeedsProbe(kind: ToolKind): boolean {
  return (CLI_RUNTIME_KINDS as readonly ToolKind[]).includes(kind);
}

/** Instance readiness reported by a runtime (`POST /internal/tool-instances/status`). */
export type ToolInstanceState = 'ready' | 'error' | 'blocked';
