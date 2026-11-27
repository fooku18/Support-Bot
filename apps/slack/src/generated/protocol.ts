/**
 * GENERATED from the shared application contract — do not hand-edit.
 *
 * Protocol version 30 (application contract 1.0.0).
 * Canonical sources: apps/agent/src/contracts/ and apps/agent/src/domain/delivery/.
 * Regenerate with:
 *
 *   npm run generate:protocol
 */

/**
 * Version of the coordinator DTO/client contract (dto.ts plus the status
 * types in this file). The adapter and runner vendor this contract into
 * `src/generated/protocol.ts` via `npm run generate:protocol`; the
 * contract test fails when the generated mirrors drift. Bump together with
 * any incompatible DTO change and regenerate.
 */
export const PROTOCOL_VERSION = 30;

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
 * Marks a run message as still in progress. Terminal texts replace the whole
 * message, so the marker disappears with the final answer, failure, or
 * cancellation.
 */
export const PROGRESS_MARKER = '⏳';

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

/** `300/300 tool calls`, `$10.04/$10 estimated cost`, `31/30 min active`. */
export function renderSoftLimitReading(reading: SoftLimitReading): string {
  switch (reading.metric) {
    case 'tool_calls':
      return `${Math.floor(reading.value)}/${Math.floor(reading.limit)} tool calls`;
    case 'cost_usd':
      return `$${reading.value.toFixed(2)}/$${Number.isInteger(reading.limit) ? reading.limit : reading.limit.toFixed(2)} estimated cost`;
    case 'active_time':
      return `${Math.floor(reading.value / 60_000)}/${Math.round(reading.limit / 60_000)} min active`;
  }
}

/** The stage label without the progress marker. */
export function progressStageLabel(
  stage: AgentProgressStage,
  _toolCategory?: AgentToolCategory | null,
): string {
  switch (stage) {
    case 'starting':
      return 'Starting…';
    case 'model_working':
      return 'Reviewing the request…';
    case 'inspecting':
      return 'Inspecting files…';
    case 'editing':
      return 'Editing files…';
    case 'calling_service':
      return 'Contacting configured services…';
    case 'verifying':
      return 'Running verification…';
    case 'repairing':
      return 'Addressing verification results…';
    case 'publishing':
      return 'Preparing the merge request…';
    case 'retrying':
      return 'Retrying the model service…';
    case 'recovering':
      return 'Recovering interrupted work…';
    case 'paused_soft_limit':
      return 'Paused at a run limit…';
  }
}

/**
 * Fixed server-side rendering for a safe stage (no provider text). Metrics
 * raised by an earlier Continue follow the stage: `⏳ … · 312/600 tool calls`.
 */
export function renderProgressText(
  stage: AgentProgressStage,
  toolCategory?: AgentToolCategory | null,
  raised: readonly SoftLimitReading[] = [],
): string {
  const suffix = raised.map((reading) => ` · ${renderSoftLimitReading(reading)}`).join('');
  return `${PROGRESS_MARKER} ${progressStageLabel(stage, toolCategory)}${suffix}`;
}

/**
 * Slack message metadata the adapter attaches to every delivered message
 * (`chat.postMessage`/`chat.update` `metadata`). Invisible to users; read back
 * with `conversations.replies include_all_metadata`. Delivery reconciliation
 * finds the message by `operation_id` and compares `revision`; history
 * recovery uses `answer` to tell answers from status/progress messages.
 */
export const DELIVERY_METADATA_EVENT_TYPE = 'support_agent_delivery';

export interface DeliveryMetadata {
  operationId: string;
  revision: number;
  answer: boolean;
  /** The full answer file of a long answer (Slack file ID and SHA-256). */
  resultFiles?: Array<{ id: string; sha256: string }>;
}

/** Slack `metadata` argument (`event_type` + `event_payload`) for a delivered message. */
export interface SlackDeliveryMetadata {
  event_type: string;
  event_payload: {
    operation_id: string;
    revision: number;
    answer: boolean;
    result_files?: Array<{ id: string; sha256: string }>;
  };
}

/** Slack `metadata` argument for a delivered message. */
export function deliveryMetadata(args: DeliveryMetadata): SlackDeliveryMetadata {
  return {
    event_type: DELIVERY_METADATA_EVENT_TYPE,
    event_payload: {
      operation_id: args.operationId,
      revision: Math.max(0, Math.floor(args.revision)),
      answer: args.answer,
      ...(args.resultFiles?.length ? { result_files: args.resultFiles } : {}),
    },
  };
}

/** Parses delivery metadata from a `conversations.replies` message, or null. */
export function parseDeliveryMetadata(metadata: unknown): DeliveryMetadata | null {
  if (typeof metadata !== 'object' || metadata === null) {
    return null;
  }
  const candidate = metadata as { event_type?: unknown; event_payload?: unknown };
  if (candidate.event_type !== DELIVERY_METADATA_EVENT_TYPE) {
    return null;
  }
  const payload = candidate.event_payload as
    | { operation_id?: unknown; revision?: unknown; answer?: unknown; result_files?: unknown }
    | null
    | undefined;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const { operation_id: operationId, revision, answer } = payload;
  if (typeof operationId !== 'string' || operationId.length === 0) {
    return null;
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    return null;
  }
  const files = payload.result_files;
  if (
    files !== undefined &&
    (!Array.isArray(files) ||
      files.length > 10 ||
      files.some(
        (f) =>
          !f ||
          typeof f.id !== 'string' ||
          !/^F[A-Z0-9]+$/.test(f.id) ||
          typeof f.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(f.sha256),
      ))
  )
    return null;
  return {
    operationId,
    revision,
    answer: answer === true,
    ...(files === undefined
      ? {}
      : {
          resultFiles: (files as Array<{ id: string; sha256: string }>).map((f) => ({
            id: f.id,
            sha256: f.sha256,
          })),
        }),
  };
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
 * Fixed server-owned control receipts. Never echo steering text, user IDs,
 * provider errors, tool output, or cancellation internals.
 */
export const CONTROL_REPLY_NO_ACTIVE_RUN = 'There is no active request to cancel.';

/** Denied cancellation: only the run's author may cancel it (steering is open to the channel's people). */
export const CONTROL_REPLY_UNAUTHORIZED =
  'Only the person who started the active request can cancel it.';

export const CONTROL_REPLY_UNCERTAIN =
  'That update could not be confirmed as applied. Review the final result before retrying.';

export const CONTROL_REPLY_QUEUED_FOLLOWUP =
  'The update arrived after the active request stopped accepting changes, so it was queued as a follow-up.';

export const CONTROL_REPLY_EMPTY_UPDATE =
  'That update was empty. Mention the bot with `update: <instruction>` to change the active request.';

export const CONTROL_REPLY_BUSY =
  'The task queue is at capacity right now, so this request was not started. Try again shortly.';

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

export type PendingFlag = 'ctx' | 'queued' | 'outbox';

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

/** A typed operation kind: `<tool>` or `<tool>.<operation>` (for example `gitlab.list_merge_requests`). */
export const TOOL_OPERATION_KIND_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]{0,39}(?:\.[A-Za-z][A-Za-z0-9_]{0,63})?$/;

/** A run ID: `run-<runSeq>-<12 hex>`. */
export const RUN_ID_PATTERN = /^run-[1-9][0-9]{0,9}-[0-9a-f]{12}$/;

/** An SDK version: `major.minor.patch` with an optional pre-release or build suffix. */
export const SDK_VERSION_PATTERN =
  /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:[-+][0-9A-Za-z.]{1,32})?$/;

/** JSON request/response contracts for private application service boundaries. */

export interface HealthzResponse {
  ok: true;
  service: string;
  version: string;
  authorizationPolicyId?: string;
  authorizationPolicyHash?: string;
}

export interface IntakeRequest {
  qualificationToken?: string;
  installationId: string;
  teamId: string;
  channelId: string;
  /** `thread_ts ?? ts` of the triggering mention. */
  rootTs: string;
  eventId: string;
  /** Source message identity (channel + ts of the mention message). */
  messageTs: string;
  userId: string;
  /** Original event text: only this field may parse as a control. */
  text: string;
  /** Canonical text/blocks/attachments captured at intake. */
  canonicalText: string;
  authorBotId: string | null;
  threadTs?: string;
  eventTs?: string;
  /**
   * Slack's per-event `action_token` (apps with Agents & AI Apps enabled):
   * lets the run's Slack message search act with this user's permissions.
   * Held on the inbox row until the run ends; never inspected or logged.
   */
  actionToken?: string;
}

