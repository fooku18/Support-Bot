/**
 * Egress proxy entry point. Listens for CONNECT
 * on EGRESS_PROXY_PORT (default 3128) on every container interface, relays
 * the inbound forwards in EGRESS_FORWARDS (host-published ports to internal
 * services, e.g. 9880:native-answer:9879) and serves /healthz and /metrics on the
 * loopback status port EGRESS_STATUS_PORT (default 3129) for the Compose
 * healthcheck. The policy
 * comes from the process environment only (the same instance env file as the
 * other services); it is logged at start, without secrets (host names and
 * subnets only).
 */

import http from 'node:http';
import { parseForwards, startForwards } from './forward.js';
import { createProxyServer } from './proxy.js';
import { policyFromEnv } from './policy.js';

function intOr(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function main(): void {
  const log = (line: Record<string, unknown>): void => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...line }));
  };
  const policy = policyFromEnv((name) => process.env[name]);
  const proxy = createProxyServer({
    policy,
    log,
    idleTimeoutMs: intOr(process.env.EGRESS_IDLE_TIMEOUT_MS, 600_000),
  });
  const port = intOr(process.env.EGRESS_PROXY_PORT, 3128);
  const statusPort = intOr(process.env.EGRESS_STATUS_PORT, 3129);

  const status = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    if (req.url === '/metrics') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(`${JSON.stringify(proxy.stats())}\n`);
      return;
    }
    res.writeHead(404).end();
  });

  const forwards = parseForwards(process.env.EGRESS_FORWARDS);
  for (const problem of forwards.problems) log({ event: 'config-problem', problem });
  const forwarder = startForwards(forwards.forwards, { log, policy });
  forwarder.catch((err: unknown) => {
    log({ event: 'forward-failed', error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });

  proxy.server.listen(port, '0.0.0.0', () => {
    log({
      event: 'listening',
      port,
      statusPort,
      subnets: {
        frontend: policy.subnets.frontend !== null,
        tools: policy.subnets.tools !== null,
        web: policy.subnets.web !== null,
      },
      frontendHosts: [...policy.frontendHosts].sort(),
      toolsHosts: [...policy.toolsHosts].sort(),
      problems: policy.problems,
    });
  });
  status.listen(statusPort, '127.0.0.1');

  const stop = (signal: string): void => {
    log({ event: 'stopping', signal });
    status.close();
    void Promise.all([
      proxy.close(),
      forwarder.then(
        (f) => f.close(),
        () => undefined,
      ),
    ]).then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main();
