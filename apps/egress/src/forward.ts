/**
 * Inbound TCP forwards: the egress service is the instance's only container
 * with a non-internal network, so Docker can publish host ports on it alone.
 * The host-side harness and operator tools reach the agent through
 * `127.0.0.1:<EGRESS_HOST_PORT>` ; this relays that port to
 * `native-answer:9879` over the internal network. Spec: comma list of
 * `listenPort:targetHost:targetPort`. Bytes are relayed unchanged; one log
 * line per failed upstream connection, none per successful relay.
 *
 * The listener is reachable on every interface of the egress container,
 * including the application networks. With a `policy`, a client from one of
 * the instance's own subnets (frontend, tools, web) is refused: the relay
 * exists for host-published traffic only (it arrives from the egress bridge,
 * an `unknown` source), never as a path from the tool networks to the agent.
 */

import net from 'node:net';
import { normalizeAddress } from './net.js';
import { sourceOf, type Policy } from './policy.js';

export interface ForwardSpec {
  listenPort: number;
  targetHost: string;
  targetPort: number;
}

export function parseForwards(raw: string | undefined): {
  forwards: ForwardSpec[];
  problems: string[];
} {
  const forwards: ForwardSpec[] = [];
  const problems: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const spec = entry.trim();
    if (spec.length === 0) continue;
    const match = /^(\d{1,5}):([a-z0-9][a-z0-9.-]*):(\d{1,5})$/i.exec(spec);
    const listenPort = Number.parseInt(match?.[1] ?? '', 10);
    const targetPort = Number.parseInt(match?.[3] ?? '', 10);
    if (
      match === null ||
      listenPort < 1 ||
      listenPort > 65535 ||
      targetPort < 1 ||
      targetPort > 65535
    ) {
      problems.push(`EGRESS_FORWARDS: "${spec}" is not listenPort:host:targetPort; ignored`);
      continue;
    }
    forwards.push({ listenPort, targetHost: match[2] ?? '', targetPort });
  }
  return { forwards, problems };
}

export interface Forwarder {
  servers: net.Server[];
  close(): Promise<void>;
}

export function startForwards(
  forwards: ForwardSpec[],
  options: {
    host?: string;
    /** Refuse clients from the instance's own subnets (see the module comment). */
    policy?: Policy;
    log?: (line: Record<string, unknown>) => void;
  } = {},
): Promise<Forwarder> {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const sockets = new Set<net.Socket>();
  const servers = forwards.map((spec) => {
    const server = net.createServer((client) => {
      client.on('error', () => undefined);
      const clientAddress = normalizeAddress(client.remoteAddress ?? '');
      const source =
        options.policy !== undefined ? sourceOf(options.policy, clientAddress) : 'unknown';
      if (source !== 'unknown') {
        log({
          event: 'forward-refused',
          listenPort: spec.listenPort,
          source,
          client: clientAddress,
        });
        client.destroy();
        return;
      }
      const upstream = net.connect({ host: spec.targetHost, port: spec.targetPort });
      sockets.add(client);
      sockets.add(upstream);
      const finish = (): void => {
        sockets.delete(client);
        sockets.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      upstream.on('error', (err) => {
        log({
          event: 'forward-error',
          listenPort: spec.listenPort,
          target: `${spec.targetHost}:${spec.targetPort}`,
          error:
            err instanceof Error
              ? ((err as NodeJS.ErrnoException).code ?? err.message)
              : String(err),
        });
        finish();
      });
      upstream.on('close', finish);
      client.on('close', finish);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    return { spec, server };
  });
  return Promise.all(
    servers.map(
      ({ spec, server }) =>
        new Promise<net.Server>((resolve, reject) => {
          server.once('error', reject);
          server.listen(spec.listenPort, options.host ?? '0.0.0.0', () => {
            server.off('error', reject);
            log({
              event: 'forwarding',
              listenPort: spec.listenPort,
              target: `${spec.targetHost}:${spec.targetPort}`,
            });
            resolve(server);
          });
        }),
    ),
  ).then((started) => ({
    servers: started,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        let pending = started.length;
        if (pending === 0) return done();
        for (const server of started) server.close(() => (pending -= 1) === 0 && done());
      }),
  }));
}
