import type { Installation } from './installations.js';
import { isChannelMember } from './membership.js';
import { fetchRepliesPage, SlackPostError, type ReplyPage } from './slackclient.js';
import { flattenMessageContent } from './generated/slack-message-content.js';
import {
  SLACK_READ_BYTES,
  SLACK_READ_CHANNEL,
  SLACK_READ_MESSAGE_BYTES,
  SLACK_READ_MESSAGES,
  SLACK_READ_PAGES,
  SLACK_READ_TS,
  type SlackMessageLink,
  type SlackMessageRead,
  type SlackMessageRefusal,
  type SlackThreadMessage,
} from './generated/slack-messages.js';

/**
 * Message reads for an admitted request. The caller has already established
 * the requester's current authority over the origin thread. The limits here
 * cover the channel that is read:
 *
 * - it is not shared with another workspace or organization,
 * - the bot and the requester are both members of it,
 * - a private channel is read only for a request from that same channel,
 *   because everyone in the origin channel sees the answer.
 *
 * Unknown status is never permission. Channel IDs resolve with the
 * installation's own token, so another workspace's channel is not visible.
 */
type Reply = ReplyPage['messages'][number];

async function refusal(
  installation: Installation,
  origin: { channelId: string; userId: string },
  channelId: string,
): Promise<SlackMessageRefusal | null> {
  let channel: Record<string, unknown> | undefined;
  try {
    const result = await installation.slack.webClient.conversations.info({ channel: channelId });
    if (!result.ok) throw new Error('Slack channel status unavailable');
    channel = result.channel as Record<string, unknown> | undefined;
  } catch (error) {
    if (errorCode(error) === 'channel_not_found') return 'channel_unavailable';
    throw error;
  }
  // Privacy first: for a private channel elsewhere nothing else is reported.
  if (
    !channel ||
    channel.is_im === true ||
    channel.is_mpim === true ||
    (channel.is_private !== false && channelId !== origin.channelId)
  )
    return 'channel_unavailable';
  if (
    channel.is_ext_shared !== false ||
    channel.is_pending_ext_shared !== false ||
    channel.is_org_shared !== false
  )
    return 'shared_channel';
  if (channel.is_member !== true) return 'bot_not_member';
  if (!(await isChannelMember(installation, channelId, origin.userId)))
    return 'requester_not_member';
  return null;
}

/** The linked message with its thread, or why it may not be read. */
export async function readLinkedMessage(
  installation: Installation,
  origin: { channelId: string; userId: string },
  link: SlackMessageLink,
): Promise<SlackMessageRead> {
  if (
    !SLACK_READ_CHANNEL.test(link.channelId) ||
    !SLACK_READ_TS.test(link.messageTs) ||
    (link.threadTs !== null && !SLACK_READ_TS.test(link.threadTs))
  )
    throw new Error('invalid message link');
  const refused = await refusal(installation, origin, link.channelId);
  if (refused) return { refused };
  const threadTs = link.threadTs ?? link.messageTs;
  const thread: Reply[] = [];
  let cursor: string | undefined;
  let complete = false;
  try {
    for (let page = 0; page < SLACK_READ_PAGES && !complete; page++) {
      const history = await fetchRepliesPage(installation.slack, {
        channel: link.channelId,
        rootTs: threadTs,
        limit: 100,
        cursor,
      });
      thread.push(...history.messages);
      cursor = history.nextCursor;
      complete = !cursor;
    }
  } catch (error) {
    if (
      error instanceof SlackPostError &&
      error.failure.kind === 'definite' &&
      /\b(thread_not_found|message_not_found)\b/.test(error.failure.summary)
    )
      return { refused: 'message_not_found' };
    throw error;
  }
  const readable = thread.filter((message) => message.subtype !== 'tombstone');
  if (!readable.some((message) => message.ts === link.messageTs))
    return { refused: 'message_not_found' };
  // Access may have been withdrawn while the thread was read.
  const withdrawn = await refusal(installation, origin, link.channelId);
  if (withdrawn) return { refused: withdrawn };
  return { channelId: link.channelId, threadTs, ...bound(readable, link.messageTs, !complete) };
}

/** The first message of the origin thread; null when it is gone or empty. */
export async function readThreadRoot(
  installation: Installation,
  origin: { channelId: string; rootTs: string },
): Promise<SlackThreadMessage | null> {
  const page = await fetchRepliesPage(installation.slack, {
    channel: origin.channelId,
    rootTs: origin.rootTs,
    limit: 1,
  });
  const root = page.messages.find(
    (message) => message.ts === origin.rootTs && message.subtype !== 'tombstone',
  );
  if (!root) return null;
  const message = threadMessage(root, SLACK_READ_MESSAGE_BYTES).message;
  return message.text ? message : null;
}

/** The linked message and the root come first in the budget, then the thread in order. */
function bound(thread: Reply[], linkedTs: string, more: boolean) {
  const priority = [
    ...thread.filter((message) => message.ts === linkedTs),
    ...thread.slice(0, 1).filter((message) => message.ts !== linkedTs),
    ...thread.slice(1).filter((message) => message.ts !== linkedTs),
  ];
  const kept = new Map<string, SlackThreadMessage>();
  let bytes = 0;
  let truncated = more;
  for (const reply of priority.slice(0, SLACK_READ_MESSAGES)) {
    const { message, cut } = threadMessage(reply, SLACK_READ_MESSAGE_BYTES);
    if (reply.ts === linkedTs) message.linked = true;
    const size = Buffer.byteLength(JSON.stringify(message));
    // One oversized JSON encoding must not drop the message the link names.
    if (kept.size && bytes + size > SLACK_READ_BYTES) break;
    bytes += size;
    truncated ||= cut;
    kept.set(reply.ts, message);
  }
  const messages = thread.flatMap((reply) => kept.get(reply.ts) ?? []);
  return { messages, omitted: thread.length - messages.length, truncated };
}

function threadMessage(reply: Reply, maxBytes: number) {
  const { text, cut } = clip(flattenMessageContent(reply), maxBytes);
  const message: SlackThreadMessage = {
    ts: reply.ts,
    date: new Date(Number(reply.ts) * 1000).toISOString(),
    userId: reply.user ?? null,
    botName: reply.bot_id ? (reply.botProfileName ?? reply.username ?? reply.bot_id) : null,
    text,
  };
  return { message, cut };
}

function clip(value: string, maxBytes: number) {
  // eslint-disable-next-line no-control-regex -- strips control characters from message text
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim();
  if (Buffer.byteLength(text) <= maxBytes) return { text, cut: false };
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return { text: `${text.slice(0, end)}…`, cut: true };
}

function errorCode(error: unknown): string | undefined {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}
