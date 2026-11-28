import { COMMAND_RECEIPT_TYPE } from './generated/channel-commands.js';
/**
 * Typed wrappers around the Slack Web API calls the adapter makes, with
 * explicit error classification: rate limited (retry-after honored),
 * definite Slack rejection, or ambiguous network outcome. Message text and
 * payloads are never included in error summaries.
 */

import type { Agent } from 'node:http';
import { ErrorCode, WebClient } from '@slack/web-api';
import { setTimeout as delay } from 'node:timers/promises';
import {
  deliveryMetadata,
  parseDeliveryMetadata,
  type DeliveryMetadata,
} from './generated/protocol.js';
import { describePostError, slackErrorCode } from './slackerrors.js';
import {
  chartFreeText,
  hasCharts,
  replyParts,
  withoutCharts,
  type ReplyPart,
} from './generated/slack-charts.js';

export type SlackFailure =
  | { kind: 'rate_limited'; retryAfterMs: number; summary: string }
  | { kind: 'definite'; summary: string }
  | { kind: 'ambiguous'; summary: string };

export class SlackPostError extends Error {
  readonly failure: SlackFailure;
  constructor(failure: SlackFailure) {
    super(failure.summary);
    this.name = 'SlackPostError';
    this.failure = failure;
  }
}

export interface PostResult {
  ts?: string;
}

export interface SlackDeps {
  fileAgent?: Agent;
  downloadFile?: (url: string, signal: AbortSignal) => Promise<Response>;
  webClient: WebClient;
  /** Bounded transport: receipt retries belong to durable reconciliation. */
  receiptWebClient?: WebClient;
  botUserId: string | undefined;
  /** This app's bot_id from auth.test (own replies carry it even without `user`). */
  botId?: string | undefined;
}

/** Native authority reads may wait for a definite 429, never reuse stale
 * authorization. Mutations and unknown transport outcomes are not retried. */
class NativeReadClient extends WebClient {
  override async apiCall(...args: Parameters<WebClient['apiCall']>) {
    const deadline = Date.now() + 20000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.apiCall(...args);
      } catch (error) {
        const rate = rateLimitedFailure(error);
        if (
          ![
            'conversations.info',
            'conversations.members',
            'conversations.replies',
            'files.info',
            'users.info',
          ].includes(args[0]) ||
          rate?.kind !== 'rate_limited' ||
          attempt >= 2 ||
          Date.now() + rate.retryAfterMs >= deadline
        )
          throw error;
        await delay(rate.retryAfterMs);
      }
    }
  }
}

export function createSlackClient(
  botToken: string,
  options: {
    rejectRateLimitedCalls?: boolean;
    slackApiUrl?: string;
    agent?: Agent;
    receiptTransport?: boolean;
    boundedReadRetries?: boolean;
  } = {},
): WebClient {
  const Client = options.boundedReadRetries ? NativeReadClient : WebClient;
  return new Client(botToken, {
    // Egress proxy (CONNECT) when the instance runs one; undefined is direct.
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    // Surface rate limits to callers so durable delivery owns retry decisions.
    rejectRateLimitedCalls: options.rejectRateLimitedCalls ?? true,
    maxRequestConcurrency: 3,
    // Durable journals own retries, especially one-shot external file completion.
    retryConfig: { retries: 0 },
    ...(options.receiptTransport ? { timeout: 5000 } : {}),
    // Test-only override for automated container verification (a fake Slack
    // API server). Undefined means the real Slack API.
    ...(options.slackApiUrl !== undefined ? { slackApiUrl: options.slackApiUrl } : {}),
  });
}

export const SLACK_TEXT_CHARS = 3_900;
const PREVIEW_SUFFIX = ' …';

/**
 * The top-level `text` Slack uses for notifications and as the fallback for
 * clients that cannot render blocks: the message text itself when it fits,
 * otherwise its head up to the last line break before the bound (a hard cut
 * when the head has no line break in its second half), followed by ` …`.
 */
