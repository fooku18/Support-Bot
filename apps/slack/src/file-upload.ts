import { request } from 'node:https';
import type { SlackDeps } from './slackclient.js';

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
  await new Promise<void>((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'POST',
        agent: slack.fileAgent,
        timeout: 30_000,
        headers: { 'content-type': 'application/octet-stream', 'content-length': bytes.length },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          res.statusCode === 200 ? resolve() : reject(new Error('Slack byte transfer refused')),
        );
        res.on('error', () => reject(new Error('Slack byte transfer failed')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Slack byte transfer timed out')));
    req.on('error', () => reject(new Error('Slack byte transfer failed')));
    req.end(bytes);
  });
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
