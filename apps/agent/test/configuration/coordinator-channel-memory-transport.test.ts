import http from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  createChannelMemoryTransport,
  validateChannelMemory,
  startChannelMemoryProxy,
} from '../../src/integrations/slack/channel-memory.js';
import { renderChannelMemory } from '../../src/contracts/channel-commands.js';

const scope = { teamId: 'TTEST', channelId: 'CTEST' };
const empty = {
  revision: 0,
  hash: createHash('sha256').update('').digest('hex'),
  rendered: '',
  entries: [],
};
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
it('validates canonical structure, rendered hash, bounds and channel provenance', () => {
  expect(validateChannelMemory(empty, scope)).toEqual(empty);
  const entries = [
    {
      id: 1,
      text: 'explicit note',
      creator: 'UONE',
      editor: 'UONE',
      channelId: 'COTHER',
      threadTs: '1716234567.000001',
      messageTs: '1716234567.000001',
      createdAt: 1,
      lastConfirmedAt: 1,
    },
  ];
  const rendered = renderChannelMemory(entries);
  for (const snapshot of [
    { ...empty, hash: 'a'.repeat(64) },
    { ...empty, revision: -1 },
    { ...empty, rendered: 'injected' },
    { revision: 1, entries, rendered, hash: createHash('sha256').update(rendered).digest('hex') },
  ])
    expect(() => validateChannelMemory(snapshot, scope)).toThrow('memory_unavailable');
});
it('proxies only the fixed authenticated admin snapshot, bounds input/output and sanitizes failures', async () => {
  const calls: Array<{ url: string; auth?: string; body: unknown }> = [];
  let reply: unknown = empty;
  const admin = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += String(c);
    calls.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => admin.listen(0, '127.0.0.1', r));
  closes.push(() => new Promise<void>((r) => admin.close(() => r())));
  const proxy = startChannelMemoryProxy({
    host: '127.0.0.1',
    port: 0,
    token: 'instance',
    adminUrl: `http://127.0.0.1:${(admin.address() as { port: number }).port}`,
    adminToken: 'admin-only',
    ready: () => true,
  });
  await proxy.ready;
  closes.push(() => proxy.close());
  const baseUrl = `http://127.0.0.1:${proxy.port}`;
  const transport = createChannelMemoryTransport({ baseUrl, token: 'instance' });
  closes.push(() => transport.close());
  expect(await transport.snapshot(scope)).toEqual(empty);
  expect(calls).toEqual([
    { url: '/internal/channel-commands/snapshot', auth: 'Bearer admin-only', body: scope },
  ]);
  const request = (route: string, token: string, body: unknown) =>
    fetch(baseUrl + route, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await request('/internal/channel-memory/snapshot', 'wrong', scope)).status).toBe(401);
  expect((await request('/internal/channel-commands/execute', 'instance', scope)).status).toBe(404);
  for (const body of [
    { ...scope, url: 'http://attacker' },
    { ...scope, channelId: '../C' },
    { ...scope, teamId: 'T'.repeat(1000) },
  ])
    expect((await request('/internal/channel-memory/snapshot', 'instance', body)).status).toBe(400);
  expect(calls).toHaveLength(1);
  reply = { ...empty, hash: 'b'.repeat(64), secret: 'never disclose' };
  await expect(transport.snapshot(scope)).rejects.toThrow('memory_unavailable');
  const failure = await request('/internal/channel-memory/snapshot', 'instance', scope);
  expect(await failure.text()).toBe('{"error":"memory_unavailable"}');
  reply = 'x'.repeat(200000);
  await expect(transport.snapshot(scope)).rejects.toThrow('memory_unavailable');
});
it('rejects response scope substitution, including an empty snapshot from another workspace', async () => {
  for (const responseScope of [
    { teamId: 'TOTHER', channelId: 'CTEST' },
    { teamId: 'TTEST', channelId: 'COTHER' },
  ]) {
    const transport = createChannelMemoryTransport({
      baseUrl: 'http://fixture.invalid',
      token: 'synthetic',
      fetch: async () => new Response(JSON.stringify({ ...responseScope, snapshot: empty })),
    });
    await expect(transport.snapshot(scope)).rejects.toThrow('memory_unavailable');
    await transport.close();
  }
});
it('aborts and joins an active proxy request on shutdown without leaking admin errors', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const proxy = startChannelMemoryProxy({
    host: '127.0.0.1',
    port: 0,
    token: 'instance',
    adminUrl: 'http://fixture.invalid',
    adminToken: 'admin-only',
    ready: () => true,
    fetch: async (_input, init) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(new Error('private admin details'))),
      );
      throw new Error('unexpected');
    },
  });
  await proxy.ready;
  const transport = createChannelMemoryTransport({
    baseUrl: `http://127.0.0.1:${proxy.port}`,
    token: 'instance',
  });
  const pending = transport.snapshot(scope);
  const rejected = expect(pending).rejects.toThrow('memory_unavailable');
  await started;
  await proxy.close();
  await rejected;
  await transport.close();
  await expect(transport.snapshot(scope)).rejects.toThrow('memory_unavailable');
});
