import { afterEach, expect, it } from 'vitest';
import { startNativeAgentServer } from '../../src/application/server.js';
import type { NativeAgentService } from '../../src/application/agent-service.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function serve(thread: () => Promise<unknown>) {
  const errors: string[] = [];
  const app = startNativeAgentServer({
    agents: { thread, close: async () => undefined } as unknown as NativeAgentService,
    host: '127.0.0.1',
    port: 0,
    token: 'synthetic',
    send: async () => ({}),
    log: { info: () => undefined, warn: () => undefined, error: (m) => errors.push(m) },
  });
  servers.push(app);
  await app.ready;
  const post = (body: string) =>
    fetch(`http://127.0.0.1:${app.port}/agents/thread`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
      body,
    });
  return { post, errors };
}

it('logs the route and error class of an unexpected failure, never its message', async () => {
  const { post, errors } = await serve(async () => {
    throw new TypeError('failed for https://private.example.test/secret');
  });
  const response = await post('{}');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'native_agent_unavailable' });
  expect(errors).toEqual(['native ingress failed route=/agents/thread reason=TypeError']);
});
