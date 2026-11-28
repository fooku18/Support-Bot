import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CoordinatorError } from './errors.js';
import { reason } from './agent-support.js';
import type { StageLogger } from '../infrastructure/logger.js';
import type { NativeAgentService } from './agent-service.js';
import type { NativeAgentInput } from './agent-options.js';

/** Private, service-authenticated ingress. Actor/installation are supplied only
 * by the authenticated Slack adapter, never from a model or a public webhook.
 * Deliberately no old claims, leases, controls, context or recovery routes. */
export function startNativeAgentServer(options: {
  agents: NativeAgentService;
  token: string;
  host: string;
  port: number;
  readiness?: () => Promise<void>;
  send: Parameters<NativeAgentService['deliver']>[3];
  log: StageLogger;
}) {
  if (!options.token) throw new Error('native answer ingress requires authentication');
  const expected = Buffer.from(`Bearer ${options.token}`);
  const handlers = new Set<Promise<void>>();
  const server = http.createServer((req, res) => {
    const handler = handle(req, res);
    handlers.add(handler);
    void handler.finally(() => handlers.delete(handler));
  });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const token = Buffer.from(req.headers.authorization ?? '');
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
        res.writeHead(401).end();
        return;
      }
      if (
        req.method === 'GET' &&
        ['/healthz', '/readyz', '/native/status'].includes(req.url ?? '')
      ) {
        // Intake is stopped before draining. Its upstream readiness must not
        // hide the local execution/delivery state needed to complete shutdown.
        if (req.url !== '/native/status') await options.readiness?.();
        const status = await options.agents.operations();
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: status.accepting, ...status }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 256000) throw new CoordinatorError(413, 'body_too_large');
        chunks.push(Buffer.from(chunk));
      }
      let b;
      try {
        b = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw new CoordinatorError(400, 'invalid_body');
      }
      if (!b || typeof b !== 'object' || Array.isArray(b))
        throw new CoordinatorError(400, 'invalid_body');
      let result: unknown;
      switch (req.url) {
        case '/agents/delivery-authority':
          result = await options.agents.deliveryAuthority(b.runId, b.actor, b.owner, b.operationId);
          break;
        case '/agents/model':
          result = await options.agents.selectedModel(b.teamId, b.channelId);
          break;
        case '/agents/thread':
          result = await options.agents.thread(
            b as NativeAgentInput,
            b.anyParticipant === true,
            ['task.cancel', 'task.steer', 'task.read'].includes(b.control) ? b.control : undefined,
          );
          break;
        case '/agents/present':
          result = await options.agents.present(b.runId, b.actor, b.owner, options.send);
          break;
        case '/agents/followup':
          result = await options.agents.followup(
            b as NativeAgentInput,
            b.expectedOwner,
            b.anyParticipant === true,
          );
          break;
        case '/agents/start':
          result = await options.agents.start(b as NativeAgentInput);
          break;
        case '/agents/resume':
          result = await options.agents.resume(b.runId, b.actor, b.owner, b.toolCallId, b.answer);
          break;
        case '/agents/result':
          result = await options.agents.result(b.runId, b.actor, b.owner);
          break;
        case '/agents/cancel':
          result = await options.agents.cancel(b.runId, b.actor, b.owner);
          break;
        case '/agents/inspect':
          result = await options.agents.inspect(b.runId, b.actor, b.owner);
          break;
        case '/agents/deliver':
          result = await options.agents.deliver(b.runId, b.actor, b.owner, options.send);
          break;
        default:
          res.writeHead(404).end();
          return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof CoordinatorError;
      if (!known)
        options.log.error(
          `native ingress failed route=${(req.url ?? '').split('?')[0]} reason=${reason(error)}`,
        );
      res
        .writeHead(known ? error.status : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: known ? error.code : 'native_agent_unavailable' }));
    }
  }
  server.requestTimeout = 15000;
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  let closing: Promise<void> | undefined;
  return {
    ready,
    get port() {
      const a = server.address();
      if (!a || typeof a === 'string') throw new Error('not listening');
      return a.port;
    },
    close() {
      return (closing ??= (async () => {
        await ready;
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
        await Promise.allSettled([...handlers]);
        await options.agents.close();
      })());
    },
  };
}

/** Composition entry: compose the native agent on this ingress.
 * The native receiver transport points here; it must not enqueue old claims.
 * Infrastructure/credential clients are supplied by the application, not env
 * discovery inside the agent or a second coordinator execution owner. */
export async function startNativeApplication(options: {
  service: import('./agent-options.js').NativeAgentOptions;
  transport: Omit<Parameters<typeof startNativeAgentServer>[0], 'agents' | 'log'>;
}) {
  const { createNativeAgentService } = await import('./agent-service.js');
  await options.transport.readiness?.();
  const agents = createNativeAgentService(options.service);
  const server = startNativeAgentServer({ ...options.transport, agents, log: options.service.log });
  try {
    await server.ready;
  } catch (error) {
    await agents.close();
    throw error;
  }
  return { agents, server };
}
