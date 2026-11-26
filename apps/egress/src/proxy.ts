/**
 * CONNECT-only HTTP proxy. A client sends `CONNECT host:port`; the proxy
 * decides by the client's source network and the policy, resolves the host
 * itself (clients on internal networks have no external DNS), connects to the
 * target and pipes bytes both ways. It never parses the tunnelled bytes and
 * never sees credentials: TLS stays end to end. Any other request method is
 * refused.
 *
 * Every tunnel logs one structured line when it opens (source, host, port,
 * mode) and one when it ends (plus bytes, duration and why); denials are
 * logged and counted per source.
 */

import { refusedModelAddress } from './generated/model-address.js';
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { isPrivateAddress, normalizeAddress } from './net.js';
import { decide, normalizeHost, sourceOf, type Policy, type Source } from './policy.js';

export interface Resolver {
  (host: string): Promise<string[]>;
}

export interface Dialer {
  (address: string, port: number, timeoutMs: number): Promise<net.Socket>;
}

export interface ProxyOptions {
  policy: Policy;
  /** Host name to addresses (default: dns.lookup, all addresses). */
  resolve?: Resolver;
  /** Opens the upstream connection (default: net.connect with a timeout). */
  dial?: Dialer;
  connectTimeoutMs?: number;
  /** Both directions idle for this long ends the tunnel (default 10 min). */
  idleTimeoutMs?: number;
  /** Concurrent tunnels admitted per source network (default 256). */
  maxTunnelsPerSource?: number;
  /** Delay before the single retry of an EAI_AGAIN lookup (default 300 ms). */
  resolveRetryMs?: number;
  log?: (line: Record<string, unknown>) => void;
}

export interface ProxyStats {
  active: Record<Source, number>;
  tunnels: Record<Source, number>;
  denied: Record<Source, number>;
}

export interface ProxyServer {
  server: http.Server;
  stats(): ProxyStats;
  close(): Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TUNNELS = 256;
/** One retry after this delay when the resolver answers EAI_AGAIN. */
const DEFAULT_RESOLVE_RETRY_MS = 300;

function counters(): Record<Source, number> {
  return { frontend: 0, tools: 0, web: 0, unknown: 0 };
}

export const defaultResolver: Resolver = async (host) => {
  const answers = await lookup(host, { all: true });
  return answers.map((a) => a.address);
};

export const defaultDialer: Dialer = (address, port, timeoutMs) =>
  new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy(new Error('connect timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

/** The resolver error code for the `unresolved` log line, `empty` when no address came back. */
export function lookupErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'error';
}

/** `host:port` or `[v6]:port` as sent in the CONNECT request line. */
export function parseTarget(url: string | undefined): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:\s/\\]+)):(\d{1,5})$/.exec(url ?? '');
  if (match === null) return null;
  const host = match[1] ?? match[2] ?? '';
  const port = Number.parseInt(match[3] ?? '', 10);
  if (host.length === 0 || port < 1 || port > 65535) return null;
  return { host, port };
}

