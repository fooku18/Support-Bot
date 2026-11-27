import type { SlackDeps } from './slackclient.js';

export const RUN_STATUS_CHARS = 120;

type Shown = { slack: SlackDeps; channel: string; ts: string };

function blocks(text: string) {
  return [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_${text}_` }] }];
}

export function createRunStatuses() {
  const runs = new Map<string, Promise<Shown | undefined>>();
  return {
    has: (runId: string) => runs.has(runId),
    show(runId: string, slack: SlackDeps, channel: string, rootTs: string, text: string) {
      const before = runs.get(runId) ?? Promise.resolve(undefined);
      const next = before.then(async (shown) => {
        if (shown) {
          await shown.slack.webClient.chat
            .update({ channel, ts: shown.ts, text, blocks: blocks(text) as never })
            .catch(() => undefined);
          return shown;
        }
        const posted = await slack.webClient.chat
          .postMessage({ channel, thread_ts: rootTs, text, blocks: blocks(text) as never })
          .catch(() => undefined);
        return typeof posted?.ts === 'string' ? { slack, channel, ts: posted.ts } : undefined;
      });
      runs.set(runId, next);
      return next;
    },
    async clear(runId: string) {
      const entry = runs.get(runId);
      runs.delete(runId);
      const shown = await entry;
      if (shown)
        await shown.slack.webClient.chat
          .delete({ channel: shown.channel, ts: shown.ts })
          .catch(() => undefined);
    },
  };
}
