import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  isChannelMemorySnapshot,
  type ChannelMemorySnapshot,
} from '../../contracts/channel-commands.js';
const route = '/internal/channel-memory/snapshot';
const unavailable = () => new Error('memory_unavailable');
export interface ChannelMemoryScope {
  teamId: string;
  channelId: string;
}
export interface ChannelMemoryTransport {
  snapshot(scope: ChannelMemoryScope): Promise<ChannelMemorySnapshot>;
}
export function validateMemoryScope(value: unknown): ChannelMemoryScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const v = value as ChannelMemoryScope;
  if (
    Object.keys(v).sort().join(',') !== 'channelId,teamId' ||
    typeof v.teamId !== 'string' ||
    !/^T[A-Z0-9]{1,63}$/.test(v.teamId) ||
    typeof v.channelId !== 'string' ||
    !/^[CG][A-Z0-9]{1,63}$/.test(v.channelId)
  )
    throw unavailable();
  return { teamId: v.teamId, channelId: v.channelId };
}
export function validateChannelMemory(
  value: unknown,
  scope: ChannelMemoryScope,
): ChannelMemorySnapshot {
  validateMemoryScope(scope);
  if (
    !isChannelMemorySnapshot(value) ||
    createHash('sha256').update(value.rendered).digest('hex') !== value.hash ||
    value.entries.some(
      (e) =>
        e.channelId !== scope.channelId ||
        !/^[UW][A-Z0-9]{1,63}$/.test(e.creator) ||
        !/^[UW][A-Z0-9]{1,63}$/.test(e.editor) ||
        !/^\d{10,16}\.\d{1,6}$/.test(e.threadTs) ||
        !/^\d{10,16}\.\d{1,6}$/.test(e.messageTs) ||
        e.createdAt < 0 ||
        e.lastConfirmedAt < e.createdAt,
    )
  )
    throw unavailable();
  // Drop unknown properties before retaining data from an authority boundary.
  return {
    revision: value.revision,
    hash: value.hash,
    rendered: value.rendered,
    entries: value.entries.map((e) => ({
      id: e.id,
      text: e.text,
      creator: e.creator,
      editor: e.editor,
      channelId: e.channelId,
      threadTs: e.threadTs,
      messageTs: e.messageTs,
      createdAt: e.createdAt,
      lastConfirmedAt: e.lastConfirmedAt,
    })),
  };
}
function endpoint(base: string, path: string) {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw unavailable();
  return new URL(path, url).href;
}
async function boundedJson(response: Response, max = 160000): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw unavailable();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function fetchSnapshot(options: {
  baseUrl: string;
  token: string;
  path: string;
  envelope: boolean;
  fetch?: typeof fetch;
}) {
  const url = endpoint(options.baseUrl, options.path);
  if (!options.token) throw unavailable();
  const abort = new AbortController();
  const active = new Set<Promise<ChannelMemorySnapshot>>();
  let closed = false;
  return {
    snapshot(scope: ChannelMemoryScope, signal?: AbortSignal) {
      if (closed || active.size >= 16) return Promise.reject(unavailable());
      const work = (async () => {
        try {
          scope = validateMemoryScope(scope);
          const response = await (options.fetch ?? fetch)(url, {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${options.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(scope),
            signal: AbortSignal.any([
              abort.signal,
              AbortSignal.timeout(2000),
              ...(signal ? [signal] : []),
            ]),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw unavailable();
          }
          const body = await boundedJson(response);
          if (!options.envelope) return validateChannelMemory(body, scope);
          const envelope = body as ChannelMemoryScope & { snapshot: unknown };
          if (
            !envelope ||
            envelope.teamId !== scope.teamId ||
            envelope.channelId !== scope.channelId
          )
            throw unavailable();
          return validateChannelMemory(envelope.snapshot, scope);
        } catch {
          throw unavailable();
        }
      })();
      active.add(work);
      void work.then(
        () => active.delete(work),
        () => active.delete(work),
      );
      return work;
    },
    async close() {
      closed = true;
      abort.abort();
      await Promise.allSettled(active);
    },
  };
}
/** Required coordinator dependency. Its caller joins close() before ending runtime ownership. */
export function createChannelMemoryTransport(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}) {
  return fetchSnapshot({ ...options, path: route, envelope: true });
}
/** The config writer alone owns adminapi access. No task pool, URL selection or command forwarding. */
export function startChannelMemoryProxy(options: {
  host: string;
  port: number;
  token: string;
  adminUrl: string;
  adminToken: string;
  ready: () => boolean;
  fetch?: typeof fetch;
}) {
  if (!options.token) throw unavailable();
  const upstream = fetchSnapshot({
    baseUrl: options.adminUrl,
    token: options.adminToken,
    path: '/internal/channel-commands/snapshot',
    envelope: false,
    fetch: options.fetch,
  });
  const expected = Buffer.from(`Bearer ${options.token}`);
  const handlers = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = http.createServer((req, res) => {
    const handler = handle(req, res);
    handlers.add(handler);
    void handler.then(
      () => handlers.delete(handler),
      () => handlers.delete(handler),
    );
  });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(!closing && options.ready() ? 200 : 503).end();
      return;
    }
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== route) {
      res.writeHead(404).end();
      return;
    }
    if (closing || handlers.size >= 16) {
      res.writeHead(503).end('{"error":"memory_unavailable"}');
      return;
    }
    let scope: ChannelMemoryScope;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 512) throw unavailable();
        chunks.push(Buffer.from(chunk));
      }
      scope = validateMemoryScope(JSON.parse(Buffer.concat(chunks).toString()));
    } catch {
      res.writeHead(400).end('{"error":"invalid_scope"}');
      return;
    }
    const abort = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.once('close', disconnect);
    try {
      const snapshot = await upstream.snapshot(scope, abort.signal);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...scope, snapshot }));
    } catch {
      res
        .writeHead(503, { 'content-type': 'application/json' })
        .end('{"error":"memory_unavailable"}');
    } finally {
      res.off('close', disconnect);
    }
  }
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.setTimeout(4000, (socket) => socket.destroy());
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    ready,
    get port() {
      return (server.address() as { port: number }).port;
    },
    close() {
      closing ??= (async () => {
        await ready;
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        await upstream.close();
        await Promise.allSettled(handlers);
        await closed;
      })();
      return closing;
    },
  };
}