export interface IntakeResponse {
  taskKey: string;
  accepted: boolean;
  duplicate: boolean;
  runId: string | null;
  runSeq: number | null;
  /**
   * Durable routing decision for this event: `run` (new ordinary run),
   * `steering` (durable steer control targeting `runSeq`), `cancel`
   * (durable cancellation for `runSeq`), `rejected` (recorded but refused),
   * `no_active_run` (cancel with nothing active), `queued_followup` (late
   * update became ordinary run `runSeq`), or `invalid` (malformed command).
   * Duplicate deliveries repeat the original routing.
   */
  // A queued_followup with null run identity is durably accepted behind
  // older unresolved controls, awaiting ordered admission. Redelivery keeps
  // its event/control identity; capacity refusal is recorded when allocated.
  routing: IntakeRouting;
  /** Control identity when the event became a control, otherwise null. */
  controlId: string | null;
  /**
   * When routing is `busy`: which admission scope refused the new run and
   * the configured bound that was hit. Null for every other routing.
   */
  capacityScope?: AdmissionScope | null;
  capacityLimit?: number | null;
  /**
   * Set only for a new ordinary run (`run`) accepted while an older run of
   * the thread is running with its steering window open: the mention's
   * author may still turn it into steering of `runSeq` (`POST /steer`).
   * Advisory: the conversion re-checks the window.
   */
  steerable?: SteerableIntake | null;
  /** Opaque task-instance identity that accepted this event (test DTO; filled at accept). */
  instanceId?: string | null;
}

export type AuthorizationAction =
  | 'task.start'
  | 'task.read'
  | 'task.steer'
  | 'task.cancel'
  | 'tool.use'
  | 'skill.use'
  | 'mcp.use';

export type AuthorizationResourceType = 'tool' | 'skill' | 'mcp';

export interface AuthorizationDecisionRequest {
  runId: string;
  runSeq: number;
  attempt: number;
  runnerId: string;
  action: AuthorizationAction;
  resourceType?: AuthorizationResourceType;
  resourceId?: string;
}

export interface AuthorizationDecisionResponse {
  allowed: boolean;
  decisionId: string;
  policyId: string;
  policyHash: string;
  reason: string;
}

export interface RegistryTaskRow {
  /** Explicit publication recovery, independent of queued inference work. */
  resultRecovery?: { recoveryId: string; state: string } | null;
  publicationRecovery?: { recoveryId: string; state: string } | null;
  taskKey: string;
  summary: TaskSummary;
  createdAtMs: number;
  /** Owning task instance that last published a summary (empty = placeholder). */
  instanceId: string;
  /** Monotonic per-cell incarnation counter (0 = placeholder row). */
  instanceSeq: number;
  updatedAtMs: number;
}

export interface RegistryTasksResponse {
  tasks: RegistryTaskRow[];
  nextAfter: string | null;
}

/**
 * Explicit registry page contract for the service clients: `nextAfter` is
 * the keyset cursor to continue from (null after the last page). Pollers
 * must never discard it — a discarded cursor restarts every scan at the
 * first page and can starve tasks beyond it.
 */
export interface RegistryTaskPage {
  tasks: RegistryTaskRow[];
  nextAfter: string | null;
}

/** Model-authored plan only. Identity is (originating run, attempt, revision, ordinal). */
export interface TaskChecklistDto {
  objectiveRunId: string;
  runId: string;
  attempt: number;
  revision: number;
  items: Array<{ ordinal: number; label: string; status: 'pending' | 'in_progress' | 'completed' }>;
}

/** Controller-owned evidence, never supplied by a model tool. */
export interface TaskProjectEvidenceDto {
  project: string;
  treeDigest: string | null;
  verification: 'not_run' | 'passed' | 'failed' | 'timed_out' | 'incomplete' | 'unknown';
  publication: 'not_published' | 'published' | 'unknown';
}

export interface ProgressSnapshotDto {
  checklist?: TaskChecklistDto | null;
  projectEvidence?: TaskProjectEvidenceDto[];
  stage: AgentProgressStage;
  toolCategory: AgentToolCategory | null;
  source: AgentProgressSource;
  attempt: number;
  seq: number;
  updatedAtMs: number;
  /**
   * Admin debugging only (never rendered in Slack): exact SDK name of the
   * attempt's latest tool call, the number of tool calls observed in the
   * attempt, and when the latest call was observed. Never arguments or output.
   */
  toolName: string | null;
  toolCalls: number | null;
  toolStartedAtMs: number | null;
}

export interface TaskClarificationQuestion {
  questionId: string;
  state: 'open' | 'answered' | 'expired' | 'cancelled';
  retention: 'held' | 'blocked' | 'disabled';
  retentionReason: string | null;
  holdId: string | null;
  objectiveRunSeq: number;
  askingRunSeq: number;
  principalUserId: string;
  createdAtMs: number;
  deadlineMs: number | null;
  answerUserId: string | null;
  answeredAtMs: number | null;
  continuationRunSeq: number | null;
  busyCount: number;
  closedAtMs: number | null;
  closeReason: string | null;
}

export interface TaskClarificationStatus {
  waitingForInput: boolean;
  questions: TaskClarificationQuestion[];
  /** Content-free markers of expired questions (survive instance expiry). */
  expired: Array<{
    questionId: string;
    holdId: string | null;
    expiredAtMs: number;
    deadlineMs: number | null;
  }>;
}

export interface TaskStatusRun {
  runId: string;
  /** the execution principal whose permissions the run uses. */
  principalUserId: string | null;
  /** the run that opened this run's objective. */
  objectiveRunSeq: number | null;
  /** the clarification question this run continues, if any. */
  continuesQuestionId: string | null;
  runSeq: number;
  status: RunStatus;
  attempt: number;
  contextRevision: number | null;
  leaseOwner: string | null;
  leaseExpiresMs: number | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
  /** Latest safe progress snapshot for this run, or null before any event. */
  progress: ProgressSnapshotDto | null;
  /**
   * Execution mode derived from the persisted result (`simulated`, `claude`,
   * or null when the run has no result yet). Conversation/answer text is
   * never included in inspection.
   */
  resultKind: 'simulated' | 'claude' | 'coding' | null;
  /** Trusted execution identity retained with the run result. */
  execution?: ExecutionIdentityDto;
  /**
   * Model alias pinned on the run's first claim (answer and coding runs),
   * else the alias reported by its result, else null (simulated runs).
   */
  model: string | null;
  /** Allowlist key pinned with `model` on the run's first claim, or null. */
  modelKey: string | null;
  /** Durably reserved inference invocations for this logical run. */
  inferenceAttempts: number;
  /**
   * Available usage summary for Claude results (tokens + estimated cost),
   * or null when unavailable/unknown. Never proves billing attribution.
   */
  usage: ClaudeUsageDto | null;
  /** Persisted execution profile for this logical run (stable across retries). */
  execMode: 'simulated' | 'claude' | 'claude-code' | null;
  /** Coding-only: workspace/session/verification summary, otherwise null. */
  coding: TaskStatusCoding | null;
  /** Whether the run is currently accepting steering input. */
  steeringState: SteeringState | null;
  /** Durable cancellation request time, or null when none was requested. */
  cancelRequestedAtMs: number | null;
  /** Categorical cancellation evidence for terminal cancelled runs. */
  cancellationOutcome: CancellationOutcome | null;
  /**
   * Whether the run's triggering mention carried a Slack `action_token`
   * (Slack message search possible). The value itself is never inspected.
   */
  actionToken: boolean;
}

export interface TaskStatusCoding {
  /** Durable successful native broker calls; absent for legacy execution. */
  confirmedToolCalls?: ConfirmedToolCallDto[];
  repoId: string | null;
  branch: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  sessionResumed: boolean | null;
  /** Why the run started a fresh native session, or null. */
  sessionRotation: SessionRotationReason | null;
  /** What the run's prompt carried (context envelope counts, never text), or null. */
  context: Omit<ContextEnvelopeDto, 'hash'> | null;
  verification: string | null;
  verificationExitCode: number | null;
  changedFiles: number | null;
  artifactId: string | null;
  /** Reconciled publications of this run (one per published project). */
  publications: Array<{
    project: string;
    projectId: number;
    state: string;
    mrIid: number | null;
    mrUrl: string | null;
    commit: string | null;
  }>;
  /** Tool-config migration: number of recorded broker actions, or null. */
  actions: number | null;
  atlassianActions?: Array<{
    operation: string;
    runId: string;
    runSeq: number;
    success: boolean;
    binding: {
      site: string;
      cloudId: string;
      adapter: string;
      contractVersion: string;
    };
  }>;
  /** Successful Datadog MCP reads of this run (no arguments, no results). */
  datadogActions?: Array<{
    /** Model-facing name, `datadog_<tool>`. */
    operation: string;
    /** Upstream Datadog MCP tool name. */
    tool: string;
    runId: string;
    runSeq: number;
    success: boolean;
    durationMs: number | null;
    bytes: number | null;
    binding: {
      site: string;
      endpoint: string;
      adapter: string;
      contractVersion: string;
      toolCatalogHash: string;
    };
  }>;
  /** Successful Cloudflare API reads of this run (no query text, variables or results). */
  cloudflareActions?: Array<{
    /** Model-facing tool name: `cloudflare_graphql` or `cloudflare_get`. */
    operation: string;
    /** GraphQL: the first dataset (root field) queried; REST: null. */
    dataset: string | null;
    /** REST: the path template (IDs replaced); GraphQL: null. */
    path: string | null;
    runId: string;
    runSeq: number;
    success: boolean;
    durationMs: number | null;
    bytes: number | null;
    binding: {
      endpoint: string;
      adapter: string;
      contractVersion: string;
      accountId: string | null;
      zoneSetHash: string;
    };
  }>;
  /**
   * Successful Slack user lookups and message searches of this run (no user
   * IDs, e-mails, profiles, queries, message text or permalinks).
   */
  slackActions?: Array<{
    /**
     * Model-facing tool name: `slack_get_user`, `slack_lookup_user_by_email`
     * or `slack_search_messages`.
     */
    operation: string;
    runId: string;
    runSeq: number;
    success: boolean;
    durationMs: number | null;
    bytes: number | null;
    /** Message search only: Slack pages read and messages returned (else null). */
    pages: number | null;
    resultCount: number | null;
    /** Message search only: returned messages without readable content (else null). */
    emptyHits: number | null;
    binding: {
      endpoint: string;
      adapter: string;
      contractVersion: string;
      /** Workspace of the bot token (equals the thread's workspace). */
      teamId: string;
    };
  }>;
  /**
   * Confirmed native WebSearch calls of this run (Claude Code's server-side
   * search through the AI Gateway): counts only, never the query or results.
   */
  webSearchActions?: Array<{
    runId: string;
    runSeq: number;
    success: boolean;
    /** The CLI's server search count; null when its response omitted it. */
    searchCount: number | null;
    /** Result hits across the call's result blocks. */
    resultCount: number;
  }>;