export function previewText(text: string): string {
  if (text.length <= SLACK_TEXT_CHARS) return text;
  const room = SLACK_TEXT_CHARS - PREVIEW_SUFFIX.length;
  let head = text.slice(0, room);
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  const lineBreak = head.lastIndexOf('\n');
  if (lineBreak >= room / 2) head = head.slice(0, lineBreak);
  return `${head.trimEnd()}${PREVIEW_SUFFIX}`;
}

/** Bound on the footer context line (Slack allows 3000 characters). */
export const MAX_FOOTER_CHARS = 300;

/**
 * Reply blocks: the model Markdown, with each chart fence as a chart block in
 * its place, then the optional footer (final answers: check mark and model)
 * as a mrkdwn context line. The footer is not part of
 * the message text, so it never counts toward reply limits or feeds context.
 */
export function replyBlocks(text: string, footer: string | null = null): unknown[] {
  return partBlocks(replyParts(text), footer);
}

function partBlocks(parts: ReplyPart[], footer?: string | null): unknown[] {
  const line = footer?.trim() ?? '';
  return [
    ...parts.map((part) =>
      part.kind === 'text' ? { type: 'markdown', text: part.text } : part.block,
    ),
    ...(line.length === 0
      ? []
      : [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: line.slice(0, MAX_FOOTER_CHARS) }],
          },
        ]),
  ];
}

const BLOCK_REJECTIONS = new Set([
  'invalid_blocks',
  'invalid_blocks_format',
  'invalid_arguments',
  'msg_blocks_too_long',
]);

export const QUESTION_ACTION = 'ask_user_answer';

export interface QuestionChoices {
  toolCallId: string;
  options: string[];
}

function choiceBlock(choices: QuestionChoices) {
  return {
    type: 'actions',
    block_id: choices.toolCallId,
    elements: choices.options.map((option, i) => ({
      type: 'button',
      action_id: `${QUESTION_ACTION}:${i}`,
      text: { type: 'plain_text', text: option },
      value: option,
    })),
  };
}

export const FEEDBACK_ACTION = 'answer_feedback';
export const FEEDBACK_VOTES = { up: 'Helpful', down: 'Not helpful' } as const;
export type FeedbackVote = keyof typeof FEEDBACK_VOTES;

function feedbackBlock(runId: string) {
  return {
    type: 'actions',
    block_id: FEEDBACK_ACTION,
    elements: (Object.keys(FEEDBACK_VOTES) as FeedbackVote[]).map((vote) => ({
      type: 'button',
      action_id: `${FEEDBACK_ACTION}:${vote}`,
      text: { type: 'plain_text', text: FEEDBACK_VOTES[vote] },
      value: runId,
    })),
  };
}

export async function markQuestionAnswered(
  deps: SlackDeps,
  args: {
    channel: string;
    ts: string;
    message: { text?: string; blocks?: unknown[] };
    answer: string;
  },
): Promise<void> {
  const kept = (args.message.blocks ?? []).filter(
    (block) => (block as { type?: unknown } | null)?.type !== 'actions',
  );
  try {
    await deps.webClient.chat.update({
      channel: args.channel,
      ts: args.ts,
      text: args.message.text ?? args.answer,
      blocks: [
        ...(kept.length ? kept : replyBlocks(args.message.text ?? '')),
        { type: 'context', elements: [{ type: 'plain_text', text: `✓ ${args.answer}` }] },
      ] as never,
    });
  } catch (err) {
    throw asSlackPostError(err);
  }
}

