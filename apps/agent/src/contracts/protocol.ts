/** Shared task identity and private service wire vocabulary. */

export const TASK_KEY_VERSION = 'v1';

/**
 * Version of the coordinator DTO/client contract (dto.ts plus the status
 * types in this file). The adapter and runner vendor this contract into
 * `src/generated/protocol.ts` via `npm run generate:protocol`; the
 * contract test fails when the generated mirrors drift. Bump together with
 * any incompatible DTO change and regenerate.
 */
export const PROTOCOL_VERSION = 30;

/** Slack IDs (team/channel/bot/user) are uppercase alphanumerics. */
const SLACK_ID_PATTERN = /^[A-Z0-9]+$/;

/** Slack message timestamps are `<seconds>.<fraction>`, digits only. */
const SLACK_TS_PATTERN = /^[0-9]+\.[0-9]+$/;

/** A cell scope: non-empty ASCII alphanumerics plus `_ - . : $`. */
const CELL_SCOPE_PATTERN = /^[A-Za-z0-9_.:$-]+$/;

export class TaskKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskKeyError';
  }
}

export interface TaskIdentity {
  installationId: string;
  teamId: string;
  channelId: string;
  rootTs: string;
}

export function validateSlackId(value: string, name: string): void {
  if (!SLACK_ID_PATTERN.test(value)) {
    throw new TaskKeyError(`${name} must be a Slack ID of uppercase letters and digits`);
  }
}

export function validateSlackTs(value: string, name: string): void {
  if (!SLACK_TS_PATTERN.test(value)) {
    throw new TaskKeyError(`${name} must be a Slack message timestamp like "1716234567.123456"`);
  }
}

/**
 * Builds the versioned canonical task key and validates every component.
 * Throws TaskKeyError with a sanitized message when a component is malformed.
 */
export function buildTaskKey(identity: TaskIdentity): string {
  validateSlackId(identity.installationId, 'installationId');
  validateSlackId(identity.teamId, 'teamId');
  validateSlackId(identity.channelId, 'channelId');
  validateSlackTs(identity.rootTs, 'rootTs');
  const key = [
    TASK_KEY_VERSION,
    identity.installationId,
    identity.teamId,
    identity.channelId,
    identity.rootTs,
  ].join(':');
  if (!CELL_SCOPE_PATTERN.test(key) || key.length > 255) {
    throw new TaskKeyError('composed task key is not a valid cell name');
  }
  return key;
}

/**
 * Parses a task key back into its components. Returns undefined for keys of
 * an unknown version so callers can ignore foreign rows instead of crashing.
 */
export function parseTaskKey(taskKey: string): TaskIdentity | undefined {
  const parts = taskKey.split(':');
  if (parts.length !== 5 || parts[0] !== TASK_KEY_VERSION) {
    return undefined;
  }
  const [, installationId, teamId, channelId, rootTs] = parts;
  if (
    installationId === undefined ||
    teamId === undefined ||
    channelId === undefined ||
    rootTs === undefined
  ) {
    return undefined;
  }
  return { installationId, teamId, channelId, rootTs };
}

/**
 * Short, stable, human-usable task identifier used in Slack replies and
 * sanitized logs: `<channelId>:<rootTs>`. It contains no message text.
 */
export function displayTaskId(taskKey: string): string {
  const identity = parseTaskKey(taskKey);
  return identity === undefined ? 'unknown-task' : `${identity.channelId}:${identity.rootTs}`;
}

/**
 * Compares two Slack timestamps numerically: seconds first, then the fraction
 * padded to equal width (Slack fraction widths can vary). Never compares them
 * as plain strings, because "1000.1" sorts before "999.9" lexicographically.
 */