  /**
   * Native operator skills: durable invocation evidence for this run.
   * Canonical qualified names advertised/invoked plus bundle identity;
   * never content. Null when the run advertised no skills.
   */
  skills: {
    advertised: string[];
    invoked: string[];
    sourceHash: string | null;
    effectiveHash: string | null;
    sessionGeneration: number | null;
  } | null;
}

export interface TaskStatusContextRevision {
  revision: number;
  status: ContextStatus;
  messageCount: number;
  acceptedMessageCount: number;
  messageIds: string[];
  createdAtMs: number;
}

export interface TaskStatusOutboxItem {
  operationId: string;
  /** Owning run, or null for run-independent thread messages. */
  runSeq: number | null;
  state: string;
  attempts: number;
  nextRetryMs: number | null;
  slackTs: string | null;
  lastError: string | null;
  /** Latest agent-authored revision for this run message. */
  desiredRevision: number;
  /** Latest revision known to exist in Slack. */
  confirmedRevision: number;
  /** True once the desired revision carries the terminal answer/failure. */
  terminal: boolean;
  /** Button rendered under the message (run progress messages only). */
  /** Native pause identity carried by Continue/Cancel button values. */
  pauseId?: string | null;
  actions: OutboxAction | null;
  /** agent-authored context line under the message (final answers only). */
  footer: string | null;
}

/** the cell's diagnostic export (counts only; no event content). */
export interface TaskDiagnosticsStatus {
  enabled: boolean;
  /** Why the export is disabled (e.g. `no_admin`); null when enabled. */
  disabled: string | null;
  pending: number;
  pendingBytes: number;
  markers: number;
  failures: number;
  backoffUntilMs: number | null;
  exported: number;
  lastExportMs: number | null;
  lastError: string | null;
  unexportedLoss: number;
}

export interface TaskStatusResponse {
  /** diagnostic export counters of the cell. */
  diagnostics?: TaskDiagnosticsStatus;
  closure: unknown;
  editNotes: unknown[];
  editOmitted: number;
  effectJournal: unknown[];
  closureStatus: unknown[];
  taskKey: string;
  taskId: string;
  teamId: string;
  channelId: string;
  rootTs: string;
  schemaVersion: number;
  createdAtMs: number;
  nextRunSeq: number;
  /**
   * Task-instance lifecycle (one-hour idle expiry): `active`, `expiring`
   * (transient inside the expiry transaction), or `expired` (tombstone).
   */
  lifecycle: TaskInstanceLifecycle;
  /** Opaque instance identity; distinguishable across revivals. */
  instanceId: string | null;
  /** Monotonic per-cell incarnation counter. */
  instanceSeq: number | null;
  /** Last meaningful user-visible activity (mention or terminal delivery). */
  lastActivityMs: number | null;
  /** Expiry deadline persisted at the last activity reset. */
  expiresAtMs: number | null;
  /** Tombstone-only completion time of the expiry transaction. */
  expiredAtMs: number | null;
  inbox: { accepted: number; duplicates: number };
  /** Bot answers recovered from Slack history for this instance (count only). */
  recoveredAnswers: number;
  latestContext: TaskStatusContextRevision | null;
  runs: TaskStatusRun[];
  outbox: TaskStatusOutboxItem[];
  summary: TaskSummary;
  /** Authoritative admission view for this cell (read-only; scrapes never mutate). */
  admission: TaskAdmissionStatus;
  /** Persistent coding workspace/session record for this task, if allocated. */
  coding: CodingStatusDto | null;
  /**
   * durable clarification state. `waitingForInput` is true while the
   * current instance has an open question (the derived task state; no run
   * executes meanwhile). Questions are metadata only, never their text.
   */
  clarification: TaskClarificationStatus;
  /** the current instance's automatic-reply participation (null: not invited). */
  replies: ReplyParticipationDto | null;
  /** Metadata-only control state (never instruction text or raw payloads). */
  controls: TaskStatusControl[];
}

/**
 * Authoritative per-cell admission counters: admitted work in this thread,
 * its oldest wait, and durable rejection/release evidence. All counts come
 * from the runs/inbox tables — never from advisory registry summaries.
 */
export interface TaskAdmissionStatus {
  /** Configured per-thread bound on outstanding admitted runs. */
  threadLimit: number;
  /** Runs counted against the bound (awaiting_context/queued/running/cancelling). */
  activeRuns: number;
  /** Accepted inputs awaiting ordered admission, separately bounded at 32. */
  deferredIntakes?: number;
  /** Age (ms) of the oldest active run, or null when the thread is empty. */
  oldestWaitMs: number | null;
  /** Durable capacity rejections recorded in this cell. */
  busyRejections: number;
  /** Busy notifications suppressed by the per-window rate bound. */
  busyNotificationsSuppressed: number;
  /** Terminal reservations not yet released (bounded retry, alarm-driven). */
  pendingReleases: number;
}

/**
 * Safe inspection view of one durable control command. Exposes routing and
 * lifecycle metadata only: no steering text, prompt, tool payload, or raw
 * provider event.
 */
export interface TaskStatusControl {
  controlId: string;
  kind: ControlKind;
  targetRunSeq: number | null;
  state: ControlState;
  /** True once a stable provider correlation UUID exists (never the UUID itself for ordinary inspection). */
  hasProviderMessageId: boolean;
  claimedAttempt: number | null;
  convertedRunSeq: number | null;
  /** The queued follow-up run this steering command replaced (*Steer the current run*), else null. */
  replacedRunSeq: number | null;
  acceptedAtMs: number;
  appliedAtMs: number | null;
  lastErrorCode: string | null;
  /** Provenance: the Slack message the control came from and its author. */
  sourceMessageTs: string;
  userId: string | null;
}

export interface CodingStatusDto {
  repoId: string;
  sourceRevision: string;
  baseCommit: string | null;
  branch: string;
  workspaceId: string;
  storageId: string;
  lifecycle: string;
  generation: number;
  sessionId: string | null;
  sessionResumed: boolean;
  sdkVersion: string | null;
  model: string | null;
  recovery: string | null;
  updatedAtMs: number;
  /** GitLab checkouts of this task (one per cloned project; empty for fixture tasks). */
  repositories: CodingRepositoryDto[];
}