export function createProxyServer(options: ProxyOptions): ProxyServer {
  const resolve = options.resolve ?? defaultResolver;
  const dial = options.dial ?? defaultDialer;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxTunnels = options.maxTunnelsPerSource ?? DEFAULT_MAX_TUNNELS;
  const resolveRetryMs = options.resolveRetryMs ?? DEFAULT_RESOLVE_RETRY_MS;
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const stats: ProxyStats = { active: counters(), tunnels: counters(), denied: counters() };
  const sockets = new Set<net.Socket>();

  const refuse = (
    socket: net.Socket,
    status: number,
    source: Source,
    detail: Record<string, unknown>,
  ): void => {
    stats.denied[source] += 1;
    log({ event: 'denied', status, source, ...detail });
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(405, { allow: 'CONNECT', connection: 'close', 'content-length': '0' });
    res.end();
  });
  server.keepAliveTimeout = 5_000;

  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    const startedAt = Date.now();
    clientSocket.on('error', () => undefined);
    const clientAddress = normalizeAddress(clientSocket.remoteAddress ?? '');
    const source = sourceOf(options.policy, clientAddress);
    const target = parseTarget(req.url);
    if (target === null) {
      refuse(clientSocket, 400, source, { reason: 'malformed', client: clientAddress });
      return;
    }
    const host = normalizeHost(target.host);
    const port = target.port;
    const decision = decide(options.policy, source, host, port);
    if (!decision.allow) {
      refuse(clientSocket, 403, source, {
        reason: decision.reason,
        host,
        port,
        client: clientAddress,
      });
      return;
    }
    if (stats.active[source] >= maxTunnels) {
      refuse(clientSocket, 503, source, { reason: 'limit', host, port, client: clientAddress });
      return;
    }
    stats.active[source] += 1;
    let held = true;
    const release = (): void => {
      if (!held) return;
      held = false;
      stats.active[source] -= 1;
    };

    void (async () => {
      // A temporary resolver failure (EAI_AGAIN, typical right after boot)
      // gets one short retry; the log names the code either way.
      let addresses: string[] = [];
      let code = 'empty';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          addresses = await resolve(host);
          code = 'empty';
        } catch (err) {
          addresses = [];
          code = lookupErrorCode(err);
        }
        if (addresses.length > 0 || code !== 'EAI_AGAIN' || attempt > 0) break;
        await new Promise((r) => setTimeout(r, resolveRetryMs));
        if (clientSocket.destroyed) {
          release();
          return;
        }
      }
      if (addresses.length === 0) {
        release();
        refuse(clientSocket, 502, source, { reason: 'unresolved', code, host, port });
        return;
      }
      if (
        (decision.mode === 'public' && addresses.some(isPrivateAddress)) ||
        (options.policy.modelHosts.has(host) && addresses.some(refusedModelAddress))
      ) {
        release();
        refuse(clientSocket, 403, source, { reason: 'private-address', host, port });
        return;
      }
      let upstream: net.Socket | null = null;
      let lastError = 'connect failed';
      for (const address of addresses) {
        if (clientSocket.destroyed) {
          release();
          return;
        }
        try {
          upstream = await dial(address, port, connectTimeoutMs);
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      if (upstream === null) {
        release();
        refuse(clientSocket, lastError.includes('timeout') ? 504 : 502, source, {
          reason: 'upstream',
          host,
          port,
        });
        return;
      }
      if (clientSocket.destroyed) {
        release();
        upstream.destroy();
        return;
      }
      stats.tunnels[source] += 1;
      // Long-lived tunnels (Socket Mode, keep-alive pools) end hours later;
      // the open line makes them visible while they run.
      log({ event: 'open', source, host, port, mode: decision.mode });
      sockets.add(clientSocket);
      sockets.add(upstream);
      const established = upstream;
      let finished = false;
      const finish = (why: string): void => {
        if (finished) return;
        finished = true;
        release();
        sockets.delete(clientSocket);
        sockets.delete(established);
        log({
          event: 'tunnel',
          source,
          host,
          port,
          mode: decision.mode,
          bytesIn: established.bytesRead,
          bytesOut: established.bytesWritten,
          ms: Date.now() - startedAt,
          end: why,
        });
        clientSocket.destroy();
        established.destroy();
      };
      established.on('error', () => finish('upstream-error'));
      established.on('close', () => finish('upstream-closed'));
      clientSocket.on('close', () => finish('client-closed'));
      clientSocket.setTimeout(idleTimeoutMs, () => finish('idle'));
      established.setTimeout(idleTimeoutMs, () => finish('idle'));
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) established.write(head);
      clientSocket.pipe(established);
      established.pipe(clientSocket);
    })();
  });

  return {
    server,
    stats: () => ({
      active: { ...stats.active },
      tunnels: { ...stats.tunnels },
      denied: { ...stats.denied },
    }),
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
