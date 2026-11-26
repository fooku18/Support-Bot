/**
 * Compiles the admin tables into the configuration document the agent and the
 * adapter pull (D9). The v2 authorization policy uses enabled-channel grants
 * and exact blocked identities (support-agent-app/src/authorization-policy.ts). The second section, `toolAssignments`,
 * lists per enabled channel the assigned tool instances with their non-secret
 * settings and readiness, its effective model key and its effective system
 * prompt. Bot tokens and tool credentials never enter the document.
 */

import { createHash } from 'node:crypto';
import {
  AuthorizationPolicyError,
  parseAuthorizationPolicy,
} from './generated/authorization-policy.js';
import {
  ATLASSIAN_READ_OPERATIONS,
  kindNeedsProbe,
  MCP_KINDS,
  TOOL_KIND_CODES,
  TOOL_KINDS,
  type AssignedTool,
  type AtlassianSettings,
  type ChannelToolAssignment,
  type CloudflareSettings,
  type DatadogSettings,
  type FilesSettings,
  type ToolInstanceState,
  type ToolKind,
  type ToolSettings,
} from './generated/tool-kinds.js';

export interface TrustedBotSender {
  botId: string;
  userId: string;
  channelId: string;
}

export interface InstallationRow {
  teamId: string;
  teamName: string;
  botUserId: string;
  botId: string;
  status: 'pending' | 'whitelisted' | 'disabled';
  trustedBotSender: TrustedBotSender | null;
  /** Last OAuth install; a reinstall (new bot token) changes the document. */
  installedAt?: number | null;
}

export interface ChannelRow {
  teamId: string;
  channelId: string;
  enabled: boolean;
}

/** An exact blocked identity, retained even while its channel is disabled. */
export interface BlockedMemberRow {
  teamId: string;
  channelId: string;
  userId: string;
}

export interface CompiledInstallation {
  teamId: string;
  teamName: string;
  botUserId: string;
  botId: string;
  trustedBotSender: TrustedBotSender | null;
  /** Consumers refetch the bot token when this changes. */
  installedAt: number | null;
}

/** A stored tool instance without its credential (the compiler never sees a secret). */
export interface ToolInstanceRow {
  id: string;
  teamId: string;
  kind: ToolKind;
  label: string;
  host: string | null;
  settings: ToolSettings;
  hasCredential: boolean;
  credentialVersion: number;
  status: 'enabled' | 'disabled';
}

/** The latest readiness a runtime reported for an instance. */
export interface ToolStatusRow {
  instanceId: string;
  state: ToolInstanceState;
  detail: string;
  toolsCount: number | null;
  /** The credential version the runtime probed. */
  credentialVersion: number;
  reporter: string;
  reportedAt: number;
}

export interface ChannelToolRow {
  teamId: string;
  channelId: string;
  kind: ToolKind;
  instanceId: string;
}

/** An admin model choice: a channel's, or with `channelId` null the workspace default. */
export interface ModelAssignmentRow {
  teamId: string;
  channelId: string | null;
  modelKey: string;
}

/** a channel's saved "Automatic thread replies" choice. */
export interface ReplySettingRow {
  teamId: string;
  channelId: string;
  autoReplies: boolean;
}

/** An admin channel prompt: a channel's, or with `channelId` null the workspace default. */
export interface PromptAssignmentRow {
  teamId: string;
  channelId: string | null;
  text: string;
}

export interface CompileRows {
  installations: InstallationRow[];
  channels: ChannelRow[];
  blockedMembers: BlockedMemberRow[];
  toolInstances?: ToolInstanceRow[];
  toolStatuses?: ToolStatusRow[];
  channelTools?: ChannelToolRow[];
  modelAssignments?: ModelAssignmentRow[];
  promptAssignments?: PromptAssignmentRow[];
  /** channels that saved "Automatic thread replies" (absent: on). */
  replySettings?: ReplySettingRow[];
}

