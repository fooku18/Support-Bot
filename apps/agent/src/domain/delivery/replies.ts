/** Fixed application-owned Slack reply rendering and safe failure labels. */
import {
  CANCELLATION_CONFIRMED,
  CANCELLATION_LEASE_EXPIRED,
  type AgentProgressStage,
  type AgentToolCategory,
  type CancellationOutcome,
  type ClaudeFailureCategory,
  type SoftLimitReading,
} from '../../contracts/protocol.js';
import { resultPreview } from './file-results.js';

/**
 * Marks a run message as still in progress. Terminal texts replace the whole
 * message, so the marker disappears with the final answer, failure, or
 * cancellation.
 */
export const PROGRESS_MARKER = '⏳';

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
 * Context line under a completed answer: a check mark and the model key the
 * run used. The model is chosen by admins per channel; there is no user
 * switch to advertise.
 */
export function buildAnswerFooter(modelKey: string): string {
  return `✅ Done · Model: *${modelKey}*`;
}

/**
 * Footer line of the first answer of a task whose turn rebuilt its context
 * from the thread: the native session (tool results, files read, reasoning)
 * was lost to a state reset or replaced by a rotation, so only the thread's
 * messages and earlier answer texts carried over.
 */
export function buildContextRebuiltNotice(
  loss: 'reset' | 'rotation',
  rotation:
    | 'policy_changed'
    | 'prompt_changed'
    | 'memory_changed'
    | 'model_changed'
    | 'context_limit'
    | 'storage_expired'
    | null,
): string {
  const cause =
    loss === 'reset'
      ? 'a service reset'
      : rotation === 'context_limit'
        ? 'a model request limit'
        : rotation === 'storage_expired'
          ? "the thread's workspace expired"
          : rotation === 'model_changed'
            ? 'a model change'
            : rotation === 'memory_changed'
              ? 'a channel memory change'
              : rotation === 'prompt_changed'
                ? 'a channel prompt change'
                : 'a tool change';
  return `Context rebuilt from this thread after ${cause}`;
}

/**
 * Terminal cancellation reply. States plainly that cancellation cannot undo
 * effects that already committed; includes the safe MR link when confirmed.
 */
export function buildCancellationReply(args: {
  outcome: CancellationOutcome;
  mrUrl?: string | null;
}): string {
  const outcomeNote =
    args.outcome === CANCELLATION_CONFIRMED
      ? 'The active request was stopped before further work started.'
      : args.outcome === CANCELLATION_LEASE_EXPIRED
        ? 'The active request was stopped; stop confirmation was unavailable when its lease expired.'
        : 'The active request was stopped, but some effects may already have occurred.';
  const mr = args.mrUrl ? `\nMerge request: ${args.mrUrl}` : '';
  return `🛑 Cancelled. ${outcomeNote}${mr}`;
}

/**
 * Deterministic simulated-result reply text. Built by the task cell from its
 * own durable state (never from conversation text).
 */
export function buildCompletionReply(args: {
  contextRevision: number;
  acceptedMessageCount: number;
}): string {
  return (
    `Simulated run completed · context revision ${args.contextRevision} · ` +
    `${args.acceptedMessageCount} context messages. No coding task was executed.`
  );
}

/**
 * Claude answer reply text. Built by the task cell from the validated
 * persisted answer (never from raw conversation text). The final text is
 * bounded by `maxChars`; when the answer must be shortened an explicit
 * truncation notice is included and the shortened text is what gets
 * persisted for delivery and future context (so later runs see what the
 * user saw).
 */
export function buildClaudeReply(args: { answerText: string; maxChars: number }): {
  text: string;
  persistedAnswerText: string;
  truncated: boolean;
} {
  const cleanAnswer = args.answerText.trim();
  const max = Math.min(3000, Math.max(200, Math.floor(args.maxChars)));
  if (cleanAnswer.length <= Math.min(max, 3000)) {
    return { text: cleanAnswer, persistedAnswerText: cleanAnswer, truncated: false };
  }
  const shortened = cutWithNotice(cleanAnswer, max);
  return { text: shortened, persistedAnswerText: cleanAnswer, truncated: true };
}

/** Slack previews never replace the retained full result. */
function cutWithNotice(text: string, max: number): string {
  return resultPreview(text, max);
}

const CLAUDE_FAILURE_LABELS: Record<ClaudeFailureCategory, string> = {
  provider_auth: 'Model provider authentication or access failed',
  model_unavailable: 'Configured model is unavailable',
  timeout: 'Model inference timed out',
  context_limit:
    'Model request exceeded a context or attachment limit; send a new message to retry with fresh thread context',
  output_limit: 'The model answer exceeded the configured output limit',
  invalid_response: 'The model returned an empty or invalid answer',
  transient: 'Model provider request failed; send a new message in this thread to retry',
  interrupted: 'Model inference was interrupted',
  budget_exhausted: 'Inference budget exhausted',
  config: 'Model execution is misconfigured',
  authorization_denied: 'This operation is not authorized for the Slack actor',
  storage_pressure: 'Storage capacity is full — new work paused',
  verification_failed: 'Independent verification failed',
  needs_recovery: 'Workspace or session needs operator recovery',
  publication_failed: 'Publication needs a task-scoped retry; verified work is retained',
  turn_limit: 'The model reached the configured turn limit. Reply in this thread to continue.',
  retention_expired:
    'An expired clarification question left unpublished files that fence new work in this thread',
};

export function claudeFailureLabel(category: ClaudeFailureCategory): string {
  return CLAUDE_FAILURE_LABELS[category];
}

/**
 * Sanitizes a Claude failure reason for Slack delivery and inspection: only
 * the short category label, plus a scrubbed admission-reason detail for
 * `storage_pressure` only (byte counts plus fixed words; never secrets,
 * bodies, or transcripts). All other categories discard detail so arbitrary
 * provider/model/Slack text never reaches the thread.
 */
export function sanitizeClaudeFailureReason(
  category: ClaudeFailureCategory,
  detail?: string,
): string {
  const label = claudeFailureLabel(category);
  if (category !== 'storage_pressure') {
    return label;
  }
  if (detail === undefined || detail.length === 0) {
    return label;
  }
  const scrubbed = detail
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, '[redacted]')
    .replace(/xox[bap]-[A-Za-z0-9-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (scrubbed.length === 0) return label;
  return `${label}: ${scrubbed}`;
}

export function buildClaudeFailureReply(args: { reason: string }): string {
  const reason = args.reason.length > 160 ? `${args.reason.slice(0, 160)}...` : args.reason;
  return `❌ The request failed: ${reason}.`;
}