/** Posts a reply in a thread. Throws SlackPostError on failure. */
export async function postMessage(
  deps: SlackDeps,
  args: {
    channel: string;
    thread_ts: string;
    text: string;
    footer?: string | null;
    choices?: QuestionChoices;
    feedbackRunId?: string;
    delivery: DeliveryMetadata;
  },
): Promise<PostResult> {
  const parts = replyParts(args.text);
  const post = (sent: ReplyPart[]) =>
    deps.webClient.chat.postMessage({
      channel: args.channel,
      thread_ts: args.thread_ts,
      // `text` is the notification fallback; the blocks render standard LLM
      // Markdown with Slack's native translator, not mrkdwn. Delivery
      // identity (operation, revision) travels as invisible message metadata
      // for history-based reconciliation, never in the visible text. A text
      // above the `text` bound is sent whole in the blocks only. The footer
      // stays out of `text` and notifications.
      text: previewText(chartFreeText(sent)),
      blocks: [
        ...partBlocks(sent, args.footer),
        ...(args.choices ? [choiceBlock(args.choices)] : []),
        ...(args.feedbackRunId ? [feedbackBlock(args.feedbackRunId)] : []),
      ] as never,
      metadata: deliveryMetadata(args.delivery),
    });
  try {
    const result = await post(parts).catch((err: unknown) => {
      if (!hasCharts(parts) || !BLOCK_REJECTIONS.has(slackErrorCode(err) ?? '')) throw err;
      return post(withoutCharts(parts));
    });
    const message = result.message as { ts?: string } | undefined;
    return { ts: typeof message?.ts === 'string' ? message.ts : undefined };
  } catch (err) {
    throw asSlackPostError(err);
  }
}

/**
 * Posts a private notice or channel command response. Throws SlackPostError on failure.
 */
export async function postEphemeral(
  deps: SlackDeps,
  args: { channel: string; user: string; thread_ts?: string; text: string; blocks?: unknown[] },
): Promise<void> {
  try {
    await deps.webClient.chat.postEphemeral({
      channel: args.channel,
      user: args.user,
      thread_ts: args.thread_ts,
      text: args.text,
      ...(args.blocks === undefined ? {} : { blocks: args.blocks as never }),
    });
  } catch (err) {
    throw asSlackPostError(err);
  }
}

/** Opens a modal for a click's `trigger_id` (valid for 3 s). Throws SlackPostError on failure. */
export async function openView(deps: SlackDeps, triggerId: string, view: unknown): Promise<void> {
  try {
    await deps.webClient.views.open({ trigger_id: triggerId, view: view as never });
  } catch (err) {
    throw asSlackPostError(err);
  }
}

/**
 * Adds an emoji reaction to a message (the intake acknowledgment hint).
 * Best-effort: callers log and ignore failures so a reaction problem never
 * blocks the Socket Mode acknowledgment. An `already_reacted` rejection is
 * treated as success (idempotent for duplicate redeliveries).
 * Throws SlackPostError on any other failure.
 */
export async function addReaction(
  deps: SlackDeps,
  args: { channel: string; timestamp: string; name: string },
): Promise<void> {
  try {
    await deps.webClient.reactions.add({
      channel: args.channel,
      timestamp: args.timestamp,
      name: args.name,
    });
  } catch (err) {
    if (reactionAlreadyPresent(err)) {
      return;
    }
    throw asSlackPostError(err);
  }
}

function reactionAlreadyPresent(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const data = (err as { data?: { error?: unknown } }).data;
  return data?.error === 'already_reacted';
}

export interface ReplyPage {
  messages: Array<{
    ts: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
    text?: string;
    /** Legacy attachments and Block Kit blocks, as Slack sent them (flattened in history.ts). */
    attachments?: unknown[];
    files?: unknown[];
    blocks?: unknown[];
    /** Bot posts: the posting name (`username`) and the bot's profile name. */
    username?: string;
    botProfileName?: string;
    edited?: { user: string; ts: string };
    /** This app's delivery metadata, when the message carries it. */
    delivery?: DeliveryMetadata;
    commandReceiptId?: string;
  }>;
  nextCursor?: string;
  isLimited?: boolean;
}

