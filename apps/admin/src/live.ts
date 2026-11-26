/**
 * Application settings change notices over one authenticated WebSocket (`/live`).
 *
 * The socket carries only coalescable topic invalidations (`topic`,
 * `epoch`, `version`), never page content;
 * the browser offers a reload without replacing forms. Topic versions are
 * in-memory counters under a random feed `epoch` that changes on every
 * process start (and so after a restore): a client that sees a new epoch
 * offers a reload. There is no replay log.
 *
 * Upgrade checks (the same boundary as HTTP): path `/live` only; refused
 * when ADMIN_PUBLIC_URL is unset; `X-Forwarded-Proto: https` from the
 * TLS-terminating proxy; `Origin` exactly the ADMIN_PUBLIC_URL origin; a
 * live session cookie (`Sessions.resolve`; no API tokens, nothing in the
 * URL). Sessions are re-resolved every 30 s and closed at once on logout,
 * password change or admin disable.
 *
 * Bounds: 64 sockets per process, 8 per session, 32 topics per socket,
 * 4 KiB frames, no compression; a client whose send buffer exceeds 256 KiB
 * or that misses a ping (25 s) is terminated and resynchronizes on
 * reconnect. Sockets close before the store closes.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

export const LIVE_PATH = '/live';
export const LIVE_LIMITS = {
  socketsPerProcess: 64,
  socketsPerSession: 8,
  topicsPerSocket: 32,
  maxPayload: 4096,
  maxBufferedBytes: 256 * 1024,
  heartbeatMs: 25_000,
  sessionRecheckMs: 30_000,
} as const;

type LiveLimits = Record<keyof typeof LIVE_LIMITS, number>;

const SETTINGS_TOPICS = new Set(['costs', 'audit', 'config']);

export function isLiveTopic(topic: unknown): topic is string {
  return typeof topic === 'string' && SETTINGS_TOPICS.has(topic);
}

/** Topic versions under one feed epoch; listeners hear every bump. */
export class LiveFeed {
  readonly epoch = randomUUID();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<(topic: string, version: number) => void>();
  version(topic: string): number {
    return this.versions.get(topic) ?? 0;
  }

  bump(topics: Iterable<string>): void {
    for (const topic of topics) {
      const version = this.version(topic) + 1;
      this.versions.set(topic, version);
      for (const listener of this.listeners) listener(topic, version);
    }
  }

