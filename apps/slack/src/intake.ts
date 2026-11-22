import { flattenMessageContent } from './generated/slack-message-content.js';
import type { IntakeRequest } from './generated/protocol.js';
import { matchesTrustedBotSender, type TrustedBotSender } from './generated/trusted-bot-sender.js';
import { buildTaskKey } from './taskkey.js';

/**
 * The subset of the Slack `app_mention` event this handler needs.
 * Structurally compatible with the event payload delivered over Socket Mode.
 */
export interface MentionEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  blocks?: unknown;
  attachments?: unknown;
  files?: unknown[];
  /** Slack may attach a search token to the event. It stays outside the intake request. */
  action_token?: unknown;
}

/**
 * One whitelisted workspace installation, from the admin configuration
 * document and verified with auth.test (see installations.ts).
 */
export interface BotIdentity {
  /** Whitelisted workspace ID. */
  teamId: string;
  /** Task-key installation discriminator: the team's bot user ID. */
  installationId: string;
  botUserId: string;
  /** This app's bot_id in the workspace (own messages carry it). */
  botId: string;
  /** The installation's trusted bot sender (admin-configured), if any. */
  trustedBotSender?: TrustedBotSender;
}

export type MentionDecision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'accept'; request: IntakeRequest };

/** Human mentions and the explicitly configured trusted bot sender may invoke the bot. */
export function decideMention(event: MentionEvent, identity: BotIdentity): MentionDecision {
  if (event.type !== 'app_mention') {
    return { kind: 'ignore', reason: 'not an app_mention' };
  }
  if (event.bot_id === identity.botId || event.user === identity.botUserId) {
    return { kind: 'ignore', reason: 'application own message' };
  }
  if (
    (event.bot_id !== undefined || event.subtype === 'bot_message') &&
    !matchesTrustedBotSender(event, identity.teamId, event.channel, identity.trustedBotSender)
  ) {
    return { kind: 'ignore', reason: 'bot-generated mention (bot_id present)' };
  }
  if (event.user === undefined) {
    return { kind: 'ignore', reason: 'no user (not a human message)' };
  }
  if (!/^[CG][A-Z0-9]+$/.test(event.channel)) {
    return { kind: 'ignore', reason: 'channel is not a public or private channel' };
  }
  const rootTs = event.thread_ts ?? event.ts;
  if (rootTs === undefined || event.ts === undefined) {
    return { kind: 'ignore', reason: 'mention has no message timestamp to anchor a thread' };
  }
  try {
    const request: IntakeRequest = {
      installationId: identity.installationId,
      teamId: identity.teamId,
      channelId: event.channel,
      rootTs,
      eventId: `msg:${event.channel}:${event.ts}`,
      messageTs: event.ts,
      userId: event.user,
      text: event.text ?? '',
      canonicalText: flattenMessageContent(event),
      authorBotId: event.bot_id ?? null,
    };
    // Validates the composed identity early so malformed IDs fail before any
    // durable write.
    buildTaskKey({
      installationId: identity.installationId,
      teamId: identity.teamId,
      channelId: event.channel,
      rootTs,
    });
    return { kind: 'accept', request };
  } catch (err) {
    return {
      kind: 'ignore',
      reason: `task identity rejected: ${err instanceof Error ? err.message : 'invalid'}`,
    };
  }
}
