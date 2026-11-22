import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createAdminConfigSync } from '../../src/application/configuration/admin-sync.js';
import { compileDocument } from '../../../admin/src/compile.js';

const document = () => compileDocument(7, { installations: [], channels: [], blockedMembers: [] });
const sourceHash = document().hash;
const servers: http.Server[] = [];
async function peer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('forwards the complete admin document, and caches only the acknowledged source identity', async () => {
  const headers: http.IncomingHttpHeaders[] = [];
  let release!: () => void;
  const commit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adminUrl = await peer((req, res) => {
    headers.push(req.headers);
    expect(req.url).toBe('/internal/config');
    if (req.headers['if-none-match']) res.writeHead(304).end();
    else res.writeHead(200).end(JSON.stringify(document()));
  });
  let seen: unknown;
  const sync = createAdminConfigSync({
    adminUrl,
    adminToken: 'synthetic',
    async applyDocument(value) {
      seen = structuredClone(value);
      await commit;
      value.hash = 'b'.repeat(64);
    },
  });
  const first = sync.refresh();
  const concurrent = sync.refresh();
  expect(first).toBe(concurrent);
  release();
  expect(await first).toEqual({ status: 'applied', version: 7, adminHash: sourceHash });
  expect(seen).toEqual(document());
  expect(await sync.refresh()).toEqual({ status: 'unchanged', version: 7, adminHash: sourceHash });
  expect(headers).toHaveLength(2);
  expect(headers[0]).toMatchObject({
    authorization: 'Bearer synthetic',
  });
  expect(headers[0]?.['if-none-match']).toBeUndefined();
  expect(headers[1]?.['if-none-match']).toBe(`"${sourceHash}"`);
});

it('does not advance the ETag after unknown apply acknowledgement and sanitizes sink errors', async () => {
  const etags: unknown[] = [];
  const adminUrl = await peer((req, res) => {
    etags.push(req.headers['if-none-match']);
    res.end(JSON.stringify(document()));
  });
  let calls = 0;
  const sync = createAdminConfigSync({
    adminUrl,
    adminToken: 'synthetic',
    async applyDocument() {
      if (++calls === 1) throw new Error('private-sentinel-credential');
    },
  });
  expect(await sync.refresh()).toEqual({ status: 'unavailable', reason: 'apply' });
  expect(calls).toBe(1); // No automatic retry.
  expect(await sync.refresh()).toMatchObject({ status: 'applied' });
  expect(etags).toEqual([undefined, undefined]);
});

it('refuses unbacked 304, malformed or oversized documents without applying them', async () => {
  const bodies = [
    null,
    '{',
    JSON.stringify({ ...document(), version: '7' }),
    JSON.stringify({ ...document(), runLimits: {} }),
    JSON.stringify({ ...document(), feedbackIssues: null }),
    ' '.repeat(1024 * 1024 + 1),
  ];
  let calls = 0;
  const adminUrl = await peer((_req, res) => {
    const body = bodies.shift();
    if (body === null) res.writeHead(304).end();
    else res.end(body);
  });
  const sync = createAdminConfigSync({
    adminUrl,
    adminToken: 'synthetic',
    async applyDocument() {
      calls++;
    },
  });
  expect(await sync.refresh()).toEqual({ status: 'unavailable', reason: 'response' });
  for (let i = 0; i < 5; i++)
    expect(await sync.refresh()).toEqual({ status: 'unavailable', reason: 'document' });
  expect(calls).toBe(0);
});

it('does not follow redirects or forward the admin credential to a second service', async () => {
  let foreignCalls = 0;
  const foreign = await peer((_req, res) => {
    foreignCalls++;
    res.end('{}');
  });
  const adminUrl = await peer((_req, res) => res.writeHead(302, { location: foreign }).end());
  let applied = false;
  const sync = createAdminConfigSync({
    adminUrl,
    adminToken: 'synthetic',
    async applyDocument() {
      applied = true;
    },
  });
  expect(await sync.refresh()).toEqual({ status: 'unavailable', reason: 'fetch' });
  expect(foreignCalls).toBe(0);
  expect(applied).toBe(false);
});

it('refuses missing authentication or embedded URL credentials and aborts before dispatch', async () => {
  let calls = 0;
  const adminUrl = await peer((_req, res) => {
    calls++;
    res.end('{}');
  });
  const options = { adminUrl, adminToken: 'synthetic', async applyDocument() {} };
  expect(() => createAdminConfigSync({ ...options, adminToken: '' })).toThrow();
  expect(() =>
    createAdminConfigSync({ ...options, adminUrl: 'http://user:password@localhost' }),
  ).toThrow();
  const sync = createAdminConfigSync({ ...options, signal: AbortSignal.abort() });
  expect(await sync.refresh()).toEqual({ status: 'unavailable', reason: 'fetch' });
  expect(calls).toBe(0);
});