export function compareTs(a: string, b: string): number {
  const [aSec, aFrac] = splitTs(a);
  const [bSec, bFrac] = splitTs(b);
  const aSeconds = Number.parseInt(aSec, 10);
  const bSeconds = Number.parseInt(bSec, 10);
  if (aSeconds !== bSeconds) {
    return aSeconds < bSeconds ? -1 : 1;
  }
  // Fractions are digit strings; equal-width string comparison is numeric.
  const width = Math.max(aFrac.length, bFrac.length);
  const af = aFrac.padEnd(width, '0');
  const bf = bFrac.padEnd(width, '0');
  if (af === bf) {
    return 0;
  }
  return af < bf ? -1 : 1;
}

function splitTs(ts: string): [string, string] {
  const dot = ts.indexOf('.');
  if (dot < 0) {
    return [ts, ''];
  }
  return [ts.slice(0, dot), ts.slice(dot + 1)];
}

/** Stable per-message identity: the channel plus the message timestamp. */
export function messageId(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

export interface IncomingThreadMessage {
  ts: string;
  userId?: string | null;
  botId?: string | null;
  authorName?: string | null;
  text?: string | null;
  editedTs?: string | null;
}

export interface StoredThreadMessage {
  messageId: string;
  ts: string;
  /** A person's message (the trusted bot sender included). */
  userId: string | null;
  /** Another bot's or app's post, with its display name. */
  botId: string | null;
  authorName: string | null;
  text: string | null;
  edited: boolean;
}

/**
 * Merges a fetched history page into the current merged message set.
 * - Deduplicates by message identity (never appends duplicates).
 * - An edit (Slack `edited.ts`) updates the stored text in place.
 * - Messages above `boundTs` (a later mention's trigger timestamp) are
 *   dropped, so later mentions never become earlier-run instructions.
 * - Messages without an author (neither `userId` nor `botId`) are skipped;
 *   the adapter never supplies this app's own posts.
 * Returns the merged set sorted oldest-first plus the edit count observed.
 */
export function mergeThreadMessages(
  previous: readonly StoredThreadMessage[],
  incoming: readonly IncomingThreadMessage[],
  options: { channelId: string; boundTs?: string },
): {
  merged: StoredThreadMessage[];
  edits: number;
  skippedAboveBound: number;
  skippedUnattributed: number;
} {
  const byId = new Map<string, StoredThreadMessage>();
  for (const message of previous) {
    if (options.boundTs !== undefined && compareTs(message.ts, options.boundTs) > 0) continue;
    byId.set(message.messageId, { ...message });
  }
  let edits = 0;
  let skippedAboveBound = 0;
  let skippedUnattributed = 0;
  for (const message of incoming) {
    if (typeof message.ts !== 'string' || !SLACK_TS_PATTERN.test(message.ts)) {
      continue;
    }
    if (options.boundTs !== undefined && compareTs(message.ts, options.boundTs) > 0) {
      skippedAboveBound += 1;
      continue;
    }
    const userId = nonEmpty(message.userId);
    const botId = userId === null ? nonEmpty(message.botId) : null;
    if (userId === null && botId === null) {
      skippedUnattributed += 1;
      continue;
    }
    const id = messageId(options.channelId, message.ts);
    const edited = message.editedTs !== undefined && message.editedTs !== null;
    const stored: StoredThreadMessage = {
      messageId: id,
      ts: message.ts,
      userId,
      botId,
      authorName: botId === null ? null : (nonEmpty(message.authorName) ?? botId),
      text: message.text ?? null,
      edited,
    };
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, stored);
    } else if (edited || existing.text === null) {
      // Refresh text only when we actually observed an edit or had nothing.
      if (stored.text !== existing.text || edited !== existing.edited) {
        edits += 1;
      }
      byId.set(id, stored);
    }
  }
  const merged = [...byId.values()].sort((a, b) => compareTs(a.ts, b.ts));
  return { merged, edits, skippedAboveBound, skippedUnattributed };
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const CONTEXT_STATUS_COMPLETE = 'complete';

export const CONTEXT_STATUS_TRUNCATED = 'truncated';

