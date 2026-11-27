/**
 * Runtime-owned Datadog remote MCP client. Trusted code derives the only
 * endpoint (`https://mcp.<site>/v1/mcp`) from the deployment site, attaches
 * the bearer token (a Personal or Service Access Token with scope
 * `mcp_read`) only to that endpoint, refuses redirects and standing SSE
 * streams, bounds every response, and classifies failures. The model
 * supplies only a tool name from the pinned catalog and its arguments; it
 * never sees upstream URLs, headers or HTTP error bodies.
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { canonicalJson, datadogOutputValidator } from './datadog-schema.js';

export const DATADOG_ADAPTER = 'datadog-mcp-v1';
export const DATADOG_CONTRACT_VERSION = 'datadog-read-v1';
/** Upstream tool names this runner dispatches (Datadog uses snake_case and kebab-case). */
export const DATADOG_UPSTREAM_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
/** Commercial Datadog sites; gov sites are refused (the MCP server does not serve them). */
const DATADOG_SITE_PATTERN = /^(?:[a-z0-9]{2,8}\.)?datadoghq\.(?:com|eu)$/;
const TOOLSETS_PATTERN = /^(?:all|[a-z0-9-]{1,64}(?:,[a-z0-9-]{1,64}){0,31})$/;
/**
 * Name prefixes of mutating tools. A tool is excluded when it matches and
 * does not declare `readOnlyHint: true`; Datadog refuses writes under
 * `mcp_read` anyway, the exclusion only saves the model wasted turns.
 */
export const MUTATING_TOOL_PATTERN =
  /^(?:create|update|upsert|delete|edit|manage|sync|publish|clone|start|conclude|cancel|trigger|steer|enable|disable|mitigate|execute)_/;
/** Response bodies above this size fail with output_limit (the model output is capped separately). */
export const DATADOG_RESPONSE_MAX_BYTES = 4_000_000;
export const DATADOG_CLIENT_INFO = { name: 'support-agent-cli-runtime', version: '1.0.0' };

export function normalizeDatadogSite(site: string): string {
  if (/(?:^|\.)ddog-gov\.com$/.test(site))
    throw new Error('DATADOG_SITE: gov sites are not supported by the Datadog MCP server');
  if (!DATADOG_SITE_PATTERN.test(site))
    throw new Error('DATADOG_SITE must be a bare Datadog site such as datadoghq.eu');
  return site;
}
export function normalizeDatadogToolsets(value: string): string {
  if (!TOOLSETS_PATTERN.test(value))
    throw new Error('DATADOG_TOOLSETS must be "all" or a comma list of toolset names');
  return value;
}
/** The fixed MCP endpoint of a site (no query: toolsets travel separately). */
export function datadogEndpoint(site: string): string {
  return `https://mcp.${normalizeDatadogSite(site)}/v1/mcp`;
}
export function datadogRequestUrl(site: string, toolsets: string): URL {
  const url = new URL(datadogEndpoint(site));
  url.searchParams.set('toolsets', normalizeDatadogToolsets(toolsets));
  return url;
}

export type DatadogErrorCategory =
  | 'invalid_auth'
  | 'forbidden_scope'
  | 'rate_limit'
  | 'timeout'
  | 'invalid_shape'
  | 'upstream_error'
  | 'tool_error'
  | 'redirect_refused'
  | 'output_limit'
  | 'network'
  | 'session_lost';

/** Fixed model-facing sentences; raw upstream HTTP bodies are never returned. */
export const DATADOG_ERROR_TEXT: Record<DatadogErrorCategory, string> = {
  invalid_auth: 'Datadog rejected the bot token (wrong, expired or revoked).',
  forbidden_scope:
    'Datadog refused the call: the bot token is read-only (scope mcp_read) or its owner lacks the permission.',
  rate_limit: 'Datadog rate limit reached; do not retry now.',
  timeout: 'The Datadog request timed out; narrow the time range or the query.',
  invalid_shape: 'Datadog returned an unexpected response shape.',
  upstream_error: 'Datadog returned a server error.',
  tool_error: 'The Datadog tool reported an error.',
  redirect_refused: 'Datadog answered with a redirect, which the bot does not follow.',
  output_limit:
    'The Datadog response exceeded the size limit; narrow the query or lower the limit.',
  network: 'Datadog could not be reached.',
  session_lost: 'The Datadog MCP session expired.',
};

/** Classified transport failure raised by the guarded fetch (never carries a body). */
export class DatadogTransportError extends Error {
  constructor(
    readonly category: DatadogErrorCategory,
    readonly httpStatus: number | null = null,
  ) {
    super(`datadog transport: ${category}`);
    this.name = 'DatadogTransportError';
  }
}