  onBump(listener: (topic: string, version: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface LiveSession {
  id: string;
  adminId: number;
}

export interface LiveOptions {
  feed: LiveFeed;
  /** ADMIN_PUBLIC_URL; empty refuses every upgrade. */
  publicUrl: string;
  /** Session of a cookie header (the HTTP resolver); null when not signed in. */
  resolveSession: (
    cookieHeader: string | undefined,
  ) => Promise<LiveSession | null> | LiveSession | null;
  log?: (line: string) => void;
  limits?: Partial<LiveLimits>;
}

interface Client {
  ws: WebSocket;
  session: LiveSession;
  cookie: string | undefined;
  topics: Set<string>;
  pending: Map<string, number>;
  alive: boolean;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${reason.length}\r\n\r\n${reason}`,
  );
  socket.destroy();
}

/** The authenticated socket service (attach to the HTTP server's `upgrade`). */
export class LiveSockets {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly limits: LiveLimits;
  private readonly origin: string | null;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly unsubscribe: () => void;
  private flushScheduled = false;
  private closed = false;

  constructor(private readonly options: LiveOptions) {
    this.limits = { ...LIVE_LIMITS, ...(options.limits ?? {}) };
    let origin: string | null = null;
    try {
      origin = options.publicUrl.length > 0 ? new URL(options.publicUrl).origin : null;
    } catch {
      origin = null;
    }
    this.origin = origin;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.maxPayload,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.unsubscribe = options.feed.onBump((topic, version) => this.queue(topic, version));
    const heartbeat = setInterval(() => this.heartbeat(), this.limits.heartbeatMs);
    heartbeat.unref();
    const recheck = setInterval(() => void this.recheckSessions(), this.limits.sessionRecheckMs);
    recheck.unref();
    this.timers.push(heartbeat, recheck);
  }

  get size(): number {
    return this.clients.size;
  }

  /** `server.on('upgrade', ...)`: authenticates, then hands the socket to ws. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    const path = new URL(req.url ?? '/', 'http://admin.internal').pathname;
    if (path !== LIVE_PATH) return refuse(socket, 404, 'Not Found');
    if (this.closed) return refuse(socket, 503, 'Service Unavailable');
    if (this.origin === null) return refuse(socket, 403, 'Forbidden');
    if (req.headers['x-forwarded-proto'] !== 'https') return refuse(socket, 403, 'Forbidden');
    if (req.headers.origin !== this.origin) return refuse(socket, 403, 'Forbidden');
    let session: LiveSession | null;
    try {
      session = await this.options.resolveSession(req.headers.cookie);
    } catch {
      return refuse(socket, 503, 'Service Unavailable');
    }
    if (socket.destroyed) return;
    if (this.closed) return refuse(socket, 503, 'Service Unavailable');
    if (session === null) return refuse(socket, 401, 'Unauthorized');
    if (this.clients.size >= this.limits.socketsPerProcess)
      return refuse(socket, 503, 'Service Unavailable');
    let perSession = 0;
    for (const client of this.clients) if (client.session.id === session.id) perSession += 1;
    if (perSession >= this.limits.socketsPerSession)
      return refuse(socket, 429, 'Too Many Requests');
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.register(ws, session, req.headers.cookie),
    );
  }

  private register(ws: WebSocket, session: LiveSession, cookie: string | undefined): void {
    const client: Client = {
      ws,
      session,
      cookie,
      topics: new Set(),
      pending: new Map(),
      alive: true,
    };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => this.receive(client, data, isBinary));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => ws.terminate());
    this.send(client, {
      type: 'hello',
      epoch: this.options.feed.epoch,
      heartbeatMs: this.limits.heartbeatMs,
    });
  }

  private receive(client: Client, data: unknown, isBinary: boolean): void {
    if (isBinary) return client.ws.close(1003, 'text frames only');
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return client.ws.close(1007, 'invalid message');
    }
    const body = message as { type?: unknown; topics?: unknown };
    if (body.type === 'ping')
      return this.send(client, { type: 'pong', epoch: this.options.feed.epoch });
    if (body.type !== 'subscribe' || !Array.isArray(body.topics))
      return client.ws.close(1008, 'unknown message');
    if (body.topics.length > this.limits.topicsPerSocket || !body.topics.every(isLiveTopic))
      return client.ws.close(1008, 'invalid topics');
    // Replace the subscription, then report every current version: the
    // client refetches whatever is newer than what it rendered.
    client.topics = new Set(body.topics as string[]);
    for (const topic of [...client.pending.keys()])
      if (!client.topics.has(topic)) client.pending.delete(topic);
    const versions: Record<string, number> = {};
    for (const topic of client.topics) versions[topic] = this.options.feed.version(topic);
    this.send(client, { type: 'versions', epoch: this.options.feed.epoch, versions });
  }

  /** Coalesces to the latest version per topic and client; sends on the next tick. */
  private queue(topic: string, version: number): void {
    let any = false;
    for (const client of this.clients)
      if (client.topics.has(topic)) {
        client.pending.set(topic, version);
        any = true;
      }
    if (!any || this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      for (const client of this.clients) {
        if (client.pending.size === 0) continue;
        const versions = Object.fromEntries(client.pending);
        client.pending.clear();
        this.send(client, { type: 'changed', epoch: this.options.feed.epoch, versions });
      }
    });
  }

  private send(client: Client, message: Record<string, unknown>): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    if (client.ws.bufferedAmount > this.limits.maxBufferedBytes) {
      // A slow reader never accumulates server memory: it reconnects and
      // resynchronizes from the current versions.
      client.ws.terminate();
      this.clients.delete(client);
      return;
    }
    client.ws.send(JSON.stringify(message));
  }

  private heartbeat(): void {
    for (const client of [...this.clients]) {
      if (!client.alive) {
        client.ws.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }

  /** The 30-second backstop for revocations the store did not report. */
  async recheckSessions(): Promise<void> {
    for (const client of [...this.clients]) {
      let session: LiveSession | null;
      try {
        session = await this.options.resolveSession(client.cookie);
      } catch {
        session = null;
      }
      if (this.clients.has(client) && (session === null || session.id !== client.session.id))
        this.drop(client, 4401, 'session ended');
    }
  }

  /** Closes every socket of a session (logout). */
  revokeSession(sessionId: string): void {
    for (const client of [...this.clients])
      if (client.session.id === sessionId) this.drop(client, 4401, 'session ended');
  }

  /** Closes every socket of an admin (password change, disable). */
  revokeAdmin(adminId: number): void {
    for (const client of [...this.clients])
      if (client.session.adminId === adminId) this.drop(client, 4401, 'session ended');
  }

  private drop(client: Client, code: number, reason: string): void {
    this.clients.delete(client);
    client.ws.close(code, reason);
    // A peer that never answers the close handshake is cut off.
    setTimeout(() => client.ws.terminate(), 1_000).unref();
  }

  /** Graceful shutdown: before the store closes. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const timer of this.timers) clearInterval(timer);
    for (const client of [...this.clients]) {
      client.ws.close(1001, 'server shutting down');
      setTimeout(() => client.ws.terminate(), 500).unref();
    }
    this.clients.clear();
    this.wss.close();
  }
}