export type ContextStatus = typeof CONTEXT_STATUS_COMPLETE | typeof CONTEXT_STATUS_TRUNCATED;

export const RUN_STATUS_AWAITING_CONTEXT = 'awaiting_context';

export const RUN_STATUS_QUEUED = 'queued';

export const RUN_STATUS_RUNNING = 'running';

export const RUN_STATUS_CANCELLING = 'cancelling';

export const RUN_STATUS_CANCELLED = 'cancelled';

export const RUN_STATUS_COMPLETED = 'completed';

export const RUN_STATUS_FAILED = 'failed';

/**
 * A coding run that crossed a soft run limit and got no answer within the
 * pause wait: not a failure. Its session and position are kept, it holds no
 * capacity, and its requester may still continue it (back to `queued`) or
 * cancel it until the thread expires.
 */
export const RUN_STATUS_PAUSED = 'paused';

export type RunStatus =
  | typeof RUN_STATUS_AWAITING_CONTEXT
  | typeof RUN_STATUS_QUEUED
  | typeof RUN_STATUS_RUNNING
  | typeof RUN_STATUS_CANCELLING
  | typeof RUN_STATUS_CANCELLED
  | typeof RUN_STATUS_COMPLETED
  | typeof RUN_STATUS_FAILED
  | typeof RUN_STATUS_PAUSED;

export const OUTBOX_STATE_PENDING = 'pending';

export const OUTBOX_STATE_DELIVERING = 'delivering';

export const OUTBOX_STATE_SETTLED = 'settled';

export const OUTBOX_STATE_DELIVERED = 'delivered';

export const OUTBOX_STATE_UNCERTAIN = 'uncertain';

export type OutboxState =
  | typeof OUTBOX_STATE_PENDING
  | typeof OUTBOX_STATE_DELIVERING
  | typeof OUTBOX_STATE_SETTLED
  | typeof OUTBOX_STATE_DELIVERED
  | typeof OUTBOX_STATE_UNCERTAIN;

/**
 * Provider-neutral agent progress vocabulary (typed-agent-events plan).
 * Closed enums only — never arbitrary provider strings, model prose, tool
 * arguments, paths, or error text. The agent renders these into fixed Slack text.
 */
export const AGENT_PROGRESS_STAGES = [
  'starting',
  'model_working',
  'inspecting',
  'editing',
  'calling_service',
  'verifying',
  'repairing',
  'publishing',
  'retrying',
  'recovering',
  'paused_soft_limit',
] as const;

export type AgentProgressStage = (typeof AGENT_PROGRESS_STAGES)[number];

export const AGENT_TOOL_CATEGORIES = [
  'files_read',
  'files_write',
  'local_command',
  'gitlab',
  'atlassian',
  'datadog',
  'cloudflare',
  'slack',
  'web',
  'other_approved',
] as const;

export type AgentToolCategory = (typeof AGENT_TOOL_CATEGORIES)[number];

export const AGENT_PROGRESS_SOURCES = ['provider', 'controller'] as const;

export type AgentProgressSource = (typeof AGENT_PROGRESS_SOURCES)[number];

export function isAgentProgressStage(value: unknown): value is AgentProgressStage {
  return typeof value === 'string' && (AGENT_PROGRESS_STAGES as readonly string[]).includes(value);
}

export function isAgentToolCategory(value: unknown): value is AgentToolCategory {
  return typeof value === 'string' && (AGENT_TOOL_CATEGORIES as readonly string[]).includes(value);
}

export function isAgentProgressSource(value: unknown): value is AgentProgressSource {
  return typeof value === 'string' && (AGENT_PROGRESS_SOURCES as readonly string[]).includes(value);
}

/**
 * Soft limits of a coding run: tool calls, estimated cost (USD) and active
 * time (ms, pauses excluded). Crossing one pauses the run.
 */
export const SOFT_LIMIT_METRICS = ['tool_calls', 'cost_usd', 'active_time'] as const;

