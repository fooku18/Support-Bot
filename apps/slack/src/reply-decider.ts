export type ReplyDecision =
  | { reply: true; reason: 'decider' | 'files_only'; probability?: number; failure?: undefined }
  | {
      reply: false;
      reason: 'decider' | 'mentions_others' | 'empty';
      probability?: number;
      failure?: undefined;
    }
  | { reply: false; reason: 'decider_unavailable'; failure: string; probability?: undefined };

export interface ThreadMessage {
  author: 'assistant' | 'requester' | 'other';
  text: string;
}

export type ReplyDecider = (
  text: string,
  hasFiles: boolean,
  requester: boolean,
  recent?: ThreadMessage[],
) => Promise<ReplyDecision>;

const APP_ATTRIBUTION = /\*?Sent using\*?\s*<@[UW][A-Z0-9]+(\|[^>]*)?>/gi;
const MENTIONS_OTHERS = /<@[UW][A-Z0-9]+(\|[^>]*)?>|<!subteam\^|<!(channel|here|everyone)\b/;
const MAX_TEXT = 2000;
const MAX_RECENT = 3;
const MAX_RECENT_TEXT = 500;
const AUTHOR = {
  assistant: 'the assistant',
  requester: 'the person who asked the assistant',
  other: 'another person',
};

function readable(text: string) {
  return text
    .replace(APP_ATTRIBUTION, '')
    .replace(/<@[UW][A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[UW][A-Z0-9]+>/g, '@someone')
    .trim();
}

function describe(message: string, requester: boolean, recent: ThreadMessage[]) {
  const who = requester ? 'The person who asked the assistant' : 'Someone in the thread';
  const history = recent
    .slice(-MAX_RECENT)
    .map((m) => ({ ...m, text: readable(m.text).slice(0, MAX_RECENT_TEXT) }))
    .filter((m) => m.text)
    .map((m) => `${AUTHOR[m.author]}: ${m.text}`);
  const text = message.slice(0, MAX_TEXT);
  if (!history.length)
    return `A Slack thread with an AI assistant. ${who} wrote this new message${requester ? ' in the thread' : ''}, without mentioning the assistant:\n${text}`;
  return `A Slack thread with an AI assistant. Recent messages, oldest first:\n${history.join('\n')}\n\n${who} now wrote this new message, without mentioning the assistant:\n${text}`;
}

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

const unavailable = (failure: string): ReplyDecision => ({
  reply: false,
  reason: 'decider_unavailable',
  failure,
});

export function createReplyDecider(env: NodeJS.ProcessEnv): ReplyDecider | null {
  const url = env.THREAD_REPLY_DECIDER_URL?.trim();
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('THREAD_REPLY_DECIDER_URL must be an https URL without credentials');
  const model = env.THREAD_REPLY_DECIDER_MODEL?.trim();
  if (!model) throw new Error('THREAD_REPLY_DECIDER_MODEL required');
  const clientId = env.THREAD_REPLY_DECIDER_CLIENT_ID?.trim();
  return async (text, hasFiles, requester, recent = []) => {
    const message = text.replace(APP_ATTRIBUTION, '').trim();
    if (MENTIONS_OTHERS.test(message)) return { reply: false, reason: 'mentions_others' };
    if (!message)
      return hasFiles && requester
        ? { reply: true, reason: 'files_only' }
        : { reply: false, reason: 'empty' };
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(clientId ? { 'x-client-id': clientId } : {}),
        },
        body: JSON.stringify({
          model,
          state: describe(message, requester, recent),
          questions: QUESTION,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return unavailable(
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return unavailable(`http_${response.status}`);
    }
    try {
      const body = (await response.json()) as {
        answers?: { reply?: { choice?: unknown; probabilities?: { reply?: unknown } } };
      } | null;
      const answer = body?.answers?.reply;
      const probability =
        typeof answer?.probabilities?.reply === 'number' ? answer.probabilities.reply : undefined;
      if (answer?.choice === 'reply') return { reply: true, reason: 'decider', probability };
      if (answer?.choice === 'silent') return { reply: false, reason: 'decider', probability };
    } catch {
      return unavailable('malformed');
    }
    return unavailable('malformed');
  };
}
