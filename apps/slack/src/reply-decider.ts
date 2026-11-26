export type ReplyDecision =
  | { reply: true; reason: 'decider' | 'files_only' | 'decider_unavailable'; probability?: number }
  | { reply: false; reason: 'decider' | 'mentions_others'; probability?: number };

export type ReplyDecider = (text: string, hasFiles: boolean) => Promise<ReplyDecision>;

const MENTIONS_OTHERS = /<@[UW][A-Z0-9]+>|<!subteam\^|<!(channel|here|everyone)\b/;
const MAX_TEXT = 2000;
const TIMEOUT_MS = 2000;

const QUESTION = {
  reply: {
    type: 'choice',
    criteria: {
      reply:
        'The person wants the assistant to do something, answers its question, corrects it, or asks it a new question, so the assistant should reply.',
      silent:
        'Thanks, acknowledgement, reaction, small talk, a remark, or a message meant for other people, so the assistant should stay silent.',
    },
  },
};

export function createReplyDecider(env: NodeJS.ProcessEnv): ReplyDecider | null {
  const url = env.THREAD_REPLY_DECIDER_URL?.trim();
  if (!url) return null;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('invalid THREAD_REPLY_DECIDER_URL');
  const model = env.THREAD_REPLY_DECIDER_MODEL?.trim();
  if (!model) throw new Error('THREAD_REPLY_DECIDER_MODEL required');
  const clientId = env.THREAD_REPLY_DECIDER_CLIENT_ID?.trim();
  return async (text, hasFiles) => {
    const message = text.trim();
    if (MENTIONS_OTHERS.test(message)) return { reply: false, reason: 'mentions_others' };
    if (!message && hasFiles) return { reply: true, reason: 'files_only' };
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(clientId ? { 'x-client-id': clientId } : {}),
        },
        body: JSON.stringify({
          model,
          state: `A Slack thread with an AI assistant. The person who asked the assistant wrote this new message in the thread, without mentioning the assistant:\n${message.slice(0, MAX_TEXT)}`,
          questions: QUESTION,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return { reply: true, reason: 'decider_unavailable' };
      const body = (await response.json()) as {
        answers?: { reply?: { choice?: unknown; probabilities?: { reply?: unknown } } };
      };
      const answer = body.answers?.reply;
      const probability =
        typeof answer?.probabilities?.reply === 'number' ? answer.probabilities.reply : undefined;
      if (answer?.choice === 'reply') return { reply: true, reason: 'decider', probability };
      if (answer?.choice === 'silent') return { reply: false, reason: 'decider', probability };
      return { reply: true, reason: 'decider_unavailable' };
    } catch {
      return { reply: true, reason: 'decider_unavailable' };
    }
  };
}