export type SoftLimitMetric = (typeof SOFT_LIMIT_METRICS)[number];

export function isSoftLimitMetric(value: unknown): value is SoftLimitMetric {
  return typeof value === 'string' && (SOFT_LIMIT_METRICS as readonly string[]).includes(value);
}

/** One soft-limit metric as the run message shows it: its current value and limit. */
export interface SoftLimitReading {
  metric: SoftLimitMetric;
  value: number;
  limit: number;
}

/**
 * Durable Slack control commands (explicit `update:` steering and `cancel`).
 * One row per accepted Slack event; `accepted` (durably recorded) and
 * `applied` (provider evidence observed) are distinct states, never one
 * boolean.
 */
export const CONTROL_KIND_STEER = 'steer';

export const CONTROL_KIND_CANCEL = 'cancel';

export type ControlKind = typeof CONTROL_KIND_STEER | typeof CONTROL_KIND_CANCEL;

export const CONTROL_STATE_PENDING = 'pending';

export const CONTROL_STATE_DISPATCHING = 'dispatching';

export const CONTROL_STATE_APPLIED = 'applied';

export const CONTROL_STATE_UNCERTAIN = 'uncertain';

export const CONTROL_STATE_SUPERSEDED = 'superseded';

export const CONTROL_STATE_CONVERTED = 'converted';

export const CONTROL_STATE_REJECTED = 'rejected';

export type ControlState =
  | typeof CONTROL_STATE_PENDING
  | typeof CONTROL_STATE_DISPATCHING
  | typeof CONTROL_STATE_APPLIED
  | typeof CONTROL_STATE_UNCERTAIN
  | typeof CONTROL_STATE_SUPERSEDED
  | typeof CONTROL_STATE_CONVERTED
  | typeof CONTROL_STATE_REJECTED;

/** Cancel controls reuse the same states: pending=requested, dispatching=stopping, applied=confirmed. */
export function isTerminalControlState(state: ControlState): boolean {
  return (
    state === CONTROL_STATE_APPLIED ||
    state === CONTROL_STATE_UNCERTAIN ||
    state === CONTROL_STATE_SUPERSEDED ||
    state === CONTROL_STATE_CONVERTED ||
    state === CONTROL_STATE_REJECTED
  );
}

/** Whether steering input may still be routed to a run. */
export const STEERING_CLOSED = 'closed';

export const STEERING_OPEN = 'open';

export const STEERING_DRAINING = 'draining';

export type SteeringState =
  | typeof STEERING_CLOSED
  | typeof STEERING_OPEN
  | typeof STEERING_DRAINING;

/** Categorical cancellation evidence; never carries provider internals. */
export const CANCELLATION_CONFIRMED = 'confirmed';

export const CANCELLATION_PROVIDER_UNCONFIRMED = 'provider_unconfirmed';

export const CANCELLATION_EFFECTS_UNCERTAIN = 'effects_uncertain';

export const CANCELLATION_LEASE_EXPIRED = 'lease_expired';

/**
 * A queued follow-up run its author turned into steering of the active run
 * (ephemeral *Steer the current run*). Withdrawn silently: the thread gets
 * no cancellation reply, the steering receipts tell what happened.
 */
export const CANCELLATION_CONVERTED_TO_STEERING = 'converted_to_steering';

export type CancellationOutcome =
  | typeof CANCELLATION_CONFIRMED
  | typeof CANCELLATION_PROVIDER_UNCONFIRMED
  | typeof CANCELLATION_EFFECTS_UNCERTAIN
  | typeof CANCELLATION_LEASE_EXPIRED
  | typeof CANCELLATION_CONVERTED_TO_STEERING;

/** Machine-readable routing outcome for one accepted Slack event. */
export const INTAKE_ROUTING_RUN = 'run';

export const INTAKE_ROUTING_STEERING = 'steering';

export const INTAKE_ROUTING_CANCEL = 'cancel';