export function classifyDatadogHttp(status: number): DatadogErrorCategory | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return 'redirect_refused';
  if (status === 401) return 'invalid_auth';
  if (status === 403) return 'forbidden_scope';
  if (status === 404) return 'session_lost';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'invalid_shape';
  return 'upstream_error';
}

/** Classifies a JSON-RPC or MCP error text. */
export function classifyDatadogText(text: string): DatadogErrorCategory | null {
  if (/rate.?limit|too many requests|\b429\b|quota/i.test(text)) return 'rate_limit';
  if (/unauthori[sz]ed|\b401\b|invalid (?:api )?(?:token|key)|expired token/i.test(text))
    return 'invalid_auth';
  if (
    /forbidden|\b403\b|permission|scope|not allowed|read-?only|request blocked|requires (?:all|and|or|at least one) of/i.test(
      text,
    )
  )
    return 'forbidden_scope';
  return null;
}

function classifyDatadogToolRefusal(text: string): DatadogErrorCategory | null {
  if (/^\s*(?:rate limit exceeded|too many requests)\b/i.test(text)) return 'rate_limit';
  if (/^\s*unauthori[sz]ed\b/i.test(text)) return 'invalid_auth';
  if (
    /^\s*forbidden\b|\bmissing scope \w+|\bMCP request blocked\b|requires (?:all|and|or|at least one) of:?\s*\[/i.test(
      text,
    )
  )
    return 'forbidden_scope';
  return null;
}

/**
 * The Datadog permissions a refusal names (e.g. `[logs_read_data,
 * logs_read_index_data]`), as a fixed-format hint; never free upstream text.
 */
export function datadogPermissionHint(text: string): string {
  const list = /requires (?:all|and|or|at least one) of:?\s*\[([a-z0-9_, ]{1,400})\]/i.exec(
    text,
  )?.[1];
  if (list) {
    const names = list
      .split(/[,\s]+/)
      .filter(Boolean)
      .slice(0, 12);
    // A write permission in the list means the call is a write: the token
    // stays read-only, so never suggest adding scopes for it.
    if (names.some((name) => /(^|_)write$/.test(name)))
      return ' Datadog requires a write permission for this call; the bot is read-only by design.';
    return ` Missing Datadog permission(s) on the token: ${names.join(', ')} (the token needs these read scopes in addition to mcp_read; see docs/datadog.md).`;
  }
  if (/request blocked/i.test(text))
    return ' Datadog blocked this MCP tool for the organisation or token.';
  return '';
}

/** Message text of a thrown MCP error, for classification and permission hints only. */
function errorText(err: unknown): string {
  return err instanceof McpError ? err.message : '';
}

export type DatadogFetch = (input: URL, init: RequestInit) => Promise<Response>;

function capBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          controller.error(new DatadogTransportError('output_limit'));
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * The only fetch the MCP transport may use: the endpoint's exact origin and
 * path, the bearer token attached here and nowhere else, no redirects, no
 * standing GET stream (answered locally with 405, which the transport
 * treats as "no server stream"), and a byte cap on every response body.
 */
export function guardedDatadogFetch(
  endpoint: string,
  token: string,
  options: { maxBytes?: number; fetchImpl?: DatadogFetch } = {},
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const pinned = new URL(endpoint);
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const maxBytes = options.maxBytes ?? DATADOG_RESPONSE_MAX_BYTES;
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (
      url.protocol !== 'https:' ||
      url.origin !== pinned.origin ||
      url.pathname !== pinned.pathname ||
      url.username ||
      url.password
    )
      throw new Error('Datadog request outside the pinned MCP endpoint');
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') return new Response(null, { status: 405 });
    if (method !== 'POST' && method !== 'DELETE')
      throw new Error('Datadog request method outside the MCP transport');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await doFetch(url, { ...init, headers, redirect: 'manual' });
    } catch (err) {
      if (err instanceof DatadogTransportError) throw err;
      throw new DatadogTransportError(init.signal?.aborted ? 'timeout' : 'network');
    }
    if (response.status === 0 || response.type === 'opaqueredirect')
      throw new DatadogTransportError('redirect_refused');
    const category = classifyDatadogHttp(response.status);
    // A session-less DELETE may answer 404/405; neither is a call failure.
    if (method === 'DELETE' && category !== null) return new Response(null, { status: 405 });
    if (category !== null) {
      await response.body?.cancel().catch(() => {});
      throw new DatadogTransportError(category, response.status);
    }
    if (!response.body) return response;
    return new Response(capBody(response.body, maxBytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Maps anything the MCP client throws to a category (never its message). */
export function classifyDatadogError(err: unknown, signal?: AbortSignal): DatadogErrorCategory {
  let cause: unknown = err;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    if (cause instanceof DatadogTransportError) return cause.category;
    cause = (cause as { cause?: unknown }).cause;
  }
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return 'timeout';
    if (err.code === ErrorCode.ConnectionClosed) return 'session_lost';
    return classifyDatadogText(err.message) ?? 'upstream_error';
  }
  if (err instanceof StreamableHTTPError)
    return typeof err.code === 'number' && err.code > 0
      ? (classifyDatadogHttp(err.code) ?? 'invalid_shape')
      : 'invalid_shape';
  if (signal?.aborted) return 'timeout';
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
    return 'timeout';
  if (err instanceof Error && /output_limit/.test(err.message)) return 'output_limit';
  return 'upstream_error';
}

// --- Catalog --------------------------------------------------------------------

/** One upstream tool as pinned by readiness (schema served to the runner). */
export interface DatadogCatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface DatadogCatalog {
  tools: DatadogCatalogTool[];
  /** Upstream names filtered out as mutating or unregistrable. */
  excludedTools: string[];
}

const MAX_DESCRIPTION_CHARS = 2000;
const MAX_SCHEMA_BYTES = 32_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Splits a raw `tools/list` result into the registrable read catalog and
 * the excluded names. Unregistrable entries (bad name, non-object or
 * oversized schema) are excluded, never passed through.
 */
export function partitionDatadogCatalog(rawTools: readonly unknown[]): DatadogCatalog {
  const tools: DatadogCatalogTool[] = [];
  const excluded = new Set<string>();
  const seen = new Set<string>();
  for (const raw of rawTools) {
    const tool = record(raw);
    const name = typeof tool?.name === 'string' ? tool.name : '';
    const label = name.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '?') || '(unnamed)';
    const schema = record(tool?.inputSchema);
    const readOnly = record(tool?.annotations)?.readOnlyHint === true;
    if (
      !DATADOG_UPSTREAM_NAME_PATTERN.test(name) ||
      seen.has(name) ||
      !schema ||
      schema.type !== 'object' ||
      Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES ||
      (!readOnly && MUTATING_TOOL_PATTERN.test(name))
    ) {
      excluded.add(label);
      continue;
    }
    seen.add(name);
    const description = typeof tool?.description === 'string' ? tool.description : '';
    tools.push({
      name,
      description: description.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS),
      inputSchema: schema,
    });
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tools, excludedTools: [...excluded].sort() };
}

