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
 * Version of the agent's service contract (dto.ts plus the types in this
 * file). The Slack adapter vendors it into `src/generated/protocol.ts` via
 * `npm run generate:protocol`; the contract test fails when the generated
 * mirrors drift. Bump together with any incompatible DTO change and
 * regenerate.
 *
 * @public
 */
export const PROTOCOL_VERSION = 30;

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

export function isAgentProgressStage(value: unknown): value is AgentProgressStage {
  return typeof value === 'string' && (AGENT_PROGRESS_STAGES as readonly string[]).includes(value);
}

export function isAgentToolCategory(value: unknown): value is AgentToolCategory {
  return typeof value === 'string' && (AGENT_TOOL_CATEGORIES as readonly string[]).includes(value);
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

/** JSON request/response contracts for private application service boundaries. */

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

export interface SlackFileDescriptorDto {
  id: string;
  sourceTs: string;
  name: string;
  mime: string;
  bytes: number;
  revision: string;
  hosted: boolean;
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
    | 'codeMode';
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
