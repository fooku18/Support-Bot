/**
 * the authenticated `/live` socket. Upgrade checks (path, public
 * URL, HTTPS proxy header, exact Origin, session cookie), per-session and
 * per-process limits, topic validation and frame size, subscribe-then-
 * versions, coalesced change notices, a new epoch per process, revocation
 * (logout and the periodic recheck), slow consumers and graceful shutdown.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { isLiveTopic, LiveFeed, LiveSockets, type LiveOptions } from '../src/live.js';

const ORIGIN = 'https://admin.example.test';
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function serve(overrides: Partial<LiveOptions> = {}) {
  const feed = overrides.feed ?? new LiveFeed();
  const valid = new Map([
    ['sid=alice', { id: 's-alice', adminId: 1 }],
    ['sid=alice2', { id: 's-alice-2', adminId: 1 }],
    ['sid=bob', { id: 's-bob', adminId: 2 }],
  ]);
  const sockets = new LiveSockets({
    feed,
    publicUrl: ORIGIN,
    resolveSession: (cookie) => valid.get(cookie ?? '') ?? null,
    ...overrides,
  });
  const server = http.createServer((_, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(async () => {
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { feed, sockets, url, valid };
}

interface Client {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  next(type: string): Promise<Record<string, unknown>>;
  closed: Promise<{ code: number }>;
}

function connect(
  url: string,
  headers: Record<string, string> = {
    origin: ORIGIN,
    'x-forwarded-proto': 'https',
    cookie: 'sid=alice',
  },
  path = '/live',
): Promise<Client | { status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}${path}`, { headers });
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
    let closedResolve!: (v: { code: number }) => void;
    const closed = new Promise<{ code: number }>((r) => (closedResolve = r));
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      messages.push(message);
      for (const waiter of [...waiters])
        if (waiter.type === message.type) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
    });
    ws.on('close', (code) => closedResolve({ code }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on('error', () => undefined);
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        closed,
        next: (type) => {
          const seen = messages.find((m) => m.type === type && !(m as { _used?: boolean })._used);
          if (seen !== undefined) {
            (seen as { _used?: boolean })._used = true;
            return Promise.resolve(seen);
          }
          return new Promise((r) => waiters.push({ type, resolve: r }));
        },
      }),
    );
    closers.push(async () => {
      ws.terminate();
    });
  });
}

const open = async (url: string, headers?: Record<string, string>) => {
  const client = await connect(url, headers);
  if ('status' in client) throw new Error(`upgrade refused ${client.status}`);
  return client;
};

describe('live socket upgrade', () => {
  it('refuses wrong paths, missing HTTPS, foreign origins and missing sessions', async () => {
    const { url } = await serve();
    const base = { origin: ORIGIN, 'x-forwarded-proto': 'https', cookie: 'sid=alice' };
    expect(await connect(url, base, '/elsewhere')).toEqual({ status: 404 });
    expect(await connect(url, { ...base, 'x-forwarded-proto': 'http' })).toEqual({ status: 403 });
    expect(await connect(url, { ...base, origin: 'https://evil.example' })).toEqual({
      status: 403,
    });
    expect(await connect(url, { ...base, origin: `${ORIGIN}:443` })).toEqual({ status: 403 });
    expect(await connect(url, { ...base, cookie: 'sid=forged' })).toEqual({ status: 401 });
    const anonymous = { origin: ORIGIN, 'x-forwarded-proto': 'https' };
    expect(await connect(url, anonymous)).toEqual({ status: 401 });
    // An API token is not a session: bearer upgrades are refused.
    expect(await connect(url, { ...anonymous, authorization: 'Bearer cat_x' })).toEqual({
      status: 401,
    });
  });

  it('refuses every upgrade without a public URL', async () => {
    const { url } = await serve({ publicUrl: '' });
    expect(await connect(url)).toEqual({ status: 403 });
  });

  it('bounds sockets per session and per process', async () => {
    const { url } = await serve({
      limits: { socketsPerSession: 2, socketsPerProcess: 3 } as unknown as LiveOptions['limits'],
    });
    await open(url);
    await open(url);
    expect(await connect(url)).toEqual({ status: 429 });
    await open(url, { origin: ORIGIN, 'x-forwarded-proto': 'https', cookie: 'sid=bob' });
    expect(
      await connect(url, { origin: ORIGIN, 'x-forwarded-proto': 'https', cookie: 'sid=alice2' }),
    ).toEqual({ status: 503 });
  });
});

describe('live socket feed', () => {
  it('says hello with the epoch, reports versions on subscribe and coalesces changes', async () => {
    const { url, feed } = await serve();
    feed.bump(['config', 'config', 'audit']);
    const client = await open(url);
    const hello = await client.next('hello');
    expect(hello.epoch).toBe(feed.epoch);
    client.ws.send(JSON.stringify({ type: 'subscribe', topics: ['config', 'audit'] }));
    expect((await client.next('versions')).versions).toEqual({ config: 2, audit: 1 });
    // A burst of bumps reaches the client as one notice with the latest versions.
    feed.bump(['config']);
    feed.bump(['config', 'costs']);
    feed.bump(['config']);
    const changed = await client.next('changed');
    expect(changed.versions).toEqual({ config: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.messages.filter((m) => m.type === 'changed')).toHaveLength(1);
  });

  it('delivers a change notice within milliseconds of the store commit (latency target)', async () => {
    const { url, feed } = await serve();
    const client = await open(url);
    await client.next('hello');
    client.ws.send(JSON.stringify({ type: 'subscribe', topics: ['config'] }));
    await client.next('versions');
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t0 = performance.now();
      feed.bump(['config']);
      await client.next('changed');
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    console.log(`LIVE_NOTICE_LATENCY_MS p50=${samples[25]!.toFixed(2)} p95=${p95.toFixed(2)}`);
    expect(p95).toBeLessThan(100);
  });

  it('every process has its own epoch (restart or restore forces a resync)', () => {
    expect(new LiveFeed().epoch).not.toBe(new LiveFeed().epoch);
  });

  it('closes on invalid topics, too many topics, binary or oversized frames', async () => {
    const { url } = await serve();
    const bad = await open(url);
    bad.ws.send(JSON.stringify({ type: 'subscribe', topics: ['thread:not-a-key'] }));
    expect((await bad.closed).code).toBe(1008);
    const many = await open(url);
    many.ws.send(
      JSON.stringify({ type: 'subscribe', topics: Array.from({ length: 33 }, () => 'config') }),
    );
    expect((await many.closed).code).toBe(1008);
    const binary = await open(url);
    binary.ws.send(Buffer.from([1, 2, 3]));
    expect((await binary.closed).code).toBe(1003);
    const big = await open(url);
    big.ws.send('x'.repeat(5000));
    expect((await big.closed).code).toBe(1009);
    expect(isLiveTopic('costs')).toBe(true);
    expect(isLiveTopic('secrets')).toBe(false);
    expect(isLiveTopic('threads')).toBe(false);
    expect(isLiveTopic('thread:v1:B1:T1:C1:1794900000.000001')).toBe(false);
  });
});

describe('live socket lifetime', () => {
  it('closes a session at once on revocation and on the periodic recheck', async () => {
    const { url, sockets, valid } = await serve();
    const alice = await open(url);
    const bob = await open(url, {
      origin: ORIGIN,
      'x-forwarded-proto': 'https',
      cookie: 'sid=bob',
    });
    sockets.revokeSession('s-alice');
    expect((await alice.closed).code).toBe(4401);
    valid.delete('sid=bob');
    await sockets.recheckSessions();
    expect((await bob.closed).code).toBe(4401);
    const again = await open(url, {
      origin: ORIGIN,
      'x-forwarded-proto': 'https',
      cookie: 'sid=alice2',
    });
    sockets.revokeAdmin(1);
    expect((await again.closed).code).toBe(4401);
  });

  it('terminates a slow consumer instead of buffering for it', async () => {
    const { url, sockets } = await serve({ limits: { maxBufferedBytes: -1 } });
    const client = await connect(url);
    if (!('status' in client)) expect((await client.closed).code).toBe(1006);
    expect(sockets.size).toBe(0);
  });

  it('closes every socket on shutdown and refuses new upgrades', async () => {
    const { url, sockets } = await serve();
    const client = await open(url);
    sockets.close();
    expect((await client.closed).code).toBe(1001);
    expect(await connect(url)).toEqual({ status: 503 });
  });
});
