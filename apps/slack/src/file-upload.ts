import type { SlackDeps } from './slackclient.js';
import { dispatchedFetch } from './outbound.js';

export function slackFileUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'files.slack.com' ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error('untrusted Slack file host');
  return url;
}

/** No redirects or implicit retry; signed URLs are never persisted or logged. */
export async function transferSlackFile(
  slack: SlackDeps,
  url: string,
  bytes: Buffer,
): Promise<void> {
  const target = slackFileUrl(url);
  let status: number;
  try {
    const response = await dispatchedFetch(slack.fileDispatcher)(target, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    status = response.status;
    await response.body?.cancel();
  } catch (error) {
    throw new Error(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'Slack byte transfer timed out'
        : 'Slack byte transfer failed',
      { cause: error },
    );
  }
  if (status !== 200) throw new Error('Slack byte transfer refused');
}

export async function assertPrivateWorkspaceChannel(
  slack: SlackDeps,
  channelId: string,
): Promise<void> {
  const result = await slack.webClient.conversations.info({ channel: channelId });
  const channel = result.channel;
  if (
    !result.ok ||
    !channel ||
    channel.is_ext_shared !== false ||
    channel.is_pending_ext_shared !== false ||
    channel.is_org_shared !== false
  )
    throw new Error('file access blocked: channel sharing status is shared or unknown');
}
