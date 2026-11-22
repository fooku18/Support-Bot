import { afterEach, describe, expect, it } from 'vitest';
import { startStub, type StubHandle } from '../src/server.js';

let stub: StubHandle | undefined;
const logs: Record<string, unknown>[] = [];
afterEach(async () => {
  await stub?.close();
  stub = undefined;
  logs.length = 0;
});
async function start(sleep?: (ms: number) => Promise<void>) {
  stub = await startStub({
    port: 0,
    host: '127.0.0.1',
    log: (line) => logs.push(line),
    ...(sleep ? { sleep } : {}),
  });
  return stub.url;
}
const post = (url: string, body: unknown, key = 'stub-key-2', path = '/v1/messages') =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
const request = (text: string, extra: object = {}) => ({
  model: 'claude-sonnet-5-5',
  stream: true,
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...extra,
});
function events(sse: string) {
  return sse
    .trim()
    .split('\n\n')
    .map((frame) => {
      const [event, data] = frame.split('\n');
      return { event: event!.slice('event: '.length), data: JSON.parse(data!.slice(6)) };
    });
}

describe('model stub server', () => {
  it('serves health without a key and refuses requests without a synthetic key', async () => {
    const url = await start();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    for (const key of ['', 'sk-real-looking', 'stub-key-0']) {
      const r = await post(url, request('STUB_REPLY x'), key);
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ error: { type: 'authentication_error' } });
    }
    expect(stub!.requests()).toBe(0);
  });

  it('streams text with the Anthropic event sequence and the cost header', async () => {
    const url = await start();
    const r = await post(url, request('STUB_REPLY amber fox'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const sequence = events(await r.text());
    expect(sequence.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(sequence[0]!.data.message).toMatchObject({
      role: 'assistant',
      model: 'claude-sonnet-5-5',
    });
    expect(sequence[2]!.data.delta).toEqual({ type: 'text_delta', text: 'amber fox' });
    expect(sequence[4]!.data.delta.stop_reason).toBe('end_turn');
    // Logs carry counts, models and directive names only.
    expect(logs).toEqual([
      { event: 'request', n: 1, model: 'claude-sonnet-5-5', directives: ['REPLY'] },
    ]);
    expect(JSON.stringify(logs)).not.toContain('amber');
  });

  it('streams a tool call as input_json_delta', async () => {
    const url = await start();
    const r = await post(
      url,
      request('STUB_ASK Which colour?', {
        tools: [{ name: 'ask_user', input_schema: { type: 'object' } }],
      }),
    );
    const sequence = events(await r.text());
    expect(sequence[1]!.data.content_block).toMatchObject({
      type: 'tool_use',
      name: 'ask_user',
      input: {},
    });
    expect(JSON.parse(sequence[2]!.data.delta.partial_json)).toEqual({
      question: 'Which colour?',
    });
    expect(sequence[4]!.data.delta.stop_reason).toBe('tool_use');
  });

  it('answers non-streaming requests and token counts as JSON', async () => {
    const url = await start();
    const r = await post(url, request('STUB_REPLY plain', { stream: false }));
    expect(await r.json()).toMatchObject({
      type: 'message',
      content: [{ type: 'text', text: 'plain' }],
      stop_reason: 'end_turn',
    });
    const count = await post(url, request('x'), 'stub-key-2', '/v1/messages/count_tokens');
    expect(((await count.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  });

  it('holds the reply before responding', async () => {
    const held: number[] = [];
    const url = await start(async (ms) => {
      held.push(ms);
    });
    const r = await post(url, request('STUB_HOLD 5'));
    expect(await r.text()).toContain('STUB_HELD 5');
    expect(held).toEqual([5000]);
  });

  it('refuses malformed bodies and unknown routes', async () => {
    const url = await start();
    expect((await post(url, { messages: 'no' })).status).toBe(400);
    expect((await post(url, request('x'), 'stub-key-2', '/v1/models')).status).toBe(404);
  });
});
