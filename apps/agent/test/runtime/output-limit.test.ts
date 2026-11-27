import { testModel, testSelection } from '../model-fixture.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { InMemoryStore } from '@mastra/core/storage';
import { createNativeRuntime } from '../../src/mastra/runtime/agent.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

const STEP_TEXT = 'word '.repeat(40);

it('caps output per model step, so the text of several steps may exceed the step limit together', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const first = requests.length === 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', {
      message: {
        id: 'fixture',
        role: 'assistant',
        type: 'message',
        model: 'fixture',
        content: [],
        usage: { input_tokens: 9, output_tokens: 0 },
      },
    });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: STEP_TEXT } });
    send('content_block_stop', { index: 0 });
    if (first) {
      send('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_tools', input: {} },
      });
      send('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: 'gitlab' }) },
      });
      send('content_block_stop', { index: 1 });
    }
    send('message_delta', {
      delta: { stop_reason: first ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 40 },
    });
    send('message_stop', {});
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const runtime = createNativeRuntime({
    storage: new InMemoryStore(),
    instructions: 'trusted instructions',
    model: testModel(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'fixture-token',
      testSelection('test', 'fixture'),
    ),
    tools: {},
    beforeDispatch: async () => {},
    contextTokens: 100000,
    outputTokens: 64,
    maxSteps: 3,
  });
  const out = await runNativeSegment(
    await runtime.agent.stream('Question', { closeOnSuspend: true }),
  );
  await runtime.mastra.shutdown();
  expect(requests).toHaveLength(2);
  expect(requests.map((r) => r.max_tokens)).toEqual([64, 64]);
  expect(out.failure).toBeUndefined();
  expect(out.uncertain).toBe(false);
});