export interface CompiledDocument {
  version: number;
  hash: string;
  installations: CompiledInstallation[];
  authorizationPolicy: Record<string, unknown>;
  toolAssignments: ChannelToolAssignment[];
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

// Limits of parseAuthorizationPolicy in the agent: exceeding them would produce
// a document the agent refuses, so the mutation is rejected here instead.
const MAX_POLICY_BYTES = 65_536;
const MAX_BINDINGS = 256;

const MAX_ROLES = 64;

const TASK_ACTIONS = ['task.start', 'task.read', 'task.steer', 'task.cancel'];

/** The policy role of a channel without assigned tools. */
const BASE_ROLE = 'user';

/**
 * There is one kind of user; roles exist only to carry a channel's tool set
 * to the agent's `tool.use`/`mcp.use` check. One role is generated per distinct
 * set of assigned tool kinds (D6): the base role `user` grants task actions
 * and skills only; a channel whose enabled assigned instances have kinds K
 * binds `user-<codes>`, which adds `tool.use` for exactly those kinds and
 * `mcp.use` for the MCP kinds among them. The agent's role pattern
 * (`[a-z][a-z0-9-]*`) rules out per-channel names such as `user@C…`.
 * Readiness never changes the policy, so a flapping probe cannot churn it.
 */
export function policyRoleName(kinds: readonly ToolKind[]): string {
  const ordered = TOOL_KINDS.filter((kind) => kinds.includes(kind));
  return ordered.length === 0
    ? BASE_ROLE
    : `${BASE_ROLE}-${ordered.map((kind) => TOOL_KIND_CODES[kind]).join('-')}`;
}

export function policyRole(kinds: readonly ToolKind[]): Record<string, unknown> {
  const ordered = TOOL_KINDS.filter((kind) => kinds.includes(kind));
  const mcp = ordered.filter((kind) => MCP_KINDS.includes(kind));
  const grants: Array<Record<string, unknown>> = [
    { actions: TASK_ACTIONS },
    { actions: ['skill.use'], resourceType: 'skill', resources: ['*'] },
  ];
  if (ordered.length > 0)
    grants.push({ actions: ['tool.use'], resourceType: 'tool', resources: ordered });
  if (mcp.length > 0) grants.push({ actions: ['mcp.use'], resourceType: 'mcp', resources: mcp });
  return { grants };
}

/** A user ID Slack never issues: bindings for it grant nobody anything. */
const NO_USER = 'U0';

/**
 * The policy contract needs at least one binding. With nothing configured the
 * document binds a workspace ID Slack never issues, so every request still
 * falls through to the default deny.
 */
export const DENY_ALL_BINDING = {
  workspace: 'T0',
  channels: ['C0'],
  users: [NO_USER],
  roles: [BASE_ROLE],
};

/** Readiness detail of a stored web search row of the retired provider shape (plan D9). */
export const LEGACY_WEB_SEARCH_DETAIL = 'legacy search-provider instance: delete and recreate it';

/**
 * A `webSearch` row with a credential or any settings key predates the
 * credential-free kind (search runs within the selected model provider). Stored rows are
 * not re-validated, so such a row is never ready: no migration, fail closed.
 */
export function isLegacyWebSearch(
  instance: Pick<ToolInstanceRow, 'kind' | 'hasCredential' | 'settings'>,
): boolean {
  return (
    instance.kind === 'webSearch' &&
    (instance.hasCredential ||
      (instance.settings !== null &&
        typeof instance.settings === 'object' &&
        Object.keys(instance.settings).length > 0))
  );
}

/**
 * Readiness of one instance as the document and the UI show it: kinds
 * without a runtime probe are ready when enabled; the others need a
 * credential and a `ready` report for the current credential version.
 */
export function toolReadiness(
  instance: Pick<
    ToolInstanceRow,
    'kind' | 'hasCredential' | 'credentialVersion' | 'status' | 'settings'
  >,
  status: Pick<ToolStatusRow, 'state' | 'detail' | 'credentialVersion'> | undefined,
): { ready: boolean; detail: string | null } {
  if (instance.status !== 'enabled') return { ready: false, detail: 'instance disabled' };
  if (isLegacyWebSearch(instance)) return { ready: false, detail: LEGACY_WEB_SEARCH_DETAIL };
  if (!kindNeedsProbe(instance.kind)) return { ready: true, detail: null };
  if (!instance.hasCredential) return { ready: false, detail: 'no credential' };
  if (status === undefined || status.credentialVersion !== instance.credentialVersion)
    return { ready: false, detail: 'waiting for runtime readiness' };
  if (status.state === 'ready') return { ready: true, detail: null };
  return { ready: false, detail: status.detail || status.state };
}

function assignedTool(instance: ToolInstanceRow, status: ToolStatusRow | undefined): AssignedTool {
  const { ready, detail } = toolReadiness(instance, status);
  const tool: AssignedTool = {
    kind: instance.kind,
    instanceId: instance.id,
    label: instance.label,
    credentialVersion: instance.credentialVersion,
    ready,
    detail,
  };
  // Only the non-secret settings the runner needs: never a cloud ID, email,
  // endpoint or toolset list (those stay with the runtimes).
  switch (instance.kind) {
    case 'gitlab':
      tool.host = instance.host ?? '';
      break;
    case 'atlassian': {
      const operations = (instance.settings as AtlassianSettings).operations;
      tool.operations = [...(operations ?? ATLASSIAN_READ_OPERATIONS)].sort();
      break;
    }
    case 'datadog':
      tool.denyTools = [...(instance.settings as DatadogSettings).denyTools];
      break;
    case 'cloudflare': {
      const settings = instance.settings as CloudflareSettings;
      tool.accountId = settings.accountId;
      tool.zones = settings.zones === null ? null : [...settings.zones];
      break;
    }
    case 'files':
      tool.readOnly = (instance.settings as FilesSettings).readOnly;
      break;
    default:
      break;
  }
  return tool;
}

export function compileDocument(version: number, rows: CompileRows): CompiledDocument {
  const whitelisted = rows.installations
    .filter((row) => row.status === 'whitelisted')
    .sort((a, b) => a.teamId.localeCompare(b.teamId));
  const teams = new Set(whitelisted.map((row) => row.teamId));
  const enabledChannels = rows.channels
    .filter((row) => row.enabled && teams.has(row.teamId))
    .sort((a, b) => a.teamId.localeCompare(b.teamId) || a.channelId.localeCompare(b.channelId));
  const enabled = new Set(enabledChannels.map((row) => `${row.teamId}/${row.channelId}`));

  // Tool assignments per enabled channel: enabled instances of the channel's
  // own workspace only, in TOOL_KINDS order.
  const instances = new Map((rows.toolInstances ?? []).map((row) => [row.id, row]));
  const statuses = new Map((rows.toolStatuses ?? []).map((row) => [row.instanceId, row]));
  // Channel choice, else workspace default, else null (deployment default).
  // Keys are stored as chosen: one the operator later removed from
  // MODEL_CATALOG still compiles, and the agent refuses new work until it is corrected.
  const models = new Map(
    (rows.modelAssignments ?? []).map((row) => [
      row.channelId === null ? row.teamId : `${row.teamId}/${row.channelId}`,
      row.modelKey,
    ]),
  );
  // Channel prompt replaces the workspace prompt; neither: null (D1, D2).
  const prompts = new Map(
    (rows.promptAssignments ?? []).map((row) => [
      row.channelId === null ? row.teamId : `${row.teamId}/${row.channelId}`,
      row.text,
    ]),
  );
  const replies = new Map(
    (rows.replySettings ?? []).map((row) => [`${row.teamId}/${row.channelId}`, row.autoReplies]),
  );
  const assigned = new Map<string, ToolInstanceRow[]>();
  for (const row of rows.channelTools ?? []) {
    const key = `${row.teamId}/${row.channelId}`;
    const instance = instances.get(row.instanceId);
    if (!enabled.has(key) || instance === undefined) continue;
    if (instance.status !== 'enabled' || instance.teamId !== row.teamId) continue;
    if (instance.kind !== row.kind) continue;
    assigned.set(key, [...(assigned.get(key) ?? []), instance]);
  }
  const kindOrder = (kind: ToolKind): number => TOOL_KINDS.indexOf(kind);
  const toolAssignments: ChannelToolAssignment[] = enabledChannels.map((row) => {
    const key = `${row.teamId}/${row.channelId}`;
    const tools = [...(assigned.get(key) ?? [])]
      .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind))
      .map((instance) => assignedTool(instance, statuses.get(instance.id)));
    return {
      teamId: row.teamId,
      channelId: row.channelId,
      modelKey: models.get(key) ?? models.get(row.teamId) ?? null,
      systemPrompt: prompts.get(key) ?? prompts.get(row.teamId) ?? null,
      autoReplies: replies.get(key) ?? true,
      tools,
    };
  });
  const channelKinds = new Map(
    toolAssignments.map((row) => [
      `${row.teamId}/${row.channelId}`,
      row.tools.map((tool) => tool.kind),
    ]),
  );

  const blocked = rows.blockedMembers
    .map((member) => ({
      workspace: member.teamId,
      channel: member.channelId,
      user: member.userId,
    }))
    .sort((a, b) =>
      `${a.workspace}/${a.channel}/${a.user}`.localeCompare(
        `${b.workspace}/${b.channel}/${b.user}`,
      ),
    );
  const bindings: Array<Record<string, unknown>> = [];
  const roles: Record<string, Record<string, unknown>> = { [BASE_ROLE]: policyRole([]) };
  const bindRole = (key: string): string => {
    const kinds = channelKinds.get(key) ?? [];
    const name = policyRoleName(kinds);
    roles[name] ??= policyRole(kinds);
    return name;
  };
  for (const key of [...enabled].sort()) {
    const [workspace, channel] = key.split('/') as [string, string];
    bindings.push({ workspace, channels: [channel], users: ['*'], roles: [bindRole(key)] });
  }
  if (bindings.length > MAX_BINDINGS) {
    throw new CompileError(
      `the configuration needs ${bindings.length} policy bindings; the agent accepts at most ${MAX_BINDINGS}`,
    );
  }
  const roleCount = Object.keys(roles).length;
  if (roleCount > MAX_ROLES) {
    throw new CompileError(
      `the configuration needs ${roleCount} policy roles (one policy role per distinct set of assigned tool kinds); the agent accepts at most ${MAX_ROLES}. Use fewer distinct tool combinations across channels.`,
    );
  }
  const sortedRoles = Object.fromEntries(
    Object.keys(roles)
      .sort()
      .map((name) => [name, roles[name]]),
  );
  const authorizationPolicy = {
    version: 2,
    blocked,
    policyId: `admin-v${version}`,
    defaults: { decision: 'deny' },
    roles: sortedRoles,
    bindings: bindings.length > 0 ? bindings : [DENY_ALL_BINDING],
  };
  if (Buffer.byteLength(JSON.stringify(authorizationPolicy)) > MAX_POLICY_BYTES) {
    throw new CompileError(`the compiled policy exceeds ${MAX_POLICY_BYTES} bytes`);
  }
  // The agent's own parser (a generated verbatim copy): a document the agent would
  // refuse is never stored, so the mutation that produced it rolls back.
  try {
    parseAuthorizationPolicy(JSON.stringify(authorizationPolicy));
  } catch (err) {
    if (err instanceof AuthorizationPolicyError) {
      throw new CompileError(`the agent would refuse the compiled policy: ${err.message}`);
    }
    throw err;
  }
  const installations: CompiledInstallation[] = whitelisted.map((row) => ({
    teamId: row.teamId,
    teamName: row.teamName,
    botUserId: row.botUserId,
    botId: row.botId,
    trustedBotSender: row.trustedBotSender,
    installedAt: row.installedAt ?? null,
  }));
  const body = {
    version,
    installations,
    authorizationPolicy,
    toolAssignments,
  };
  return { ...body, hash: documentHash(body) };
}

/**
 * Content hash of everything but the version, so a no-op mutation keeps the
 * document; tool assignments (including readiness) are part of the content.
 */
export function contentHash(document: {
  installations: CompiledInstallation[];
  authorizationPolicy: Record<string, unknown>;
  toolAssignments?: ChannelToolAssignment[];
}): string {
  const policy = { ...document.authorizationPolicy, policyId: undefined };
  return sha256(
    JSON.stringify({
      installations: document.installations,
      policy,
      toolAssignments: document.toolAssignments ?? [],
    }),
  );
}

function documentHash(body: {
  version: number;
  installations: CompiledInstallation[];
  authorizationPolicy: Record<string, unknown>;
  toolAssignments: ChannelToolAssignment[];
}): string {
  return sha256(JSON.stringify(body));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
