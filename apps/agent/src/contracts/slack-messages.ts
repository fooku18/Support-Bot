/**
 * Slack message reads: the contract between the agent and the Slack adapter.
 * The adapter holds the bot token and enforces every access limit; the agent
 * receives bounded text or a refusal code. This module is copied verbatim and
 * must stay dependency-free.
 */

/** Link to one message, as "Copy link" in Slack produces it. */
export interface SlackMessageLink {
  channelId: string;
  messageTs: string;
  /** Root of the thread a linked reply belongs to. */
  threadTs: string | null;
}

export const SLACK_MESSAGE_REFUSALS = [
  'channel_unavailable',
  'shared_channel',
  'bot_not_member',
  'requester_not_member',
  'message_not_found',
] as const;
export type SlackMessageRefusal = (typeof SLACK_MESSAGE_REFUSALS)[number];

export interface SlackThreadMessage {
  ts: string;
  /** ISO 8601 time of the message. */
  date: string;
  /** Slack user ID of the author, null for a post without one. */
  userId: string | null;
  /** Display name of a bot or app author. */
  botName: string | null;
  /** The message the link points at. */
  linked?: true;
  own?: true;
  text: string;
}

export type SlackMessageRead =
  | { refused: SlackMessageRefusal }
  | {
      channelId: string;
      threadTs: string;
      /** In thread order; always includes the linked message. */
      messages: SlackThreadMessage[];
      /** Thread messages left out by the bounds. */
      omitted: number;
      /** A message text was cut. */
      truncated: boolean;
    };

export interface SlackThreadContext {
  messages: SlackThreadMessage[];
  omitted: number;
  truncated: boolean;
}

/**
 * Bounds of one read: the whole answer, one message and the pages scanned.
 *
 * @public
 */
export const SLACK_READ_BYTES = 24_000;
/** @public */
export const SLACK_READ_MESSAGE_BYTES = 8_000;
export const SLACK_READ_MESSAGES = 50;
/** @public */
export const SLACK_READ_PAGES = 5;
export const MAX_SLACK_LINK_CHARS = 512;

/** @public */
export const SLACK_READ_CHANNEL = /^[CG][A-Z0-9]{1,31}$/;
export const SLACK_READ_TS = /^[0-9]{10}\.[0-9]{6}$/;

/** Parses a message permalink, also in Slack's `<url|label>` form; null when it is none. */
export function parseSlackMessageLink(value: unknown): SlackMessageLink | null {
  if (typeof value !== 'string') return null;
  const raw = value
    .trim()
    .replace(/^<([^<>|]+)(?:\|[^<>]*)?>$/, '$1')
    .replaceAll('&amp;', '&');
  if (raw.length > MAX_SLACK_LINK_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !url.hostname.endsWith('.slack.com')
  )
    return null;
  const path = /^\/archives\/([CG][A-Z0-9]{1,31})\/p([0-9]{10})([0-9]{6})\/?$/.exec(url.pathname);
  if (!path) return null;
  const thread = url.searchParams.get('thread_ts');
  if (thread !== null && !SLACK_READ_TS.test(thread)) return null;
  // `cid` repeats the channel of a linked reply; a contradicting one is no valid link.
  const cid = url.searchParams.get('cid');
  if (cid !== null && cid !== path[1]) return null;
  return { channelId: path[1]!, messageTs: `${path[2]}.${path[3]}`, threadTs: thread };
}
