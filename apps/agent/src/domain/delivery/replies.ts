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

/** Run message text while a requested cancellation is being confirmed (no Cancel button). */
export const CANCELLING_PROGRESS_TEXT = `${PROGRESS_MARKER} Cancelling…`;

/** Run message text after Continue on a paused run, until the run reports progress again. */
export const CONTINUING_PROGRESS_TEXT = `${PROGRESS_MARKER} Continuing…`;

/** Marks a run message paused at a soft run limit (Continue and Cancel buttons). */
export const PAUSE_MARKER = '⏸';

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

/** Text of a run paused at its crossed soft limits. */
export function renderPausedText(crossed: readonly SoftLimitReading[]): string {
  return `${PAUSE_MARKER} Paused: ${crossed.map(renderSoftLimitReading).join(' · ')}`;
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
 * Fixed server-owned control receipts. Never echo steering text, user IDs,
 * provider errors, tool output, or cancellation internals.
 */
export const CONTROL_REPLY_NO_ACTIVE_RUN = 'There is no active request to cancel.';

/** Denied cancellation: only the run's author may cancel it (steering is open to the channel's people). */
export const CONTROL_REPLY_UNAUTHORIZED =
  'Only the person who started the active request can cancel it.';

/** Denied `task.start` (the channel's people list). */
export const CONTROL_REPLY_NOT_AUTHORIZED_TASK =
  'You are not authorized to start or add to requests in this channel. Ask an administrator for access.';

/** Denied because no one is granted anything in this channel (not enabled by an admin). */
export const CONTROL_REPLY_CHANNEL_NOT_ENABLED =
  'This channel is not enabled for the bot. Ask an administrator to enable it.';

export const CONTROL_REPLY_UNCERTAIN =
  'That update could not be confirmed as applied. Review the final result before retrying.';

export const CONTROL_REPLY_QUEUED_FOLLOWUP =
  'The update arrived after the active request stopped accepting changes, so it was queued as a follow-up.';

export const CONTROL_REPLY_EMPTY_UPDATE =
  'That update was empty. Mention the bot with `update: <instruction>` to change the active request.';

export const CONTROL_REPLY_BUSY =
  'The task queue is at capacity right now, so this request was not started. Try again shortly.';

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

export function buildFailureReply(args: { reason: string }): string {
  const reason = args.reason.length > 120 ? `${args.reason.slice(0, 120)}...` : args.reason;
  return `Simulated run failed: ${reason}. No coding task was executed.`;
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

/**
 * Coding-result reply text. Built by the task cell from validated result
 * fields (never from transcripts or patches): the model's summary, followed
 * by one short status line only when code changed or a partial result was
 * kept (files changed, verification outcome, merge request, recovery). Tool
 * answers and clarifications are the summary alone, plus links to any merge
 * requests they published. The status line always
 * survives the `maxChars` bound; the summary is shortened instead.
 */
export function buildCodingReply(args: CodingReplyArgs): string {
  return codingReply(args).text;
}

export interface CodingReplyArgs {
  changedFiles: number;
  verification: string;
  recoveryNeeded: boolean;
  summaryText?: string;
  clarification?: boolean;
  /** Tool-driven outcomes: a tool answer without changes, or a partial result. */
  discovery?: boolean;
  partial?: boolean;
  maxChars: number;
  /** Merge requests created or updated by this run (one per published project). */
  mergeRequests?: Array<{ project: string; mrUrl: string; mrIid?: number | null }>;
}

/** `buildCodingReply` plus whether the cell cut the summary at the bound. */
export function codingReply(args: CodingReplyArgs): { text: string; truncated: boolean } {
  const max = Math.min(3000, Math.max(200, Math.floor(args.maxChars)));
  const summary = (args.summaryText ?? '').trim();
  const status = codingStatusLine(args);
  if (status === null) {
    const body = summary.length > 0 ? summary : 'Done. No code changes were needed.';
    return body.length > max
      ? { text: cutWithNotice(body, max), truncated: true }
      : { text: body, truncated: false };
  }
  if (summary.length === 0) {
    return { text: status, truncated: false };
  }
  const budget = Math.max(0, max - status.length - 2);
  const truncated = summary.length > budget;
  const shortened = truncated ? cutWithNotice(summary, budget) : summary;
  return { text: `${shortened}\n\n${status}`, truncated };
}

/** Markdown links of a turn's merge requests (one label per project when several). */
export function mergeRequestLinks(
  mrs: Array<{ project: string; mrUrl: string; mrIid?: number | null }>,
): string[] {
  return mrs.map((mr) => {
    const label = mrs.length === 1 ? 'Merge request' : `Merge request ${mr.project}`;
    return `[${label}${mr.mrIid ? ` !${mr.mrIid}` : ''}](${mr.mrUrl})`;
  });
}

function codingStatusLine(args: {
  changedFiles: number;
  verification: string;
  recoveryNeeded: boolean;
  clarification?: boolean;
  discovery?: boolean;
  partial?: boolean;
  mergeRequests?: Array<{ project: string; mrUrl: string; mrIid?: number | null }>;
}): string | null {
  const links = mergeRequestLinks(args.mergeRequests ?? []);
  if (args.clarification || args.discovery) {
    // A tool answer changed no code; it still links merge requests it published.
    return links.length > 0 ? links.join(' · ') : null;
  }
  const files = `${args.changedFiles} ${args.changedFiles === 1 ? 'file' : 'files'} changed`;
  const parts = args.partial
    ? ['⚠️ Partial result', files, 'not verified']
    : ['✅ ' + files, `verification ${args.verification}`];
  parts.push(...links);
  if (args.recoveryNeeded) {
    parts.push('recovery needed before follow-up work');
  }
  return parts.join(' · ');
}

/**
 * the recovery notice of a run fenced by an expired question's
 * retained, unpublished files. Names the retained checkouts (directory names
 * only) and both exits; never publishes or discards them.
 */
export function buildRetentionExpiredReply(error: string): string {
  const listed = error.startsWith('retention_expired: ')
    ? error
        .slice('retention_expired: '.length)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => /^[A-Za-z0-9_.-]{1,120}$/.test(name))
        .slice(0, 10)
    : [];
  const paths =
    listed.length === 0 ? 'the task workspace' : listed.map((n) => `\`${n}\``).join(', ');
  return (
    `⚠️ An earlier clarification question in this thread expired, and its unpublished files are still retained (${paths}). ` +
    'I do not continue or publish them automatically, for anyone, so this request did not run. ' +
    'The block clears by itself when the ordinary cleanup removes those idle files; a new mention then starts from a fresh workspace. ' +
    'Alternatively an operator can recover the thread with `scripts/recover-thread.mjs`, which keeps the files for the next request without publishing them.'
  );
}

export function buildCodingFailureReply(args: { reason: string }): string {
  const reason = args.reason.length > 160 ? `${args.reason.slice(0, 160)}...` : args.reason;
  return `❌ The coding request failed: ${reason}.`;
}
