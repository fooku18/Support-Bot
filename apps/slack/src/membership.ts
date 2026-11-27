import type { Installation } from './installations.js';

/** Installation-scoped roster lookup. Slack includes guests and Connect users.
 * Do not compare the actor's home team with the installing workspace.
 * Incomplete/failed pagination is unknown, never permission to invoke.
 */
export async function isChannelMember(
  installation: Installation,
  channel: string,
  user: string,
): Promise<boolean> {
  if (!/^[CG][A-Z0-9]+$/.test(channel) || !/^[UW][A-Z0-9]+$/.test(user)) return false;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const response = await installation.slack.webClient.conversations.members({
      channel,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    if (!response.ok || !Array.isArray(response.members))
      throw new Error('Slack membership unavailable');
    if (response.members.includes(user)) return true;
    cursor = response.response_metadata?.next_cursor?.trim();
    if (!cursor) return false;
    if (seen.has(cursor)) throw new Error('Slack membership pagination repeated');
    seen.add(cursor);
  }
  throw new Error('Slack membership pagination limit reached');
}