/** Stable hash of the pinned catalog: names, descriptions, schemas and exclusions. */
export function datadogCatalogHash(catalog: DatadogCatalog): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(catalog)))
    .digest('hex')
    .slice(0, 32);
}

// --- Session ----------------------------------------------------------------------

export interface DatadogServerInfo {
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
}

export interface DatadogCallResult {
  status: 'completed' | 'failed' | 'timed_out' | 'not_run';
  output: string;
  errorCategory?: DatadogErrorCategory;
  truncated?: boolean;
  /** Bytes of the model-facing output. */
  bytes?: number;
  refused?: string;
}

const MAX_LIST_PAGES = 20;
const MAX_TOOLS = 1000;

/** Bounds the model-facing text; truncation is always marked. */
export function boundDatadogOutput(
  text: string,
  maxOutputBytes: number,
): { output: string; truncated: boolean } {
  const marker = '\n[truncated: Datadog result exceeded the output limit]';
  const bound = Math.max(256, maxOutputBytes);
  if (Buffer.byteLength(text) <= bound) return { output: text, truncated: false };
  let out = Buffer.from(text)
    .subarray(0, bound - Buffer.byteLength(marker))
    .toString('utf8');
  while (Buffer.byteLength(out) + Buffer.byteLength(marker) > bound) out = out.slice(0, -1);
  return { output: `${out}${marker}`, truncated: true };
}

/** Renders an MCP tool result as text (non-text items are named, never inlined). */
export function renderDatadogContent(result: unknown): string | null {
  const root = record(result);
  if (!root) return null;
  const parts: string[] = [];
  if (Array.isArray(root.content)) {
    for (const item of root.content) {
      const entry = record(item);
      if (entry?.type === 'text' && typeof entry.text === 'string') parts.push(entry.text);
      else if (typeof entry?.type === 'string')
        parts.push(`[non-text content omitted: ${entry.type.slice(0, 32)}]`);
    }
  }
  if (parts.length === 0 && root.structuredContent !== undefined)
    parts.push(JSON.stringify(root.structuredContent));
  if (parts.length === 0 && !Array.isArray(root.content)) return null;
  return parts.join('\n');
}

/**
 * One long-lived MCP session per runtime process. Re-initialised lazily
 * after session loss, 401/403, or a transport failure; a lost session is
 * retried once for reads (idempotent), never on 429.
 */
export class DatadogMcpSession {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  info: DatadogServerInfo = { protocolVersion: null, serverName: null, serverVersion: null };

