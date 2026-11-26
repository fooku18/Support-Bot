import { afterEach, expect, it, vi } from 'vitest';
import { createReplyDecider } from '../src/reply-decider.js';

const env = {
  THREAD_REPLY_DECIDER_URL: 'https://decider.example/v1/systemone',
  THREAD_REPLY_DECIDER_MODEL: 'clef-flash',
  THREAD_REPLY_DECIDER_CLIENT_ID: 'support-agent',
};
const answer = (choice: string, reply = 0.8) =>
  Response.json({
    model: 'clef-flash',
    answers: { reply: { type: 'choice', choice, probabilities: { reply, silent: 1 - reply } } },
  });
afterEach(() => vi.restoreAllMocks());

it('is off without a URL and refuses a URL without a model', () => {
  expect(createReplyDecider({})).toBeNull();
  expect(() =>
    createReplyDecider({ THREAD_REPLY_DECIDER_URL: env.THREAD_REPLY_DECIDER_URL }),
  ).toThrow('THREAD_REPLY_DECIDER_MODEL required');
  expect(() => createReplyDecider({ ...env, THREAD_REPLY_DECIDER_URL: 'ftp://decider' })).toThrow();
});

it('asks one choice question with the bounded message and the client id', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('reply', 0.84));
  const decide = createReplyDecider(env)!;
  await expect(decide(`  and for Poland? ${'x'.repeat(3000)}`, false)).resolves.toEqual({
    reply: true,
    reason: 'decider',
    probability: 0.84,
  });
  const [url, init] = fetch.mock.calls[0]!;
  expect(String(url)).toBe(env.THREAD_REPLY_DECIDER_URL);
  expect(init?.headers).toMatchObject({ 'x-client-id': 'support-agent' });
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe('clef-flash');
  expect(Object.keys(body.questions.reply.criteria)).toEqual(['reply', 'silent']);
  expect(body.state).toContain('and for Poland?');
  expect(body.state.length).toBeLessThan(2300);
});

it('stays silent when the model says so', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('silent', 0.1));
  await expect(createReplyDecider(env)!('thanks!', false)).resolves.toEqual({
    reply: false,
    reason: 'decider',
    probability: 0.1,
  });
});

it.each(['<@U024MNGC32P> can you check?', 'fyi <!subteam^S01|payments>', '<!here> resolved'])(
  'stays silent without a model call for a message to others: %j',
  async (text) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(createReplyDecider(env)!(text, false)).resolves.toEqual({
      reply: false,
      reason: 'mentions_others',
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('replies to files without text without a model call', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(createReplyDecider(env)!(' ', true)).resolves.toEqual({
    reply: true,
    reason: 'files_only',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['an HTTP error', () => Promise.resolve(new Response('busy', { status: 503 }))],
  ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ['a malformed answer', () => Promise.resolve(Response.json({ answers: {} }))],
])('stays silent when the model is unavailable: %s', async (_name, result) => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(result);
  await expect(createReplyDecider(env)!('and for yesterday?', false)).resolves.toEqual({
    reply: false,
    reason: 'decider_unavailable',
  });
});