export const INTAKE_ROUTING_REJECTED = 'rejected';

export const INTAKE_ROUTING_NO_ACTIVE_RUN = 'no_active_run';

export const INTAKE_ROUTING_QUEUED_FOLLOWUP = 'queued_followup';

export const INTAKE_ROUTING_INVALID = 'invalid';

export const INTAKE_ROUTING_BUSY = 'busy';

export type IntakeRouting =
  | typeof INTAKE_ROUTING_RUN
  | typeof INTAKE_ROUTING_STEERING
  | typeof INTAKE_ROUTING_CANCEL
  | typeof INTAKE_ROUTING_REJECTED
  | typeof INTAKE_ROUTING_NO_ACTIVE_RUN
  | typeof INTAKE_ROUTING_QUEUED_FOLLOWUP
  | typeof INTAKE_ROUTING_INVALID
  | typeof INTAKE_ROUTING_BUSY;

/**
 * Which admission scope refused new work. A coordinator-wide `global` cap
 * is distinct from the per-workspace, per-actor and per-thread limits.
 */
export type AdmissionScope = 'thread' | 'actor' | 'workspace' | 'global';

/**
 * Upper bound of an admin channel system prompt in UTF-16 code units; same
 * bound as the admin service (`apps/admin/src/prompts.ts`).
 */
export const MAX_CHANNEL_PROMPT_CHARS = 4_000;

/** Operator model allowlist keys: lowercase, bounded, `default` reserved. */
export const MODEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * Interactive controls rendered as buttons under an outbox message. A run's
 * progress message carries `run_cancel` (red "Cancel") while the run is queued or running; terminal
 * texts and the cancelling state drop it. A run paused at a soft limit
 * carries `run_paused`: green "Continue" next to the red "Cancel". An open
 * clarification question carries `question_cancel`: the owner's red
 * "Cancel" for the waiting task. `replies_resume`: the "Resume
 * replies" button under the notice that automatic thread replies were paused.
 */
export const OUTBOX_ACTIONS = [
  'run_cancel',
  'run_paused',
  'question_cancel',
  'replies_resume',
] as const;

export type OutboxAction = (typeof OUTBOX_ACTIONS)[number];

/** Narrows an untrusted stored or transported value to a known outbox action. */
export function isOutboxAction(value: unknown): value is OutboxAction {
  return typeof value === 'string' && (OUTBOX_ACTIONS as readonly string[]).includes(value);
}

/**
 * The registry summary a task cell publishes: pending-work counters that let
 * pollers discover work after any restart without scanning every cell.
 */
export interface TaskSummary {
  /** Runs awaiting context acquisition. */
  ctx: number;
  /** Runs queued for execution. */
  queued: number;
  /** Runs currently claimed by a runner. */
  running: number;
  /** Outbox operations pending delivery (pending, delivering, or uncertain). */
  outbox: number;
  /** Thread replies waiting for intent classification. */
  replies: number;
}

export const EMPTY_TASK_SUMMARY: TaskSummary = {
  ctx: 0,
  queued: 0,
  running: 0,
  outbox: 0,
  replies: 0,
};

export function encodeSummary(summary: TaskSummary): string {
  return JSON.stringify(summary);
}

export function decodeSummary(raw: string | null | undefined): TaskSummary {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ...EMPTY_TASK_SUMMARY };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...EMPTY_TASK_SUMMARY };
    }
    const candidate = parsed as Record<string, unknown>;
    const numberOrZero = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    return {
      ctx: numberOrZero(candidate.ctx),
      queued: numberOrZero(candidate.queued),
      running: numberOrZero(candidate.running),
      outbox: numberOrZero(candidate.outbox),
      replies: numberOrZero(candidate.replies),
    };
  } catch {
    return { ...EMPTY_TASK_SUMMARY };
  }
}

export type PendingFlag = 'ctx' | 'queued' | 'outbox';

