/**
 * Slack error-code summaries. Extracted from the milestone-1 reply handler so
 * both the delivery path and error classification share one table. Slack
 * error codes are safe enum strings; payloads and values are omitted.
 */

export function describePostError(err: unknown): string {
  const code = slackErrorCode(err);
  switch (code) {
    case 'channel_not_found':
      return 'channel_not_found: the channel does not exist or is not visible to the bot; check the channel ID and bot invitation';
    case 'not_in_channel':
      return 'not_in_channel: the bot is not a member of the channel; invite it with /invite @bot';
    case 'is_archived':
      return 'is_archived: the channel is archived; unarchive it to receive replies';
    case 'missing_scope':
      return 'missing_scope: the bot token lacks a required history/chat scope';
    case 'invalid_auth':
    case 'account_inactive':
    case 'not_authed':
      return 'bot token invalid or revoked; reinstall the app in this workspace (admin Workspaces page)';
    case 'rate_limited':
    case 'ratelimited':
      return 'rate limited by Slack; retry later';
    case 'thread_not_found':
      return 'thread_not_found: the thread root no longer exists or is not accessible';
    default:
      return safeErrorSummary(err);
  }
}

function slackErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const data = (err as { data?: { error?: unknown } }).data;
  if (typeof data?.error === 'string') {
    return data.error;
  }
  return undefined;
}

function safeErrorSummary(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.length > 200 ? `${err.message.slice(0, 200)}...` : err.message;
    return `${err.name}: ${message}`;
  }
  return 'unknown error';
}
