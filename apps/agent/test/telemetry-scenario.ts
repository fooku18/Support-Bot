import { testModel, testSelection } from './model-fixture.js';
/** Real pinned Agent/durable wrapper/provider adapter; synthetic loopback peer.
 * Reused by memory privacy tests and the retained fresh PostgreSQL qualification. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { createNativeRuntime } from '../src/mastra/runtime/agent.js';
import { runNativeSegment } from '../src/mastra/runtime/segment.js';

export const privateMarker = 'PRIVATE_NATIVE_PROMPT_ANSWER_TOOL_FILE_CREDENTIAL_115';
export async function nativeTelemetryScenario(storage: MastraCompositeStore) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) {
      void chunk; /* drain synthetic request */
    }
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', {
      message: {
        id: privateMarker,
        role: 'assistant',
        type: 'message',
        model: 'fixture',
        content: [],
        usage: { input_tokens: 9, output_tokens: 0 },
      },
    });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: privateMarker } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    send('message_stop', {});
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runId = randomUUID();
  const identity = {
    runId,
    threadId: 'T_PRIVATE:C_PRIVATE:1234567890.123456',
    resourceId: 'U_PRIVATE:T_PRIVATE',
  };
  let allow = true;
  const runtime = createNativeRuntime({
    storage,
    observability: identity,
    instructions: privateMarker,
    model: testModel(
      `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
      privateMarker,
      testSelection('test', 'fixture'),
    ),
    tools: {},
    beforeDispatch: async () => {
      if (!allow) throw new Error(privateMarker);
    },
    contextTokens: 2000,
    outputTokens: 64,
    maxSteps: 2,
  });
  try {
    const out = await runNativeSegment(
      await runtime.agent.stream(privateMarker, {
        runId,
        memory: { thread: privateMarker, resource: privateMarker },
        tracingOptions: {
          metadata: { secret: privateMarker, filename: privateMarker },
          tags: [privateMarker],
        },
        closeOnSuspend: true,
      }),
    );
    assert.equal(out.text, privateMarker);
    assert.equal(out.uncertain, false);
    runtime.mastra.getLogger().info('native.segment.ended', { runId, privateData: privateMarker });
    // Error paths must be as private as success paths, with zero model retry.
    allow = false;
    await assert.rejects(
      async () =>
        runNativeSegment(
          await runtime.agent.stream(privateMarker, {
            runId: randomUUID(),
            closeOnSuspend: true,
          }),
        ),
      /PRIVATE_NATIVE/,
    );
    assert.equal(calls, 1);
    const defaults = await runtime.agent.getDefaultOptions();
    assert.equal(defaults.autoResumeSuspendedTools, false);
    assert.equal(defaults.disableBackgroundTasks, true);
    return { runId, identity };
  } finally {
    // This is the actual application segment shutdown path: buffers must persist
    // before the owner closes externally supplied pools.
    await runtime.mastra.shutdown({ drainTimeout: 30000 });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