export function summaryHasPending(summary: TaskSummary, pending: readonly PendingFlag[]): boolean {
  return pending.some((flag) => {
    switch (flag) {
      case 'ctx':
        return summary.ctx > 0;
      case 'queued':
        return summary.queued > 0 || summary.running > 0;
      case 'outbox':
        return summary.outbox > 0;
    }
  });
}

/**
 * Short, actionable Claude failure categories for Slack/outbox and inspection.
 * Raw provider exceptions, request bodies, secrets, and transcripts must never
 * be forwarded; callers map internal errors to one of these first.
 */
export const CLAUDE_FAILURE_CATEGORIES = [
  'provider_auth',
  'model_unavailable',
  'timeout',
  'context_limit',
  'output_limit',
  'invalid_response',
  'transient',
  'interrupted',
  'budget_exhausted',
  'config',
  'authorization_denied',
  'storage_pressure',
  'verification_failed',
  'needs_recovery',
  'publication_failed',
  'turn_limit',
  'retention_expired',
] as const;

export type ClaudeFailureCategory = (typeof CLAUDE_FAILURE_CATEGORIES)[number];

export function isClaudeFailureCategory(value: unknown): value is ClaudeFailureCategory {
  return (
    typeof value === 'string' && (CLAUDE_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Fixed run failure reasons: the runner's and the agent's own
 * reason strings, never provider, model, Slack or repository text. A failed
 * run's reason is reported only when it is one of these; anything else is
 * `other`. Changing a reason string at its call site
 * without updating this table only degrades it to `other`.
 */
export const RUN_FAILURE_REASONS = [
  'claimed channel memory is missing or corrupt',
  'submission memory pin does not match the claimed run',
  // Publication and tool receipts.
  'submission journal is corrupt; preserve assets and request recovery',
  'submission journal identity is missing or inconsistent',
  'skills directory is invalid; recovery cannot proceed with a changed skill grant',
  'persisted skills exist but no operator skills directory is configured; recovery cannot change a saved grant',
  'a persisted skill is disabled or removed in the current configuration; recovery cannot expand or change a saved grant',
  'operator skills source changed during this run; recovery cannot replay a prepared prompt with a different bundle',
  'effective skill snapshot changed during this run; recovery cannot replay a prepared prompt with a different bundle',
  'effective skill snapshot cannot be recreated; recovery cannot proceed with a changed skill grant',
  'persisted capability grant differs from the current configuration; recovery cannot expand or change a saved grant',
  'Atlassian site/credential binding changed during this run',
  'Datadog site/catalog/credential binding changed during this run',
  'Cloudflare endpoint/zone/credential binding changed during this run',
  'Slack endpoint/workspace/credential binding changed during this run',
  'coding turn stopped at a configured limit',
  'provider failed at a model request',
  'provider denied account access',
  'parked run was claimed without its Continue',
  'Soft-limit pause could not protect the retained workspace',
  'Clarification turn ended incomplete; retained intent is not a completed question',
  'prompt submission is ambiguous after interruption; no prompt replay',
  'reserved invocation journal is missing; no prompt replay',
  'skills directory is invalid',
  'skill authorization failed',
  'skill snapshot failed',
  'context delivery snapshot is missing; no context silently dropped',
  'claimed context cannot be represented without dropping requested messages',
  'coding context exceeds the configured limit',
  'native session transcript is missing or corrupt',
  'SDK invocation stopped at a configured limit',
  'steering continuation outcome is unknown; no automatic replay',
  'confirmed-call persistence uncertain; no automatic replay',
  'invocation outcome is unknown; no automatic replay',
  'repair outcome is unknown; no automatic replay',
  'isolated executor storage admission refused',
  'thread storage full',
  'change detection unavailable',
  'artifact finalization failed',
  'turn changed retained files after a discovery decision; re-request the change without the ANSWER: prefix (no verification was recorded)',
  // the agent (coding completion, context acquisition).
  'verification did not run',
  'verification timed out',
  'verification failed',
  'history retrieval failed',
] as const;

export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

/**
 * The fixed reason a failure detail names, or null. A detail matches when it
 * equals a table entry, or when its text before the first `: ` or ` (` does
 * (a fixed prefix followed by interpolated detail); the rest is dropped.
 */
export function runFailureReason(detail: unknown): RunFailureReason | null {
  if (typeof detail !== 'string') return null;
  const table = RUN_FAILURE_REASONS as readonly string[];
  if (table.includes(detail)) return detail as RunFailureReason;
  const cuts = [detail.indexOf(': '), detail.indexOf(' (')].filter((index) => index > 0);
  if (cuts.length === 0) return null;
  const prefix = detail.slice(0, Math.min(...cuts));
  return table.includes(prefix) ? (prefix as RunFailureReason) : null;
}

/**
 * Why a tool action did not confirm, from a fixed set: `timeout`;
 * `refused` (the tool runtime refused the call); `4xx` / `5xx` (the service
 * rejected the request / failed or answered malformed); `policy` (the broker
 * refused: grant, path, bound); `limit` (output limit); `exit` (a command
 * exited non-zero); `other`.
 */
export const TOOL_FAILURE_CLASSES = [
  'timeout',
  'refused',
  '4xx',
  '5xx',
  'policy',
  'limit',
  'exit',
  'other',
] as const;

export type ToolFailureClass = (typeof TOOL_FAILURE_CLASSES)[number];

/**
 * Why the runner refused a native tool call of a coding turn,
 * counted per category in the tool trace: `workspace_storage` (the write
 * would not fit the thread's free storage), `file_size` (the per-file write
 * limit), `policy` (path, grant, read-only, skill or tool-surface refusal).
 */
export const DENIED_TOOL_CATEGORIES = ['workspace_storage', 'file_size', 'policy'] as const;

export type DeniedToolCategory = (typeof DENIED_TOOL_CATEGORIES)[number];

/** At most this many tool trace entries per run. */
export const MAX_TOOL_TRACE_ENTRIES = 200;

/** A run ID: `run-<runSeq>-<12 hex>`. */
export const RUN_ID_PATTERN = /^run-[1-9][0-9]{0,9}-[0-9a-f]{12}$/;

/** An SDK version: `major.minor.patch` with an optional pre-release or build suffix. */
export const SDK_VERSION_PATTERN =
  /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:[-+][0-9A-Za-z.]{1,32})?$/;

/** A typed operation kind: `<tool>` or `<tool>.<operation>` (for example `gitlab.list_merge_requests`). */
export const TOOL_OPERATION_KIND_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]{0,39}(?:\.[A-Za-z][A-Za-z0-9_]{0,63})?$/;

/** Execution profile selected for a run (persisted before side effects). */
export const EXEC_MODES = ['simulated', 'claude', 'claude-code'] as const;

export type ExecMode = (typeof EXEC_MODES)[number];

export function isExecMode(value: unknown): value is ExecMode {
  return typeof value === 'string' && (EXEC_MODES as readonly string[]).includes(value);
}

/** Opaque workspace/session asset identity: hex only, never Slack text. */
const ASSET_ID_PATTERN = /^[0-9a-f]{8,64}$/;

const REPO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,127}$/;

export function validateAssetId(value: string, name: string): void {
  if (!ASSET_ID_PATTERN.test(value)) {
    throw new TaskKeyError(`${name} must be an opaque lowercase hex id`);
  }
}

export function validateRepoId(value: string): void {
  if (!REPO_ID_PATTERN.test(value)) {
    throw new TaskKeyError(
      'repository id must be operator configuration (lowercase alphanumerics and dashes)',
    );
  }
}

export function validateBranch(value: string): void {
  if (!BRANCH_PATTERN.test(value)) {
    throw new TaskKeyError('branch must be a simple local branch name');
  }
}