/** One cloned GitLab project of a coding task (`coding_task_repositories`). */
export interface CodingRepositoryDto {
  projectId: number;
  canonicalPath: string;
  /** Branch the checkout started from; the task MR target. */
  targetBranch: string;
  taskBranch: string;
  baseCommit: string;
  lastPublishedHead: string | null;
  mrIid: number | null;
  mrUrl: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One recorded tool action (local or remote) attached to a coding result. */
export interface ActionRecordDto {
  /** Stable per-run operation identity (never reused for replay decisions). */
  operationId: string;
  /** Broker tool name (e.g. glab, atlassian, task_exec, task_files, web_fetch). */
  tool: string;
  /** Argument vector when applicable (bounded; credential-free). */
  argv?: string[];
  /** Bounded human summary of the operation. */
  summary: string;
  /** Truthful execution outcome; 'uncertain' survives crashes/lost acks. */
  outcome: 'confirmed' | 'failed' | 'uncertain';
  /** Optional bounded evidence (e.g. returned remote id, exit code). */
  evidence?: string;
}

/**
 * One tool action of a run as structure only: never argv,
 * summary or evidence, which reproduce instructions and source content.
 */
export interface ToolTraceEntryDto {
  /** Broker tool name (as in ActionRecordDto). */
  tool: string;
  /** Typed operation kind, e.g. `gitlab.list_merge_requests` (TOOL_OPERATION_KIND_PATTERN). */
  kind: string;
  outcome: 'confirmed' | 'failed' | 'uncertain';
  /** Why the action did not confirm; null when it did. */
  failureClass: ToolFailureClass | null;
  /** Wall-clock duration of the call in ms. */
  durationMs: number;
  /** Bytes of the tool's output before the per-call output bound. */
  outputBytes: number;
  /** Code Mode: 1-based row of the run_script call this call was made from. */
  parent?: number | null;
  /** Code Mode: nested calls a run_script call made. */
  children?: number | null;
  /** Slack message search: returned hits whose content stayed unreadable. */
  emptyHits?: number | null;
}

/** A run's tool trace in call order: the first MAX_TOOL_TRACE_ENTRIES entries and the exact total. */
export interface ToolTraceDto {
  total: number;
  entries: ToolTraceEntryDto[];
  /** Native tool calls the runner refused this run, per category; absent when none. */
  denied?: Partial<Record<DeniedToolCategory, number>>;
}

export interface ContextClaimRequest {
  claimerId: string;
  leaseMs: number;
}

export interface ContextClaimResponse {
  inputEpoch: number;
  runId: string;
  runSeq: number;
  contextAttempt: number;
  triggerTs: string;
  eventId: string;
}

/**
 * One thread message. A context message has exactly one author: `userId`
 * for a person (the trusted bot sender included), or `botId` with
 * `authorName` for another bot or app (its bot profile name, else its
 * posting name, else the bot ID). `text` is the flattened content: the
 * message text, its attachments and its blocks. This app's own answers
 * (`assistantMessages`) carry the bot user as `userId`.
 */
export interface ContextMessageDto {
  files?: SlackFileDescriptorDto[];
  ts: string;
  userId?: string | null;
  botId?: string | null;
  authorName?: string | null;
  text?: string | null;
  editedTs?: string | null;
}

export interface SlackFileDescriptorDto {
  id: string;
  sourceTs: string;
  name: string;
  mime: string;
  bytes: number;
  revision: string;
  hosted: boolean;
}

export interface ContextSupplyRequest {
  inputEpoch: number;
  runId: string;
  runSeq: number;
  contextAttempt: number;
  status: ContextStatus;
  messages: ContextMessageDto[];
  /**
   * This app's own earlier replies in the thread (markers stripped,
   * status-only replies dropped; `userId` is the bot user). Consumed only by
   * an instance without a completed run (a fresh instance after a state
   * purge or expiry); live instances ignore them and keep answering from
   * their own run records. Never merged into human context. Bounded by the
   * same message cap as `messages`.
   */
  assistantMessages?: ContextMessageDto[];
}

export interface ContextSupplyResponse {
  revision: number;
  acceptedMessageCount: number;
  queued: boolean;
  /** Assistant messages recorded as recovered answers by this supply (0 for live instances). */
  recoveredAnswers: number;
}

export interface ContextFailRequest {
  inputEpoch: number;
  runId: string;
  runSeq: number;
  contextAttempt: number;
  error: string;
}

export interface RunClaimRequest {
  runnerId: string;
  leaseMs: number;
  /**
   * Requested execution profile. The cell persists the first selection per
   * logical run and rejects later mismatches (409 `mode_mismatch`) so retries
   * never change an answer-only run into a coding run when configuration
   * changed. The caller must select a profile explicitly.
   */
  execMode: 'simulated' | 'claude' | 'claude-code';
  /**
   * The runner's model allowlist (answer and coding modes; absent in
   * simulated mode). On the run's first claim the cell resolves the
   * channel's admin-chosen key against it (an unknown key falls back to the
   * default) and pins key and alias on the run; retries reuse the pinned
   * model.
   */
  models?: ModelAllowlistDto;
}

/** Operator model allowlist: keys mapped to Gateway aliases, plus the default key. */
export interface ModelAllowlistDto {
  defaultKey: string;
  models: Array<{ key: string; model: string }>;
}

/** Model pinned on a run's first claim. */
export interface RunModelDto {
  key: string;
  /** Gateway alias passed to the SDK. */
  model: string;
  /**
   * The channel's configured key when it was not in the allowlist and the
   * default was used instead, otherwise null.
   */
  unavailableKey: string | null;
}

export interface PriorAnswerDto {
  /** Originating run, or 0 for an answer recovered from Slack thread history. */
  runSeq: number;
  contextRevision: number;
  /** Exact persisted answer (or coding summary) text used for future context. */
  answerText: string;
  /** Model of the originating run, or `slack-history` for a recovered answer. */
  model: string;
  /** True when the originating run's outbox operation is delivered. */
  delivered: boolean;
  /**
   * Result kind of the originating run: `answer` (answer-only `answerText`,
   * or recovered from Slack) or `coding` (claude-code `summaryText`).
   * Informational; both render alike.
   */
  source: 'answer' | 'coding';
  /** Slack ts of the recovered message (present only when runSeq is 0). */
  sourceTs?: string;
}

/** Soft-limit metric values in their units: calls, USD (estimated), ms. */
export interface SoftLimitValuesDto {
  toolCalls: number;
  costUsd: number;
  activeMs: number;
}

/**
 * A coding run's soft-limit state, reported by the runner with progress and
 * on parking; returned on later claims of the same run so a continuation
 * inherits its counters and raised limits.
 */
export interface SoftLimitStateDto {
  /** Current limits (initial values plus every Continue's raise). */
  limits: SoftLimitValuesDto;
  usage: SoftLimitValuesDto;
  /** Metrics an earlier Continue raised; the run message shows them. */
  raised: SoftLimitMetric[];
  /** The open pause (id and crossed metrics), null while the run works. */
  pause: { pauseId: string; crossed: SoftLimitMetric[] } | null;
}

/**
 * One admin-managed tool instance assigned to the task's channel. Non-secret
 * settings only: credentials stay in the admin store and the runtimes.
 */
export interface ChannelToolDto {
  kind:
    | 'gitlab'
    | 'atlassian'
    | 'datadog'
    | 'cloudflare'
    | 'slack'
    | 'webSearch'
    | 'webFetch'
    | 'codeMode'
    | 'files'
    | 'localExec';
  instanceId: string;
  label: string;
  credentialVersion: number;
  ready: boolean;
  detail: string | null;
  /** GitLab only. */
  host?: string;
  /** Atlassian only: effective operation allowlist. */
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

/**
 * The tools the task's channel exposes, from the admin document the agent
 * synced last (`toolAssignments`). Null when the channel has no entry (not
 * enabled, or no document synced): no optional tool is available.
 */
export interface ChannelToolsDto {
  configVersion: number;
  teamId: string;
  channelId: string;
  /**
   * The channel's admin-chosen model key (null: deployment default).
   * Metadata: the run's model is pinned at its first claim (`runModel`).
   */
  modelKey: string | null;
  /**
   * The channel's admin system prompt (channel, else workspace; null: none).
   * The runner appends it to its fixed system prompt when it prepares a
   * turn; the heartbeat value is informational and never changes a
   * prepared or running turn.
   */
  systemPrompt: string | null;
  tools: ChannelToolDto[];
}

export interface ChannelMemorySnapshotDto {
  revision: number;
  hash: string;
  rendered: string;
  entries: Array<{
    id: number;
    text: string;
    creator: string;
    editor: string;
    channelId: string;
    threadTs: string;
    messageTs: string;
    createdAt: number;
    lastConfirmedAt: number;
  }>;
}
/** Immutable admission-time input. Author attribution never adds authority. */
export interface AcceptedRequestDto {
  messageTs: string;
  eventId: string;
  acceptedAtMs: number;
  text: string;
  contentHash: string;
  userId: string;
  authorKind: 'human' | 'bot';
  botId: string | null;
}
export interface RunClaimResponse {
  inputEpoch: number;
  acceptedRequest: AcceptedRequestDto;
  editNotes: string;
  incrementalEditNotes: string;
  editNoteIds?: number[];
  incrementalEditNoteIds?: number[];
  memory: ChannelMemorySnapshotDto | null;
  runId: string;
  runSeq: number;
  attempt: number;
  contextRevision: number;
  acceptedMessageCount: number;
  contextStatus: ContextStatus;
  messages: ContextMessageDto[];
  leaseMs: number;
  /** Triggering mention identity: inbox message_ts (the merge bound). */
  triggerMessageTs: string;
  triggerEventId: string;
  /**
   * Earlier completed Claude answers from the same task with runSeq lower
   * than the current run, ordered oldest-first. Excludes simulated results
   * and failed/abandoned attempts. Answer text is immutable; `delivered`
   * honestly labels whether the originating reply has reached Slack.
   */
  priorAnswers: PriorAnswerDto[];
  /** Durably reserved inference invocations consumed by this logical run. */
  inferenceAttempts: number;
  maxInferenceInvocations: number;
  /** Persisted execution profile for this logical run (stable across retries). */
  execMode: 'simulated' | 'claude' | 'claude-code';
  /**
   * Persistent coding workspace/session record for coding runs (null for
   * answer-only/simulated runs or before allocation).
   */
  coding: CodingStatusDto | null;
  /** Model pinned on the first claim; null for simulated runs. */
  runModel: RunModelDto | null;
  /** Tools of the task's channel now (refreshed on every heartbeat). */
  tools: ChannelToolsDto | null;
  /** The run's last reported soft-limit state (null before its first report). */
  softLimits: SoftLimitStateDto | null;
  /** Pause ID its requester chose to continue (a parked run's continuation), else null. */
  softLimitContinue: string | null;
  /** Exact held tree required before parked native inference may resume. */
  softLimitRetention?: { holdId: string; holdSnapshot: string } | null;
  /**
   * The triggering mention's Slack `action_token` (null: Slack sent none, or
   * the run has ended). Memory only in the runner; never persisted or logged there.
   * Null as well when the trigger's author is not the run's execution
   * principal (a colleague's answer never lends their token).
   */
  actionToken: string | null;
  /** the run's execution principal (original requester). */
  principalUserId: string | null;
  /**
   * set when the run continues an answered clarification question.
   * Its files are protected by the runner hold `holdId` with the retained
   * snapshot `holdSnapshot`; a missing or mismatched retained workspace is
   * operator recovery, never the fresh-workspace fallback. Null otherwise.
   */
  continuation: RunContinuationDto | null;
  /**
   * content-free markers of clarification questions that expired
   * after the thread's previous run started (newest last): this run is the
   * first request after the expiry, a fresh objective; the expired discussion
   * is evidence only. `holdId` lets the runner fence the retained files at
   * once, before its periodic hold settlement.
   */
  expiredQuestions: Array<{ questionId: string; holdId: string | null; expiredAtMs: number }>;
}

export interface RunContinuationDto {
  questionId: string;
  objectiveRunSeq: number;
  askingRunSeq: number;
  /** Who answered (attribution only; never the execution identity). */
  answerUserId: string | null;
  retention: 'held' | 'blocked' | 'disabled';
  holdId: string | null;
  holdSnapshot: string | null;
}

export interface RunBusyResponse {
  busy: true;
  runId: string;
  runSeq: number;
  attempt: number;
}

export interface RunHeartbeatRequest {
  /** Only an attached provider mailbox can receive contextual notes. */
  acceptsEditNotes?: boolean;
  runId: string;
  runSeq: number;
  attempt: number;
  runnerId: string;
  extendMs: number;
}

/** One steering command leased to the current run attempt for provider input. */
export interface HeartbeatSteering {
  contextNote?: boolean;
  controlId: string;
  providerMessageId: string;
  instructionText: string;
  sourceMessageTs: string;
  /** Slack user who sent the update (any permitted thread participant), or null. */
  userId: string | null;
}

/** Durable cancellation intent the runner must observe promptly. */
export interface HeartbeatCancellation {
  controlId: string;
  requestedAtMs: number;
}

export interface RunHeartbeatResponse {
  leaseExpiresMs: number;
  /** Present on every valid heartbeat while the run is cancelling. */
  cancellation: HeartbeatCancellation | null;
  /** At most one fenced steering command per heartbeat, in Slack order. */
  steering: HeartbeatSteering | null;
  /** Current tools of the task's channel; a removed or reassigned tool is revoked. */
  tools: ChannelToolsDto | null;
  /** Pause ID the requester chose to continue while the run waits in process, else null. */
  softLimitContinue: string | null;
}

export interface ClaudeUsageDto {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * SDK client-side dollar estimate, or null when unavailable. Distinguished
   * from zero: null means unknown (e.g. interrupted before a result).
   * Never proves company billing attribution or Gateway pricing.
   */
  costUsdEstimate?: number | null;
  costBasis?: string | null;
}

/** Trusted runner-selected identity; never accepted from model/tool output. */
export interface ExecutionIdentityDto {
  runtime: 'mastra';
  template: { id: 'answer' | 'coding'; version: '1' };
}

/** Bounded content-free evidence emitted only after the broker journal commits. */
export interface ConfirmedToolCallDto {
  taskKey: string;
  runId: string;
  attempt: number;
  traceId: string;
  callSequence: number;
  instanceId: string;
  operation: string;
  operationId: string;
  outcome: 'success';
}

export interface RunResultDto {
  /** Coding-only: trusted persisted native broker evidence, never model output. */
  confirmedToolCalls?: ConfirmedToolCallDto[];
  execution?: ExecutionIdentityDto;
  deliverables?: DeliverableDto[];
  incomplete?: boolean;
  taskId: string;
  runSeq: number;
  contextRevision: number;
  acceptedMessageCount: number;
  /**
   * Explicit result variant.
   */
  kind: 'simulated' | 'claude' | 'coding';
  /** Claude-only: exact answer text used for delivery and future context. */
  answerText?: string;
  /** Claude and coding: the run's pinned model alias (e.g. claude-5.5-sonnet). */
  model?: string;
  /**
   * Claude-only: immutable context references for this answer (revision plus
   * the prior answers incorporated, by runSeq/revision).
   */
  contextRefs?: {
    revision: number;
    priorAnswers: Array<{ runSeq: number; revision: number; delivered: boolean }>;
  };
  /** Claude-only: inference invocations consumed for this logical run. */
  inferenceAttempts?: number;
  /** Claude-only: wall-clock SDK duration in ms, when available. */
  durationMs?: number;
  /** Claude-only: available usage metadata, or null when unavailable. */
  usage?: ClaudeUsageDto | null;
  generation?: number;
  outcome?: 'change' | 'clarification' | 'discovery' | 'partial';
  summaryText?: string;
  /**
   * Tool-driven runs (migration contract): bounded action records for actual
   * local/remote operations with stable operation identity and a truthful
   * confirmed/failed/uncertain outcome. Absent for edit/verification-only
   * runs; never proves a remote side effect by itself.
   */
  actions?: ActionRecordDto[];
  /** Coding-only: the run's structural tool trace, stored apart from the result. */
  toolTrace?: ToolTraceDto;
  /** Coding-only: repository/branch/workspace/session identity. */
  repoId?: string;
  baseCommit?: string;
  branch?: string;
  workspaceId?: string;
  sessionId?: string;
  sessionResumed?: boolean;
  /** Coding-only: SDK version that produced the turn (diagnostics only). */
  sdkVersion?: string;
  /** Coding-only: what the turn's prompt carried (counts only, never text). */
  contextEnvelope?: ContextEnvelopeDto;
  /** Coding-only: changed-file summary (paths bounded, no contents). */
  changedFiles?: Array<{ path: string; status: string; bytes: number }>;
  /** Coding-only: independent verification outcome. */
  verification?: {
    status: 'passed' | 'failed' | 'timed_out' | 'not_run';
    command: string;
    exitCode: number | null;
    durationMs: number;
  };
  /** Coding-only: artifact references with size and integrity hash. */
  artifacts?: Array<{ id: string; kind: string; bytes: number; sha256: string }>;
  /** Coding-only: reconciled publications of this run (one per published project). */
  publications?: PublicationRecordDto[];
  /**
   * Coding-only (native operator skills): durable native invocation
   * evidence. Canonical qualified names advertised to the native session
   * and actually invoked, plus source/effective bundle hashes and the
   * pinned skill session generation. Names + hashes only, never content.
   * Absent for zero-skill runs.
   */
  skills?: {
    advertised: string[];
    invoked: string[];
    sourceHash: string | null;
    effectiveHash: string | null;
    sessionGeneration: number | null;
  } | null;
  /** Coding-only: model/usage/duration, same shape as Claude-only fields. */
  codingUsage?: ClaudeUsageDto | null;
  /**
   * Coding-only: why this run started a fresh native session instead of
   * resuming the previous one, or null when it resumed or was the first.
   */
  sessionRotation?: SessionRotationReason | null;
  /**
   * Coding-only: the turn rebuilt its context from the thread because the
   * native session was lost: `reset` (state reset, answers recovered from
   * Slack) or `rotation` (see `sessionRotation`). Null otherwise. The first
   * such answer of a task carries a footer line saying so.
   */
  contextRebuilt?: ContextLoss | null;
  /**
   * Claude and coding: the answer's (summary's) length in characters before
   * the runner cut it at the reply bound. A count, never text.
   */
  replyChars?: number;
  /** Claude and coding: the runner cut the answer (summary) at the bound with the notice. */
  truncated?: boolean;
  /**
   * Coding-only: the structured question of a `clarification`
   * outcome with the runner's retention decision (a hold receipt, or why the
   * files cannot be kept durably). Required for that outcome, absent otherwise.
   */
  clarification?: CodingClarificationDto | null;
}

export interface CodingClarificationDto {
  question: string;
  retention:
    | { status: 'held'; holdId: string; snapshot: string }
    | { status: 'blocked' | 'disabled'; reason: string };
}

/**
 * Why a coding run rotated its native session. `storage_expired`: the
 * runner idle-expired the thread's storage while the task instance was
 * still active, so the run started on a fresh workspace.
 */
export type SessionRotationReason =
  | 'policy_changed'
  | 'prompt_changed'
  | 'memory_changed'
  | 'model_changed'
  | 'context_limit'
  | 'storage_expired';

/** How a coding turn lost its native session before rebuilding context from the thread. */
export type ContextLoss = 'reset' | 'rotation';

/**
 * Per-run context envelope of a coding turn: counts of what the prompt
 * rendered (never text). `messages`: thread messages in the prompt (first
 * turn: the whole claimed revision; resume: the added and edited ones);
 * `priorAnswers`: earlier answers rendered (first turn only), of which
 * `recoveredAnswers` came from Slack history after a state reset;
 * `rotationReason`: why a first turn replaced an earlier native session.
 */
export interface ContextEnvelopeDto {
  hash: string;
  messages: number;
  priorAnswers: number;
  recoveredAnswers: number;
  firstTurn: boolean;
  rotationReason: SessionRotationReason | null;
}

/** One reconciled publication (task branch + task MR) of a GitLab project. */
export interface PublicationRecordDto {
  state: string;
  /** Canonical project path. */
  project: string;
  commit: string | null;
  tree: string | null;
  branch: string | null;
  targetBranch: string | null;
  projectId: number;
  mrIid: number | null;
  mrUrl: string | null;
  lastError: string | null;
}

export interface RunCompleteRequest {
  /** Final controller snapshot, committed atomically with coding completion. */
  projectEvidence?: TaskProjectEvidenceDto[];
  runId: string;
  runSeq: number;
  attempt: number;
  runnerId: string;
  result: RunResultDto;
}

export interface RunCompleteResponse {
  accepted: boolean;
  operationId: string;
}

export interface RunFailRequest {
  kind: 'simulated' | 'claude' | 'coding';
  runId: string;
  runSeq: number;
  attempt: number;
  runnerId: string;
  error: string;
  /** Sanitized failure category (a known Claude failure category); drives recovery lifecycle. */
  category?: string;
  /** The fixed reason (RUN_FAILURE_REASONS) the runner failed the run for, when it has one. */
  reason?: RunFailureReason;
  /** Coding-only: the structural tool trace of the failed run. */
  toolTrace?: ToolTraceDto;
}

export interface RunFailResponse {
  accepted: boolean;
  operationId: string | null;
}

export interface InferenceReserveRequest {
  /** Stable logical invocation identity. ACK reconciliation repeats this exact ID;
   * a repeated admission never authorizes another provider call. */
  operationId: string;
  runId: string;
  runSeq: number;
  attempt: number;
  runnerId: string;
  /** Effective ceiling is persisted on first reservation and cannot subsequently increase. */
  maxInvocations?: number;
}
export interface InferenceReserveResponse {
  allowed: true;
  /** 1-based durable count of reserved invocations for this logical run. */
  inferenceSeq: number;
  maxInferenceInvocations: number;
  remaining: number;
}

export interface OutboxClaimRequest {
  claimerId: string;
  nowMs: number;
  leaseMs: number;
}

export interface OutboxClaimedOperation {
  inputEpoch: number;
  /** Fixed, update-only closure notice; never ordinary output or a new post. */
  closureStatus?: boolean;
  resultOrigin?: { workspaceId: string; generation: number };
  fileLeaseToken?: string;
  inputDependencies?: SlackFileDescriptorDto[];
  files?: FileDeliveryDto[];
  operationId: string;
  /** Owning run, or null for run-independent control receipts. */
  runSeq: number | null;
  channelId: string;
  threadTs: string;
  text: string;
  state: 'pending' | 'uncertain';
  attempts: number;
  /** Revision the adapter must deliver and confirm back. */
  desiredRevision: number;
  /** Whether the claimed revision is the terminal answer/failure. */
  terminal: boolean;
  /** Known Slack timestamp: post when null, update when set. */
  slackTs: string | null;
  /** Owning control for exceptional control receipts, otherwise null. */
  controlId: string | null;
  /** Button to render under the message, or null for plain text. */
  /** Native pause identity carried by Continue/Cancel button values. */
  pauseId?: string | null;
  actions: OutboxAction | null;
  /** Context line under the message (final answers: model footer), or null. */
  footer: string | null;
  /**
   * Whether the claimed revision is a completed answer (as opposed to
   * progress, a failure/cancellation notice, or a control receipt).
   * Delivered as Slack message metadata for history recovery.
   */
  answer: boolean;
}

/** Origin is always the owning task; neither model nor adapter chooses a destination. */
export interface FileDeliveryDto {
  /** Operator-only orphan journal entry. Has no normal outbox/delivery authority. */
  orphan?: true;
  source?: { workspaceId: string; generation: number; exportId?: string };
  id: string;
  operationId: string;
  runSeq: number;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  incomplete: boolean;
  stage:
    | 'pending'
    | 'allocating'
    | 'allocated'
    | 'transferred'
    | 'completing'
    | 'shared'
    | 'delivered'
    | 'uncertain'
    | 'abandoned';
  fileId: string | null;
  permalink: string | null;
  revision: number;
}

export interface DeliverableDto {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  workspaceId: string;
  generation: number;
}

/**
 * `POST /cancel`: a Cancel-button click on a run's progress message.
 * `runOperationId` is the message's operation ID carried in the button;
 * `actionId` is unique per click (Socket Mode redelivery repeats it).
 */
export interface CancelActionRequest {
  actionId: string;
  userId: string;
  runOperationId: string;
  messageTs: string;
  /** Exact pause rendered by the native coordinator. */
  pauseId?: string;
  adapter?: AdapterInteractionDto;
}

/**
 * `recorded`: the cancellation is durable and the run message will update.
 * `duplicate`: this click was already recorded. `unauthorized`: the user is
 * not the person who started the run (or lacks task.cancel); nothing
 * changed. `stale`: the message's run is no longer queued or running.
 * `expired`: the task instance has ended.
 */
export interface CancelActionResponse {
  outcome: 'recorded' | 'duplicate' | 'unauthorized' | 'stale' | 'expired';
}

/**
 * `POST /continue`: a Continue-button click on a run paused at a soft limit.
 * Same shape and fencing as a Cancel click.
 */
/** Installed adapter attestation, sent only across the authenticated private transport.
 * User identity comes from the verified Socket Mode envelope, never model input. */
export interface AdapterInteractionDto {
  installationId: string;
  teamId: string;
  channelId: string;
  rootTs: string;
  botId: string;
}

export interface ContinueActionRequest {
  actionId: string;
  userId: string;
  runOperationId: string;
  messageTs: string;
  /** Exact pause rendered by the native coordinator. */
  pauseId?: string;
  adapter?: AdapterInteractionDto;
}

/**
 * `recorded`: the run continues (a waiting run at once, a parked run as a
 * queued continuation). `duplicate`: this pause was already continued.
 * `unauthorized`: the user is not the person who started the run.
 * `stale`: the message's run is not paused (anymore), or a later request
 * replaced it. `busy`: no capacity for the parked run's continuation now.
 * `expired`: the task instance has ended.
 */
export interface ContinueActionResponse {
  outcome: 'recorded' | 'duplicate' | 'unauthorized' | 'stale' | 'busy' | 'expired';
}

/** The active run a just-queued ordinary run may still steer, and that queued run. */
export interface SteerableIntake {
  /** The running run whose steering window was open at intake. */
  runSeq: number;
  /** The queued follow-up run the mention created (the conversion's handle). */
  followupRunId: string;
}

/**
 * `POST /steer`: *Steer the current run* on the ephemeral offer under a
 * mention that was queued as a follow-up. `actionId` identifies the click
 * (Socket Mode redelivery repeats it).
 */
export interface SteerFollowupRequest {
  actionId: string;
  userId: string;
  followupRunId: string;
}

/**
 * `steering`: the queued follow-up was withdrawn and its text is a pending
 * steering command for the active run (a repeat click answers the same).
 * `too_late`: the window closed, the active run ended, or the follow-up
 * already started; nothing changed and the follow-up stays queued.
 * `not_author`: only the mention's author may convert it. `unauthorized`:
 * `task.steer` is denied by policy. `unknown`: no such follow-up.
 * `expired`: the task instance has ended.
 */
export interface SteerFollowupResponse {
  outcome: 'steering' | 'too_late' | 'not_author' | 'unauthorized' | 'unknown' | 'expired';
  /** The steered run (outcome `steering`), else null. */
  runSeq: number | null;
  /** The steering control (outcome `steering`), else null. */
  controlId: string | null;
}

export interface RunProgressRequest {
  checklist?: TaskChecklistDto;
  projectEvidence?: TaskProjectEvidenceDto[];
  runId: string;
  runSeq: number;
  attempt: number;
  runnerId: string;
  /** Coding-only ownership generation; omitted for answer-only runs. */
  generation?: number;
  /** Monotonic within one claimed attempt; duplicates are idempotent. */
  seq: number;
  stage: AgentProgressStage;
  source: AgentProgressSource;
  toolCategory?: AgentToolCategory;
  occurredAtMs?: number;
  /**
   * Admin debugging metadata of the latest tool call: exact SDK tool name
   * (`^[A-Za-z0-9_.:-]{1,96}$`), 1-based call count within the attempt, and
   * observation time. Stored on the run, never rendered in Slack.
   */
  toolName?: string;
  toolCalls?: number;
  toolStartedAtMs?: number;
  /**
   * Coding runs: the soft-limit state. `paused_soft_limit` requires an open
   * pause (the message shows its crossed metrics with Continue and Cancel);
   * other stages show the raised metrics after the stage label.
   */
  softLimits?: SoftLimitStateDto;
}

export interface RunProgressResponse {
  accepted: boolean;
  /** Highest accepted sequence for this attempt. */
  seq: number;
  /** Current desired Slack revision for the run. */
  revision: number;
  duplicate: boolean;
}

export interface OutboxClaimResponse {
  operations: OutboxClaimedOperation[];
}

export interface OutboxCompleteRequest {
  /** Exact claim token required for native answer file delivery. */
  fileLeaseToken?: string;
  operationId: string;
  /**
   * Claimed revision being confirmed. A confirmation for an older revision
   * never marks a newer desired revision delivered.
   */
  revision?: number;
  outcome:
    | { kind: 'delivered'; slackTs: string }
    | { kind: 'retry'; retryAfterMs: number; error?: string }
    | { kind: 'uncertain'; error?: string };
}

export interface OutboxCompleteResponse {
  state: string;
  attempts: number;
  exhausted: boolean;
}

export interface OutboxReconciledRequest {
  /** Exact claim token required for native answer file delivery. */
  fileLeaseToken?: string;
  operationId: string;
  slackTs: string;
  /** Revision found in Slack; confirms exactly that revision when set. */
  revision?: number;
}

export interface ApiError {
  error: string;
  stale?: boolean;
  currentAttempt?: number;
  currentStatus?: string;
  busyRunId?: string;
  busyRunSeq?: number;
  busyAttempt?: number;
}

export interface IndexSyncRequest {
  summary: TaskSummary;
}

/** Task-instance lifecycle states persisted in the task cell's meta. */
export type TaskInstanceLifecycle = 'active' | 'expiring' | 'expired';

export interface RegisterRequest {
  taskKey: string;
  nowMs: number;
}

export interface RegisterResponse {
  registered: boolean;
}

export interface SummaryRequest {
  taskKey: string;
  summary: TaskSummary;
  nowMs: number;
  /** Instance identity publishing this summary (fences stale instances). */
  instanceId: string;
  /** Monotonic incarnation counter; a newer instance always wins. */
  instanceSeq: number;
}

export interface UnregisterRequest {
  taskKey: string;
  /** Expected owning instance; a mismatch (revival) must not delete. */
  instanceId: string;
}

export interface UnregisterResponse {
  unregistered: boolean;
  /** True when the stored row belongs to a different instance. */
  conflict: boolean;
}

// -- Admission authority (registry-owned reservation protocol) ---------------
//
// Cross-thread actor/workspace limits need one serialized admission
// authority; the singleton registry DO is it. Reservations are stable,
// event-derived IDs so duplicate Slack deliveries reuse the same decision
// and never consume a second slot. Reserve happens before admitting new
// work; the accepting cell records the reservation with the run and commits
// it; release is idempotent from every terminal transition. The registry
// expires an abandoned reservation only after confirming with the owning
// cell that no run (in any state) owns it — a timer alone never releases a
// live run's capacity.

export type AdmissionReservationState = 'reserved' | 'committed' | 'released';

export interface AdmissionReserveRequest {
  /** Stable event-based identity (idempotent across redelivery). */
  reservationId: string;
  taskKey: string;
  actorUserId: string;
  teamId: string;
  nowMs: number;
}

export interface AdmissionReserveResponse {
  admitted: boolean;
  /** Echoed state when the reservation already existed (duplicate delivery). */
  state?: AdmissionReservationState;
  /** Set when admitted is false. */
  scope?: AdmissionScope;
  limit?: number;
}

export interface AdmissionCommitRequest {
  reservationId: string;
  nowMs: number;
}

export interface AdmissionCommitResponse {
  committed: boolean;
}

export interface AdmissionReleaseRequest {
  reservationId: string;
}

export interface AdmissionReleaseResponse {
  released: boolean;
}

export interface AdmissionOwnershipResponse {
  /** True when any run in this cell (any status) holds the reservation. */
  owned: boolean;
}

/** Bounded aggregate admission view for PR-4 scrapes (read-only). */
export interface AdmissionStatsResponse {
  limits: { perThread: number; perActor: number; perWorkspace: number };
  active: { total: number; reserved: number; committed: number };
  /** Active reservations per key, top 10 per scope (bounded output). */
  perActor: Array<{ key: string; count: number }>;
  perWorkspace: Array<{ key: string; count: number }>;
  counters: { admitted: number; rejected: number; expired: number; confirmFailures: number };
}

export type PendingQuery = readonly PendingFlag[];

/** Persistent coding workspace allocation (allocation intent before creation). */
export interface CodingClaimFence {
  runId: string;
  runSeq: number;
  attempt: number;
  runnerId: string;
  generation: number;
}

export interface CodingEnsureRequest extends CodingClaimFence {
  /** Workspace kind: `gitlab` (checkouts per cloned project) or `fixture` (tests). */
  repoId: string;
  /** Source revision pinned at allocation (fixture file hash, or the GitLab host identity). */
  sourceRevision: string;
  /** Operator storage identity (volume/container name), opaque to Slack. */
  storageId: string;
  /** Resolved non-secret execution profile recorded per run. */
  execProfile?: {
    commandTimeoutMs: number;
    maxOutputBytes: number;
    maxRepairAttempts: number;
    testCommand: string;
  };
}

/** Records one cloned GitLab project for the task (idempotent per project ID). */
export interface CodingRepositoryRequest extends CodingClaimFence {
  workspaceId: string;
  projectId: number;
  canonicalPath: string;
  targetBranch: string;
  taskBranch: string;
  baseCommit: string;
}

export interface CodingReadyRequest extends CodingClaimFence {
  workspaceId: string;
  baseCommit: string;
  branch: string;
}

export interface CodingSessionRequest extends CodingClaimFence {
  /** Fenced catalog/binding rotation from a prior completed run's session. */
  rotateFromSessionId?: string;
  workspaceId: string;
  sessionId: string;
  sdkVersion: string;
  model: string;
  resumed: boolean;
}

export interface CodingRecoverRequest {
  reason: string;
  recoveryId: string;
  generation: number;
}

/**
 * The runner found the claimed workspace's storage idle-expired:
 * `allocationId` names the runner allocation whose tombstone says so. The agent
 * replaces the workspace with a fresh one (new identity and task branch, no
 * session, no cloned repositories) under the same generation.
 */
export interface CodingStorageExpiredRequest extends CodingClaimFence {
  workspaceId: string;
  allocationId: string;
}

/** Fence shared by every run-control command (open/drain/resolve/cancel). */
export interface RunControlFence {
  runId: string;
  runSeq: number;
  attempt: number;
  runnerId: string;
}

export interface ControlOpenResponse {
  opened: boolean;
  steeringState: SteeringState;
}

export interface ControlDrainResponse {
  draining: boolean;
  /** Pre-barrier controls the runner must resolve before completion. */
  pending: Array<{
    controlId: string;
    providerMessageId: string;
    /** Full instruction text (same authorization as heartbeat delivery). */
    instructionText: string;
    sourceMessageTs: string;
    state: 'pending' | 'dispatching';
  }>;
}

/** Durable admission at the actual provider dispatch boundary, after context checks. */
export interface ControlDispatchRequest extends RunControlFence {
  operationId: string;
  inferenceSeq: number;
  /** Explicit ordered batch, at most 8 commands / 24 KB of instruction text. */
  controlIds: string[];
}
export interface ControlDispatchResponse {
  /** Only a new admission permits dispatch. Reconciliation never permits replay. */
  dispatch: boolean;
  controlIds: string[];
  providerMessageIds: string[];
}

export interface ControlResolveRequest extends RunControlFence {
  /** Observed provider evidence: UUID echo or a completed native response bound to the exact batch. */
  appliedControlIds: string[];
  /** Dispatched-but-unconfirmed controls: honestly marked uncertain. */
  uncertainControlIds: string[];
  /** Never-dispatched controls to convert into ordinary follow-up runs. */
  convertControlIds: string[];
  /** Current owner proves these heartbeat leases never entered provider input.
   * Must be a subset of convertControlIds; admitted dispatch batches cannot return. */
  neverSubmittedControlIds?: string[];
}

export interface ControlResolveResponse {
  applied: string[];
  uncertain: string[];
  converted: Array<{ controlId: string; runSeq: number; runId: string }>;
}

export interface ControlCloseResponse {
  closed: boolean;
  steeringState: SteeringState;
}

export interface CancelCompleteRequest extends RunControlFence {
  /** Current owner proves these heartbeat leases never entered provider input.
   * Persisted dispatch admissions are never returnable, even during cancellation. */
  neverSubmittedControlIds?: string[];
  /** Categorical evidence only: confirmed | provider_unconfirmed | effects_uncertain. */
  outcome: CancellationOutcome;
  /** Steering controls with observed provider evidence before the abort. */
  appliedControlIds?: string[];
  /** Safe MR link when a publication already committed, otherwise null. */
  mrUrl?: string | null;
}

/**
 * `POST /runs/park`: a run paused at a soft limit got no answer within the
 * pause wait. Its session and snapshot stay with the task; the run becomes
 * `paused` (not a failure) and keeps its Continue and Cancel buttons.
 */
export interface RunParkRequest extends RunControlFence {
  /** Trusted native observations retained across this exact pause, never replay grants. */
  confirmedToolCalls?: ConfirmedToolCallDto[];
  /** Final accounting revision, after every flushed progress report. */
  softLimitRevision?: number;
  retention?: Extract<CodingClarificationDto['retention'], { status: 'held' }>;
  /** Coding ownership generation. */
  generation?: number;
  /** The state at the pause (its `pause` must be set). */
  softLimits: SoftLimitStateDto;
}

export interface RunParkResponse {
  parked: boolean;
}

export interface CancelCompleteResponse {
  cancelled: boolean;
  runSeq: number;
  outcome: CancellationOutcome;
  operationId: string | null;
}

// -- automatic thread replies ------------------------------------------

/**
 * `POST /tasks/:key/replies/check` and `/replies/enqueue`: an ordinary
 * (untagged) reply in a thread the bot was invited to. The adapter sends only
 * real thread replies of people (or the designated test sender) that do not
 * mention the bot; `check` writes nothing, `enqueue` records the reply as a
 * classification candidate when the thread still participates.
 */
export interface ReplyCandidateRequest {
  installationId: string;
  teamId: string;
  channelId: string;
  rootTs: string;
  eventId: string;
  messageTs: string;
  userId: string;
  /** Original event text (kept as the instruction when it is accepted). */
  text: string;
  /** Canonical text/blocks/attachments of the reply. */
  canonicalText: string;
  authorBotId: string | null;
}

/**
 * `queued`: recorded for classification. `duplicate`: this message was
 * already recorded (or accepted through a mention). Every other outcome
 * names why the reply stays silent; nothing was recorded.
 */
export type ReplyCandidateOutcome =
  | 'eligible'
  | 'queued'
  | 'duplicate'
  | 'unknown_thread'
  | 'not_participating'
  | 'paused'
  | 'disabled'
  | 'unauthorized'
  | 'closed'
  | 'expired'
  | 'overflow'
  | 'rate_limited';

export interface ReplyCandidateResponse {
  outcome: ReplyCandidateOutcome;
  candidateId: string | null;
}

/** `POST /tasks/:key/replies/claim`: the runner's classification lease. */
export interface ReplyClaimRequest {
  runnerId: string;
  leaseMs: number;
}

/** Bounded, untrusted classification input; never instructions. */
export interface ReplyClassificationInput {
  /** The reply itself (author, Slack ts, text bounded to 2,000 characters). */
  reply: { ts: string; userId: string; text: string };
  /** What the thread is doing now. */
  activity: 'running' | 'queued' | 'waiting_for_answer' | 'idle';
  /** The current objective's request text (bounded). */
  objective: string | null;
  /** The bot's latest answer or progress text (bounded). */
  lastBotMessage: string | null;
  /** The open clarification question (bounded), when waiting. */
  question: string | null;
  /** Up to six earlier thread messages, oldest first (bounded). */
  recent: Array<{ ts: string; author: string; text: string }>;
}

export interface ReplyClaimResponse {
  /** Deployment-owned classifier model pinned at claim; null in the parked engine. */
  model: string | null;
  candidateId: string;
  attempt: number;
  leaseExpiresMs: number;
  input: ReplyClassificationInput;
}

export type ReplyLabel =
  | 'instruction'
  | 'answer'
  | 'context'
  | 'status'
  | 'unrelated'
  | 'ambiguous';

/** `POST /tasks/:key/replies/settle`: the fenced classification outcome. */
export interface ReplySettleRequest {
  candidateId: string;
  attempt: number;
  runnerId: string;
  /** `classified` with a validated label, or `failed` (model error, malformed output, budget). */
  outcome: 'classified' | 'failed';
  label?: ReplyLabel;
  /** The reply is addressed to the bot (not to a colleague). */
  directed?: boolean;
  confidence?: 'high' | 'low';
  /** Fixed failure code when `failed` (never model text). */
  failure?: string;
  model: string | null;
  promptVersion: string;
  latencyMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * The applied decision. `steered`, `attached` (pending steering for the
 * next queued run), `answered`, `followup` (a new run) and `status` act;
 * every `silent_*` decision changes nothing and posts nothing.
 */
export type ReplyDecision =
  | 'steered'
  | 'attached'
  | 'answered'
  | 'followup'
  | 'status'
  | 'busy'
  | 'rejected'
  | 'silent_label'
  | 'silent_stale'
  | 'silent_paused'
  | 'silent_disabled'
  | 'silent_unauthorized'
  | 'silent_closed'
  | 'silent_failed'
  | 'silent_late'
  | 'silent_withdrawn'
  | 'silent_rate_limited';

export interface ReplySettleResponse {
  decision: ReplyDecision;
}

/**
 * `POST /tasks/:key/participation`: a Pause/Resume replies click. The
 * button carries the operation ID of the message it was rendered on;
 * `actionId` deduplicates Socket Mode redelivery.
 */
export interface ParticipationActionRequest {
  actionId: string;
  userId: string;
  operationId: string;
  action: 'pause' | 'resume';
}

/**
 * `recorded`: the thread is now paused (or resumed). `unchanged`: it already
 * was. `unauthorized`: pausing needs task.steer, resuming is the thread
 * owner's. `stale`: the button belongs to an earlier pause or another task
 * instance. `expired`: the task instance has ended.
 */
export interface ParticipationActionResponse {
  outcome: 'recorded' | 'unchanged' | 'unauthorized' | 'stale' | 'expired';
}

/** Read-only participation view (inspection, admin Threads tab). */
export interface ReplyParticipationDto {
  state: 'active' | 'paused';
  epoch: number;
  ownerUserId: string;
  pausedBy: string | null;
  pauseReason: 'button' | 'cancelled' | null;
  candidates: Array<{
    candidateId: string;
    messageTs: string;
    userId: string;
    state: 'queued' | 'classifying' | 'settled';
    label: ReplyLabel | null;
    directed: boolean | null;
    confidence: 'high' | 'low' | null;
    decision: ReplyDecision | null;
    model: string | null;
    promptVersion: string | null;
    latencyMs: number | null;
    /** The runner's bounded failure code of a failed classification. */
    failure: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }>;
}

/** Server-issued publication-only ownership. It is never an inference/run claim. */
export interface PublicationRecoveryClaimDto {
  recoveryId: string;
  claimId: string;
  attempt: number;
  runnerId: string;
  leaseExpiresMs: number;
  coding: CodingStatusDto;
  runId: string;
  runSeq: number;
  historicalAttempt: number;
  tools: ChannelToolsDto;
  projects: Array<{
    projectId: number;
    canonicalPath: string;
    targetBranch: string;
    taskBranch: string;
    baseCommit: string;
    commit: string;
    tree: string;
    treeDigest: string;
    expectedRemoteHead: string | null;
    testedTreeHash: string;
    mrIid: number | null;
  }>;
}

/** Private trusted-runner saved-result lease; never inference authority. */
export interface ResultRecoveryClaimDto {
  recoveryId: string;
  claimId: string;
  runnerId: string;
  attempt: number;
  leaseExpiresMs: number;
  inputEpoch: number;
  workspaceId: string;
  coding: CodingStatusDto;
  runId: string;
  runSeq: number;
  historicalAttempt: number;
  originalRunnerId: string;
  execution: ExecutionIdentityDto;
  receipt: { journalDigest: string; resultDigest: string } | null;
}
