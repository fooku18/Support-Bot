/**
 * Model stub HTTP server: `POST /v1/messages` (SSE or JSON),
 * `POST /v1/messages/count_tokens` and `GET /healthz`.
 *
 * Requests use the fixed synthetic credential. Logs hold counts, model IDs
 * and directive names only.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { digest, respond, STUB_KEY, type MessagesRequest, type Part } from './directives.js';

export const MAX_BODY_BYTES = 32 * 1024 ** 2;

export interface StubOptions {
  port: number;
  host?: string;
  log?: (line: Record<string, unknown>) => void;
  /** Test seam: waits for a hold; defaults to a timer that ends on disconnect. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface StubHandle {
  url: string;
  requests(): number;
  close(): Promise<void>;
}

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const tokens = (value: string) => Math.max(1, Math.ceil(Buffer.byteLength(value) / 4));

function anthropicError(res: http.ServerResponse, status: number, type: string, message: string) {
  res
    .writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ type: 'error', error: { type, message } }));
}

export async function startStub(options: StubOptions): Promise<StubHandle> {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const sleep = options.sleep ?? sleepFor;
  let count = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
        return;
      }
      if (req.headers['x-api-key'] !== STUB_KEY) {
        req.resume();
        anthropicError(res, 401, 'authentication_error', 'synthetic stub key required');
        return;
      }
      if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(url!)) {
        req.resume();
        anthropicError(res, 404, 'not_found_error', 'unsupported stub route');
        return;
      }
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
          anthropicError(res, 413, 'request_too_large', 'request too large');
          req.destroy();
          return;
        }
        parts.push(chunk as Buffer);
      }
      const raw = Buffer.concat(parts).toString('utf8');
      let body: MessagesRequest;
      try {
        body = JSON.parse(raw) as MessagesRequest;
        if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) throw new Error();
      } catch {
        anthropicError(res, 400, 'invalid_request_error', 'messages request expected');
        return;
      }
      const model = typeof body.model === 'string' ? body.model.slice(0, 100) : 'unknown';
      if (url === '/v1/messages/count_tokens') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ input_tokens: tokens(raw) }));
        return;
      }
      count += 1;
      const outcome = respond(body);
      log({ event: 'request', n: count, model, directives: outcome.directives });
      if (outcome.holdSeconds > 0) {
        const gone = new AbortController();
        res.on('close', () => gone.abort());
        await sleep(outcome.holdSeconds * 1000, gone.signal);
        if (gone.signal.aborted) return;
      }
      const id = `msg_stub_${digest(`${count}:${raw}`)}`;
      const usage = {
        input_tokens: tokens(raw),
        output_tokens: tokens(JSON.stringify(outcome.content)),
      };
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: outcome.content,
            stop_reason: outcome.stopReason,
            stop_sequence: null,
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const send = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', {
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
        },
      });
      outcome.content.forEach((part: Part, index) => {
        send('content_block_start', {
          index,
          content_block: part.type === 'text' ? { type: 'text', text: '' } : { ...part, input: {} },
        });
        send('content_block_delta', {
          index,
          delta:
            part.type === 'text'
              ? { type: 'text_delta', text: part.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(part.input) },
        });
        send('content_block_stop', { index });
      });
      send('message_delta', {
        delta: { stop_reason: outcome.stopReason, stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      });
      send('message_stop', {});
      res.end();
    })().catch(() => {
      if (!res.headersSent) anthropicError(res, 500, 'api_error', 'stub failure');
      else res.destroy();
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`,
    requests: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
