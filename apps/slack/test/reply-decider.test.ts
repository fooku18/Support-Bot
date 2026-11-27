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
  expect(() =>
    createReplyDecider({ ...env, THREAD_REPLY_DECIDER_URL: 'http://decider/v1/systemone' }),
  ).toThrow('https');
});

it('asks one choice question with the bounded message and the client id', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('reply', 0.84));
  const decide = createReplyDecider(env)!;
  await expect(decide(`  and for Poland? ${'x'.repeat(3000)}`, false, true)).resolves.toEqual({
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
  expect(body.state).toContain('The person who asked the assistant wrote');
  expect(body.state).toContain('and for Poland?');
  expect(body.state.length).toBeLessThan(2300);
});

it('ignores the "Sent using" attribution of a Slack app posting for the person', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('silent', 0.1));
  await expect(
    createReplyDecider(env)!('thanks! *Sent using* <@U0ABE2UQ8N4>', false, true),
  ).resolves.toMatchObject({ reply: false, reason: 'decider' });
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).state).not.toContain('Sent using');
});

it('stays silent when the model says so', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('silent', 0.1));
  await expect(createReplyDecider(env)!('thanks!', false, true)).resolves.toEqual({
    reply: false,
    reason: 'decider',
    probability: 0.1,
  });
});

it.each([
  '<@U024MNGC32P> can you check?',
  '<@U024MNGC32P|jakob> can you check?',
  'fyi <!subteam^S01|payments>',
  '<!here> resolved',
  '<!channel> resolved',
])('stays silent without a model call for a message to others: %j', async (text) => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(createReplyDecider(env)!(text, false, true)).resolves.toEqual({
    reply: false,
    reason: 'mentions_others',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('gives the model the last three thread messages with readable mentions', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('reply'));
  await createReplyDecider(env)!('can you check the logs too?', false, false, [
    { author: 'requester', text: 'fourth from last' },
    { author: 'requester', text: '@assistant why did order 12345 fail?' },
    { author: 'assistant', text: 'The payment provider timed out.' },
    { author: 'other', text: '<@U024MNGC32P|jakob> and <@U01> fyi *Sent using* <@U0ABE2UQ8N4>' },
  ]);
  const state = JSON.parse(String(fetch.mock.calls[0]![1]?.body)).state as string;
  expect(state).not.toContain('fourth from last');
  expect(state).toContain(
    'the person who asked the assistant: @assistant why did order 12345 fail?\nthe assistant: The payment provider timed out.\nanother person: @jakob and @someone fyi\n\nSomeone in the thread now wrote this new message',
  );
  expect(state).toContain('can you check the logs too?');
});

it('describes a message from another participant as such', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('reply'));
  await createReplyDecider(env)!('does the bot know the error rate?', false, false);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).state).toContain(
    'Someone in the thread wrote',
  );
});

it('replies to files without text and ignores an empty message without a model call', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(createReplyDecider(env)!(' ', true, true)).resolves.toEqual({
    reply: true,
    reason: 'files_only',
  });
  await expect(createReplyDecider(env)!(' ', false, true)).resolves.toEqual({
    reply: false,
    reason: 'empty',
  });
  await expect(createReplyDecider(env)!(' ', true, false)).resolves.toEqual({
    reply: false,
    reason: 'empty',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('sends no client id header when none is configured', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('reply'));
  await createReplyDecider({ ...env, THREAD_REPLY_DECIDER_CLIENT_ID: '' })!('why?', false, true);
  expect(Object.keys(fetch.mock.calls[0]![1]!.headers as object)).toEqual(['content-type']);
});

it.each([
  ['http_503', () => Promise.resolve(new Response('busy', { status: 503 }))],
  ['network', () => Promise.reject(new TypeError('fetch failed'))],
  ['timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ['malformed', () => Promise.resolve(Response.json({ answers: {} }))],
  ['malformed', () => Promise.resolve(Response.json(null))],
  ['malformed', () => Promise.resolve(new Response('not json'))],
])('stays silent when the model is unavailable: %s', async (failure, result) => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(result);
  await expect(createReplyDecider(env)!('and for yesterday?', false, true)).resolves.toEqual({
    reply: false,
    reason: 'decider_unavailable',
    failure,
  });
});
