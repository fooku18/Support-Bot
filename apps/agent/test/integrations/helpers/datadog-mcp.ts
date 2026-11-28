/**
 * Deterministic fake Datadog remote MCP server behind an injected fetch:
 * JSON (non-SSE) Streamable HTTP answers for initialize, tools/list (with
 * pagination) and tools/call. Records every request with its headers.
 */
import type { DatadogFetch } from '../../../src/integrations/datadog/datadog-mcp-adapter.js';

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface SeenRequest {
  url: string;
  method: string;
  authorization: string | null;
  redirect: Parameters<DatadogFetch>[1]['redirect'];
  body: unknown;
}

export interface FakeDatadogOptions {
  tools?: FakeTool[];
  pageSize?: number;
  /** Answers a tools/call; a number is an HTTP status for the whole POST. */
  call?: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => unknown | number | Promise<unknown | number>;
  /** HTTP status for every POST (e.g. 401) when set. */
  status?: number;
  serverVersion?: string;
}

export const LOGS_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
  required: ['query'],
  additionalProperties: false,
};

export const DEFAULT_TOOLS: FakeTool[] = [
  { name: 'search_datadog_logs', description: 'Search logs.', inputSchema: LOGS_SCHEMA },
  {
    name: 'search_datadog_monitors',
    description: 'Search monitors.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_datadog_monitor',
    description: 'Create a monitor.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_datadog_dashboard',
    description: 'Delete a dashboard.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false },
  },
  {
    // Annotated read-only: kept even though the name looks like a write.
    name: 'start_datadog_query_preview',
    description: 'Preview a query.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

export function fakeDatadog(options: FakeDatadogOptions = {}) {
  const seen: SeenRequest[] = [];
  const tools = options.tools ?? DEFAULT_TOOLS;
  const pageSize = options.pageSize ?? 2;
  let sessions = 0;
  let expireNext = false;
  const active = new Set<string>();
  const fetchImpl: DatadogFetch = async (input, init) => {
    const headers = new Headers(init.headers);
    let body: unknown;
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    } catch {
      body = null;
    }
    seen.push({
      url: String(input),
      method: init.method ?? 'GET',
      authorization: headers.get('authorization'),
      redirect: init.redirect,
      body,
    });
    if (options.status !== undefined)
      return new Response('{"errors":["secret upstream detail"]}', { status: options.status });
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const message = body as { id?: number; method?: string; params?: Record<string, unknown> };
    if (message?.id === undefined) return new Response(null, { status: 202 });
    const session = headers.get('mcp-session-id');
    const reply = (result: unknown, extra: Record<string, string> = {}) =>
      Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: extra });
    if (message.method === 'initialize') {
      sessions += 1;
      const id = `session-${sessions}`;
      active.add(id);
      return reply(
        {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'datadog-mcp', version: options.serverVersion ?? '1.2.3' },
        },
        { 'mcp-session-id': id },
      );
    }
    if (!session || !active.has(session) || expireNext) {
      if (expireNext && session) active.delete(session);
      expireNext = false;
      return new Response('session not found', { status: 404 });
    }
    if (message.method === 'tools/list') {
      const start = Number((message.params?.cursor as string | undefined) ?? '0');
      const page = tools.slice(start, start + pageSize);
      const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
      return reply({ tools: page, ...(next ? { nextCursor: next } : {}) });
    }
    if (message.method === 'tools/call') {
      const name = String(message.params?.name);
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const answer = options.call
        ? await options.call(name, args, init.signal ?? undefined)
        : { content: [{ type: 'text', text: `${name} ok ${JSON.stringify(args)}` }] };
      if (typeof answer === 'number')
        return new Response('{"errors":["secret upstream detail"]}', { status: answer });
      return reply(answer);
    }
    return Response.json({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'method not found' },
    });
  };
  return {
    fetchImpl,
    seen,
    sessions: () => sessions,
    /** The next request with a session answers 404 (session expired). */
    expireSession: () => {
      expireNext = true;
    },
  };
}