/** Fetches one page of conversations.replies. Throws SlackPostError on failure. */
export async function fetchRepliesPage(
  deps: SlackDeps,
  args: {
    channel: string;
    rootTs: string;
    cursor?: string;
    limit: number;
    oldest?: string;
    latest?: string;
  },
): Promise<ReplyPage> {
  try {
    const result = await deps.webClient.conversations.replies({
      channel: args.channel,
      ts: args.rootTs,
      limit: args.limit,
      cursor: args.cursor,
      ...(args.oldest ? { oldest: args.oldest } : {}),
      ...(args.latest ? { latest: args.latest } : {}),
      include_all_metadata: true,
    });
    const wide = result as unknown as {
      response_metadata?: { next_cursor?: string };
      messages?: Array<Record<string, unknown>>;
      is_limited?: boolean;
    };
    const metadata = wide.response_metadata ?? {};
    const messages = Array.isArray(wide.messages) ? wide.messages : [];
    return {
      messages: messages.map((message) => ({
        ts: String(message.ts ?? ''),
        user: typeof message.user === 'string' ? message.user : undefined,
        bot_id: typeof message.bot_id === 'string' ? message.bot_id : undefined,
        subtype: typeof message.subtype === 'string' ? message.subtype : undefined,
        text: typeof message.text === 'string' ? message.text : undefined,
        attachments: Array.isArray(message.attachments) ? message.attachments : undefined,
        files: Array.isArray(message.files) ? message.files : undefined,
        blocks: Array.isArray(message.blocks) ? message.blocks : undefined,
        username: typeof message.username === 'string' ? message.username : undefined,
        botProfileName: botProfileName(message.bot_profile),
        edited: isEdited(message.edited),
        delivery: parseDeliveryMetadata(message.metadata) ?? undefined,
        commandReceiptId: commandReceiptId(message.metadata),
      })),
      nextCursor:
        typeof metadata.next_cursor === 'string' && metadata.next_cursor.length > 0
          ? metadata.next_cursor
          : undefined,
      isLimited: wide.is_limited === true,
    };
  } catch (err) {
    throw asSlackPostError(err);
  }
}

function botProfileName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function isEdited(value: unknown): { user: string; ts: string } | undefined {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { user?: unknown; ts?: unknown };
    if (typeof candidate.user === 'string' && typeof candidate.ts === 'string') {
      return { user: candidate.user, ts: candidate.ts };
    }
  }
  return undefined;
}

function asSlackPostError(err: unknown): SlackPostError {
  if (err instanceof SlackPostError) {
    return err;
  }
  const rate = rateLimitedFailure(err);
  if (rate !== null) {
    return new SlackPostError(rate);
  }
  if (isAmbiguousNetworkError(err)) {
    return new SlackPostError({
      kind: 'ambiguous',
      summary: `network outcome unknown: ${safeSummary(err)}`,
    });
  }
  return new SlackPostError({ kind: 'definite', summary: describePostError(err) });
}

function rateLimitedFailure(err: unknown): SlackFailure | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const code = (err as { code?: unknown }).code;
  const retryAfter = (err as { retryAfter?: unknown }).retryAfter;
  if (code === ErrorCode.RateLimitedError) {
    const seconds = typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : 30;
    return {
      kind: 'rate_limited',
      retryAfterMs: Math.max(1, seconds) * 1000,
      summary: 'rate limited by Slack; retry scheduled',
    };
  }
  return null;
}

/**
 * A network-level failure (no HTTP response at all, a non-200 HTTP response,
 * or a timeout) leaves the outcome unknown: Slack may have accepted the post.
 * Slack API errors that carry an error code are definite rejections.
 */
function isAmbiguousNetworkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  const dataError = (err as { data?: { error?: unknown } }).data?.error;
  if (typeof dataError === 'string') {
    return false;
  }
  if (code === ErrorCode.RequestError || code === ErrorCode.HTTPError) {
    return true;
  }
  return (
    code === undefined &&
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      /network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|ECONNRESET/i.test(err.message))
  );
}

function safeSummary(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.length > 160 ? `${err.message.slice(0, 160)}...` : err.message;
    return `${err.name}: ${message}`;
  }
  return 'unknown error';
}

function commandReceiptId(metadata: unknown): string | undefined {
  const m = metadata as
    { event_type?: unknown; event_payload?: { receiptId?: unknown } } | undefined;
  return m?.event_type === COMMAND_RECEIPT_TYPE && typeof m.event_payload?.receiptId === 'string'
    ? m.event_payload.receiptId
    : undefined;
}
