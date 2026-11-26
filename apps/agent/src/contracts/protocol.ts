/** Shared task identity and private service wire vocabulary. */

import { SLACK_TS_PATTERN, compareTs, messageId } from './task-key.js';

export {
  TaskKeyError,
  buildTaskKey,
  compareTs,
  displayTaskId,
  messageId,
  parseTaskKey,
} from './task-key.js';

/**
 * Version of the agent's service contract (dto.ts plus the types in this
 * file). The Slack adapter vendors it into `src/generated/protocol.ts` via
 * `npm run generate:protocol`; the contract test fails when the generated
 * mirrors drift. Bump together with any incompatible DTO change and
 * regenerate.
 */
export const PROTOCOL_VERSION = 30;

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
 * Upper bound of an admin channel system prompt in UTF-16 code units; same
 * bound as the admin service (`apps/admin/src/prompts.ts`).
 */
export const MAX_CHANNEL_PROMPT_CHARS = 4_000;

/** Operator model allowlist keys: lowercase, bounded, `default` reserved. */
export const MODEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

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