  constructor(
    private readonly options: {
      site: string;
      toolsets: string;
      token: string;
      fetchImpl?: DatadogFetch;
      maxBytes?: number;
    },
  ) {}

  private async connect(timeoutMs: number): Promise<Client> {
    const url = datadogRequestUrl(this.options.site, this.options.toolsets);
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: guardedDatadogFetch(datadogEndpoint(this.options.site), this.options.token, {
        fetchImpl: this.options.fetchImpl,
        maxBytes: this.options.maxBytes,
      }),
      reconnectionOptions: {
        maxReconnectionDelay: 1_000,
        initialReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
    const client = new Client(DATADOG_CLIENT_INFO, {
      capabilities: {},
      jsonSchemaValidator: datadogOutputValidator,
    });
    client.onerror = () => {};
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    const version = client.getServerVersion();
    this.info = {
      protocolVersion:
        (transport as unknown as { protocolVersion?: string }).protocolVersion ?? null,
      serverName: typeof version?.name === 'string' ? version.name.slice(0, 120) : null,
      serverVersion: typeof version?.version === 'string' ? version.version.slice(0, 64) : null,
    };
    return client;
  }

  private async session(timeoutMs: number): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect(timeoutMs)
      .then((client) => (this.client = client))
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  /** Drops the session; the next call re-initialises. */
  async reset(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }

  /** `initialize` (when needed) plus the paginated `tools/list`. */
  async listTools(timeoutMs: number): Promise<unknown[]> {
    const run = async (): Promise<unknown[]> => {
      const client = await this.session(timeoutMs);
      const tools: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: timeoutMs,
        });
        tools.push(...result.tools);
        if (tools.length > MAX_TOOLS) throw new DatadogTransportError('output_limit');
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
        if (!cursor) return tools;
      }
      throw new DatadogTransportError('invalid_shape');
    };
    try {
      return await run();
    } catch (err) {
      await this.reset();
      if (classifyDatadogError(err) !== 'session_lost') throw err;
      return run();
    }
  }

  /** One bounded `tools/call`; failures come back classified, never thrown. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    bounds: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<DatadogCallResult> {
    const timeout = AbortSignal.timeout(bounds.timeoutMs);
    const signal = bounds.signal ? AbortSignal.any([bounds.signal, timeout]) : timeout;
    const attempt = async (): Promise<unknown> => {
      const client = await this.session(bounds.timeoutMs);
      return client.callTool({ name, arguments: args }, undefined, {
        timeout: bounds.timeoutMs,
        signal,
      });
    };
    let result: unknown;
    try {
      try {
        result = await attempt();
      } catch (err) {
        const category = classifyDatadogError(err, signal);
        if (category !== 'session_lost' || signal.aborted) throw err;
        await this.reset();
        result = await attempt();
      }
    } catch (err) {
      const category = classifyDatadogError(err, signal);
      if (
        category !== 'rate_limit' &&
        category !== 'timeout' &&
        category !== 'tool_error' &&
        // A JSON-RPC refusal (e.g. a missing permission) keeps the session.
        !(err instanceof McpError && category !== 'session_lost')
      )
        await this.reset();
      return datadogFailure(name, category, datadogPermissionHint(errorText(err)));
    }
    const text = renderDatadogContent(result);
    if (text === null) return datadogFailure(name, 'invalid_shape');
    if (record(result)?.isError === true) {
      const category = classifyDatadogToolRefusal(text) ?? 'tool_error';
      if (category !== 'tool_error')
        return datadogFailure(name, category, datadogPermissionHint(text));
      // The tool's own error text (e.g. a query syntax problem) helps the
      // model correct its call; it is bounded and labelled like any result.
      const bounded = boundDatadogOutput(
        `${name}: tool_error: ${DATADOG_ERROR_TEXT.tool_error}\n${text}`,
        Math.min(bounds.maxOutputBytes, 4_000),
      );
      return {
        status: 'failed',
        errorCategory: 'tool_error',
        output: bounded.output,
        truncated: bounded.truncated,
        bytes: Buffer.byteLength(bounded.output),
      };
    }
    const bounded = boundDatadogOutput(text, bounds.maxOutputBytes);
    return {
      status: 'completed',
      output: bounded.output,
      truncated: bounded.truncated,
      bytes: Buffer.byteLength(bounded.output),
    };
  }
}

export function datadogFailure(
  name: string,
  category: DatadogErrorCategory,
  hint = '',
): DatadogCallResult {
  const output = `${name}: ${category}: ${DATADOG_ERROR_TEXT[category]}${hint}`;
  return {
    status: category === 'timeout' ? 'timed_out' : 'failed',
    errorCategory: category,
    output,
    bytes: Buffer.byteLength(output),
  };
}
