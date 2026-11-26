/** Typed clients for the credential-owning service. No tool loop or action journal. */
import type { ToolFailureClass } from '../../contracts/protocol.js';
import { isGitlabWriteOperation, type ValidatedGitlabArgs } from '../gitlab/gitlab-operations.js';
import type { GitlabTextMeta } from '../gitlab/gitlab-rest-adapter.js';
import type { AtlassianResult } from '../atlassian/atlassian-rest-adapter.js';
import type {
  AtlassianBinding,
  CloudflareQualification,
  DatadogQualification,
  SlackBinding,
} from './tool-runtime-readiness.js';
import type { DatadogCallResult, DatadogCatalogTool } from '../datadog/datadog-mcp-adapter.js';
import type {
  CloudflareCallResult,
  CloudflareOperation,
  ValidatedCloudflareGet,
} from '../cloudflare/cloudflare-api-adapter.js';
import type {
  SlackCallResult,
  SlackOperation,
  ValidatedSlackRequest,
} from '../slack/slack-api-adapter.js';
export class BrokerError extends Error {
  /** Tool trace class of the refusal: the broker's own refusals are `policy`. */
  readonly failureClass: ToolFailureClass;
  constructor(message: string, failureClass: ToolFailureClass = 'policy') {
    super(message);
    this.name = 'BrokerError';
    this.failureClass = failureClass;
  }
}

/**
 * The tool runtime answered, but not with a result: `status` is its HTTP
 * status (401/403 authentication, other non-2xx), or 200 with an invalid
 * body. Callers that must tell a refusal from an outcome after dispatch
 * (feedback issues) read `status`; everyone else sees a BrokerError.
 */
export class RuntimeAnswerError extends BrokerError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message, status >= 500 ? '5xx' : 'refused');
    this.name = 'RuntimeAnswerError';
  }
}

/** Execution-phase failure whose remote side effects may have happened. */
export class UncertainOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncertainOutcomeError';
  }
}

/**
 * The connection to the tool runtime failed before any response:
 * refused, reset or closed, as opposed to the transport deadline. A write
 * may still have reached the runtime, so the outcome stays uncertain.
 */
export class RuntimeConnectionError extends UncertainOutcomeError {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConnectionError';
  }
}

function assertAttemptActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrokerError('tool attempt canceled before dispatch');
}

export interface BrokerToolResult {
  ok: boolean;
  /** Bounded, sanitized output delivered to the model. */
  output: string;
  operationId: string;
  evidence?: string;
  /** Structured result for scripts (Code Mode), when the adapter has one. */
  data?: unknown;
  meta?: Record<string, unknown>;
}

/** The admin-managed instance a runtime request is for (never chosen by the model). */
export interface InstanceRef {
  instanceId: string;
  teamId: string;
}

/** Typed GitLab request dispatched to the credential-owning tool runtime. */
export interface GitlabTransportRequest extends InstanceRef {
  /** Native callers pin the admin credential revision across readiness and dispatch. */
  credentialVersion?: number;
  operation: string;
  operationArgs: ValidatedGitlabArgs;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface GitlabTransportResponse {
  status: 'completed' | 'failed' | 'timed_out' | 'not_run';
  /** Status of GitLab's answer; null when there was none. */
  httpStatus: number | null;
  /** GitLab's answer: the JSON payload (the retained text for a job trace). */
  output: string;
  /** Transport failure (fixed sentence, never upstream text). */
  error?: string;
  truncated: boolean;
  refused?: string;
  /** Retention report of a streamed text body (`get_job_trace` only). */
  textMeta?: GitlabTextMeta;
}

/** Typed Atlassian operation dispatched to the credential-owning tool runtime. */
export interface AtlassianTransportRequest extends InstanceRef {
  operation: string;
  operationArgs: unknown;
  /**
   * Trusted site/cloud-ID/credential binding the runtime must confirm before execution
   * (the runtime owns the credential; the runner never sends or knows it,
   * and the model never supplies the cloud ID).
   */
  binding?: AtlassianBinding;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type AtlassianTransportResponse = AtlassianResult;

/** Datadog MCP read dispatched to the credential-owning tool runtime. */
export interface DatadogTransportRequest extends InstanceRef {
  /** Upstream tool name from the pinned catalog. */
  tool: string;
  arguments: Record<string, unknown>;
  /** Trusted site/endpoint/catalog/credential binding the runtime must confirm. */
  binding: DatadogQualification['binding'];
  timeoutMs: number;
  maxOutputBytes: number;
}

export type DatadogTransportResponse = DatadogCallResult;

/** Cloudflare API read dispatched to the credential-owning tool runtime. */
export interface CloudflareTransportRequest extends InstanceRef {
  operation: CloudflareOperation;
  /** The validated tool arguments (the runtime validates them again). */
  request: ValidatedCloudflareGet | { query: string; variables: Record<string, unknown> };
  /** Trusted endpoint/account/zone-set/credential binding the runtime must confirm. */
  binding: CloudflareQualification['binding'];
  timeoutMs: number;
  maxOutputBytes: number;
}

export type CloudflareTransportResponse = CloudflareCallResult;

/** Slack user lookup or message search dispatched to the credential-owning tool runtime. */
export interface SlackTransportRequest extends InstanceRef {
  operation: SlackOperation;
  /** The validated tool arguments (the runtime validates them again). */
  arguments: ValidatedSlackRequest;
  /** Trusted endpoint/workspace/credential binding the runtime must confirm. */
  binding: SlackBinding;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Message search only: the triggering mention's action token (never journaled). */
  actionToken?: string;
}

export type SlackTransportResponse = SlackCallResult;

/** Methods bound by the application to current authorized service instances. */
export interface ServiceToolHandlers {
  webFetch(input: { url?: unknown; question?: unknown }): Promise<BrokerToolResult>;
  /** `output` is the rendered model text, header included (`renderGitlabResultText`). */
  gitlab(operation: unknown, args: unknown): Promise<BrokerToolResult>;
  atlassian(operation: unknown, args: unknown): Promise<BrokerToolResult>;
  datadogDescribe(input: { search?: string; names?: string[] }): Promise<BrokerToolResult>;
  datadog(tool: string, args: unknown): Promise<BrokerToolResult>;
  cloudflareGraphql(input: unknown): Promise<BrokerToolResult>;
  cloudflareGet(input: unknown): Promise<BrokerToolResult>;
  slackGetUser(input: unknown): Promise<BrokerToolResult>;
  slackLookupUserByEmail(input: unknown): Promise<BrokerToolResult>;
  slackSearchMessages(input: unknown): Promise<BrokerToolResult>;
  /** Reads one linked message and its thread through the Slack adapter. */
  slackReadMessage(input: { permalink?: unknown }): Promise<BrokerToolResult>;
}
/** One deadline covers headers and body, including the single admitted read retry. */
function runtimeExchange(timeoutMs: number, attemptSignal?: AbortSignal, gitlab = false) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = attemptSignal ? AbortSignal.any([attemptSignal, deadline]) : deadline;
  let dispatched = false;
  const check = () => {
    if (!signal.aborted) return;
    if (!dispatched) assertAttemptActive(attemptSignal);
    const message = attemptSignal?.aborted
      ? 'isolated tool runtime request canceled'
      : `the isolated tool runtime did not answer within ${timeoutMs / 1000} s`;
    // Aborting this HTTP exchange does not cancel an independently executing
    // credential-owning runtime or establish whether a GitLab write happened.
    if (gitlab && dispatched) throw new UncertainOutcomeError(`${message}; GitLab outcome unknown`);
    throw new BrokerError(message);
  };
  return {
    signal,
    check,
    start() {
      check();
      dispatched = true;
    },
  };
}

/** Body failures must not swallow cancellation or expose raw parser errors. */
async function runtimeBody(
  response: Response,
  exchange: ReturnType<typeof runtimeExchange>,
  format: 'json' | 'text',
): Promise<unknown> {
  try {
    exchange.check();
    const body: unknown = await (format === 'json' ? response.json() : response.text());
    exchange.check();
    return body;
  } catch {
    exchange.check();
    if (format === 'text') return '';
    throw new RuntimeAnswerError(
      'isolated tool runtime returned an invalid result',
      response.status,
    );
  }
}

/** The code of a failed fetch's cause (`ECONNRESET`, `UND_ERR_SOCKET`, ...), if any. */
function connectionCode(err: unknown): string {
  for (let cause: unknown = err, depth = 0; cause && depth < 4; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
    cause = (cause as { cause?: unknown }).cause;
  }
  return 'connection lost';
}

/**
 * Sends a typed GitLab request to the credential-owning tool runtime's
 * /gitlab route. The runtime holds the GitLab instance credential; the
 * controller sends none. `transportTimeoutMs` bounds the whole exchange
 * and must exceed the request's own execution deadline (`timeoutMs`). A
 * timed-out fetch is an UncertainOutcomeError, a connection that failed
 * before any response a RuntimeConnectionError (e.g. a pooled
 * keep-alive socket the runtime had already closed); a read is sent once
 * more on a fresh connection then, a write never is. `attemptSignal` cancels
 * headers and body; `beforeReadRetry` rechecks the broker's current authority.
 * Cancellation after dispatch leaves the remote outcome unknown. An answer
 * that is not a result is a RuntimeAnswerError.
 */
export async function gitlabViaRuntime(
  request: GitlabTransportRequest,
  runtimeUrl: string,
  runtimeToken: string,
  transportTimeoutMs: number,
  attemptSignal?: AbortSignal,
  beforeReadRetry?: () => Promise<void>,
): Promise<GitlabTransportResponse> {
  const exchange = runtimeExchange(transportTimeoutMs, attemptSignal, true);
  const send = () => {
    exchange.start();
    return fetch(new URL('/gitlab', runtimeUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: exchange.signal,
    });
  };
  const failure = (err: unknown): UncertainOutcomeError => {
    exchange.check();
    return new RuntimeConnectionError(
      `connection to the isolated tool runtime failed before a response (${connectionCode(err)}); GitLab outcome unknown`,
    );
  };
  let response: globalThis.Response;
  try {
    response = await send();
  } catch (err) {
    // A pre-dispatch refusal is not an uncertain external effect.
    if (err instanceof BrokerError) throw err;
    const first = failure(err);
    if (
      isGitlabWriteOperation(request.operation) ||
      ![
        'ECONNRESET',
        'ECONNREFUSED',
        'ECONNABORTED',
        'EPIPE',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ETIMEDOUT',
        'UND_ERR_SOCKET',
        'UND_ERR_CONNECT_TIMEOUT',
      ].includes(connectionCode(err))
    )
      throw first;
    exchange.check();
    await beforeReadRetry?.();
    exchange.check();
    try {
      response = await send();
    } catch (retryErr) {
      throw failure(retryErr);
    }
  }
  exchange.check();
  if (response.status === 401 || response.status === 403)
    throw new RuntimeAnswerError('isolated tool runtime rejected authentication', response.status);
  if (!response.ok) {
    const detail = (await runtimeBody(response, exchange, 'text')) as string;
    throw new RuntimeAnswerError(
      `isolated tool runtime returned HTTP ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ''}`,
      response.status,
    );
  }
  let parsed: Partial<GitlabTransportResponse>;
  try {
    parsed = (await runtimeBody(response, exchange, 'json')) as Partial<GitlabTransportResponse>;
  } catch {
    exchange.check();
    throw new RuntimeAnswerError('isolated tool runtime returned an invalid GitLab result', 200);
  }
  if (
    typeof parsed.output !== 'string' ||
    !['completed', 'failed', 'timed_out', 'not_run'].includes(String(parsed.status))
  ) {
    throw new RuntimeAnswerError('isolated tool runtime returned an invalid GitLab result', 200);
  }
  return {
    status: parsed.status as GitlabTransportResponse['status'],
    httpStatus: typeof parsed.httpStatus === 'number' ? parsed.httpStatus : null,
    output: parsed.output,
    error: typeof parsed.error === 'string' ? parsed.error.slice(0, 200) : undefined,
    truncated: parsed.truncated === true,
    refused: typeof parsed.refused === 'string' ? parsed.refused : undefined,
    textMeta: parseTextMeta(parsed.textMeta),
  };
}

/** A well-formed retention report, or undefined (the runner then refuses the trace). */
function parseTextMeta(value: unknown): GitlabTextMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const meta = value as Record<string, unknown>;
  const count = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (
    !count(meta.totalBytes) ||
    !count(meta.returnedBytes) ||
    meta.returnedBytes > meta.totalBytes ||
    (meta.part !== 'head' && meta.part !== 'tail') ||
    typeof meta.cut !== 'boolean'
  )
    return undefined;
  return {
    totalBytes: meta.totalBytes,
    returnedBytes: meta.returnedBytes,
    part: meta.part,
    cut: meta.cut,
  };
}

/**
 * Sends a typed Atlassian operation to the credential-owning tool runtime's
 * /atlassian route. The runtime holds the scoped read-only tokens and the
 * trusted site/cloud-ID binding; the controller sends neither credentials
 * nor model-selected tenants. No task files are transferred.
 */
export async function atlassianViaRuntime(
  request: AtlassianTransportRequest,
  runtimeUrl: string,
  runtimeToken: string,
  attemptSignal?: AbortSignal,
): Promise<AtlassianTransportResponse> {
  const exchange = runtimeExchange(Math.min(300_000, request.timeoutMs + 30_000), attemptSignal);
  exchange.check();
  let response: globalThis.Response;
  try {
    exchange.start();
    response = await fetch(new URL('/atlassian', runtimeUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: exchange.signal,
    });
  } catch {
    exchange.check();
    // Reads are idempotent GET-like operations; a transport failure is
    // failed, not uncertain (no write intent was recorded as uncertain here
    // because the Atlassian contract has no mutations).
    throw new BrokerError('isolated tool runtime request failed; Atlassian read unavailable');
  }
  exchange.check();
  if (response.status === 401 || response.status === 403)
    throw new BrokerError('isolated tool runtime rejected authentication');
  if (!response.ok) {
    const detail = (await runtimeBody(response, exchange, 'text')) as string;
    throw new BrokerError(
      `isolated tool runtime returned HTTP ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const parsed = (await runtimeBody(
    response,
    exchange,
    'json',
  )) as Partial<AtlassianTransportResponse>;
  if (
    typeof parsed.output !== 'string' ||
    !['completed', 'failed', 'timed_out', 'not_run'].includes(String(parsed.status))
  ) {
    throw new BrokerError('isolated tool runtime returned an invalid Atlassian result');
  }
  return {
    status: parsed.status as AtlassianTransportResponse['status'],
    output: parsed.output,
    errorCategory: parsed.errorCategory,
    truncated: parsed.truncated === true,
    refused: typeof parsed.refused === 'string' ? parsed.refused : undefined,
  };
}

/** Keyword search over the pinned catalog: name hits weigh more than description hits. */
export function searchDatadogCatalog<T extends { name: string; description: string }>(
  catalog: readonly T[],
  query: string,
  limit = 20,
): T[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
    .slice(0, 12);
  if (words.length === 0) return [];
  return catalog
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const description = entry.description.toLowerCase();
      const score = words.reduce(
        (sum, word) => sum + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0),
        0,
      );
      return { entry, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.name < b.entry.name ? -1 : 1))
    .slice(0, limit)
    .map((hit) => hit.entry);
}

/** Describe only the verified entries needed for this model step. */
export function describeDatadogCatalog(
  catalog: readonly DatadogCatalogTool[],
  { names, search }: { names?: string[]; search?: string },
): BrokerToolResult {
  const operationId = 'native-read-catalog';
  if (names?.length && !search) {
    const entries = [...new Set(names)].map((name) => catalog.find((entry) => entry.name === name));
    if (entries.includes(undefined))
      return {
        ok: false,
        operationId,
        output: 'Unknown Datadog tool. Search for available names.',
      };
    const output = JSON.stringify(entries);
    if (Buffer.byteLength(output) > 48_000)
      return { ok: false, operationId, output: 'Request fewer Datadog schemas at a time.' };
    return { ok: true, operationId, output };
  }
  if (!names && search?.trim()) {
    const matches = searchDatadogCatalog(catalog, search).map(({ name, description }) => ({
      name,
      description: description.slice(0, 160),
    }));
    return { ok: true, operationId, output: JSON.stringify(matches) };
  }
  return { ok: false, operationId, output: 'Pass search keywords or a list of tool names.' };
}

/**
 * Sends one Datadog read to the credential-owning tool runtime's /datadog
 * route. The runtime holds the read-only token and re-checks the binding and
 * the arguments; the controller sends neither credentials nor endpoints.
 */
export async function datadogViaRuntime(
  request: DatadogTransportRequest,
  runtimeUrl: string,
  runtimeToken: string,
  attemptSignal?: AbortSignal,
): Promise<DatadogTransportResponse> {
  const exchange = runtimeExchange(Math.min(300_000, request.timeoutMs + 30_000), attemptSignal);
  exchange.check();
  let response: globalThis.Response;
  try {
    exchange.start();
    response = await fetch(new URL('/datadog', runtimeUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: exchange.signal,
    });
  } catch {
    exchange.check();
    // Datadog access is read-only (scope mcp_read): a lost answer is failed, not uncertain.
    throw new BrokerError('isolated tool runtime request failed; Datadog read unavailable');
  }
  exchange.check();
  if (response.status === 401 || response.status === 403)
    throw new BrokerError('isolated tool runtime rejected authentication');
  if (!response.ok) {
    const detail = (await runtimeBody(response, exchange, 'text')) as string;
    throw new BrokerError(
      `isolated tool runtime returned HTTP ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const parsed = (await runtimeBody(
    response,
    exchange,
    'json',
  )) as Partial<DatadogTransportResponse>;
  if (
    typeof parsed.output !== 'string' ||
    !['completed', 'failed', 'timed_out', 'not_run'].includes(String(parsed.status))
  ) {
    throw new BrokerError('isolated tool runtime returned an invalid Datadog result');
  }
  return {
    status: parsed.status as DatadogTransportResponse['status'],
    output: parsed.output,
    errorCategory: parsed.errorCategory,
    truncated: parsed.truncated === true,
    bytes: typeof parsed.bytes === 'number' ? parsed.bytes : undefined,
    refused: typeof parsed.refused === 'string' ? parsed.refused : undefined,
  };
}

/**
 * Sends one Cloudflare read to the credential-owning tool runtime's
 * /cloudflare route. The runtime holds the read-only token and re-checks the
 * binding and the request; the controller sends neither credentials nor
 * endpoints.
 */
export async function cloudflareViaRuntime(
  request: CloudflareTransportRequest,
  runtimeUrl: string,
  runtimeToken: string,
  attemptSignal?: AbortSignal,
): Promise<CloudflareTransportResponse> {
  const exchange = runtimeExchange(Math.min(300_000, request.timeoutMs + 30_000), attemptSignal);
  exchange.check();
  let response: globalThis.Response;
  try {
    exchange.start();
    response = await fetch(new URL('/cloudflare', runtimeUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: exchange.signal,
    });
  } catch {
    exchange.check();
    // Cloudflare access is read-only: a lost answer is failed, not uncertain.
    throw new BrokerError('isolated tool runtime request failed; Cloudflare read unavailable');
  }
  exchange.check();
  if (response.status === 401 || response.status === 403)
    throw new BrokerError('isolated tool runtime rejected authentication');
  if (!response.ok) {
    const detail = (await runtimeBody(response, exchange, 'text')) as string;
    throw new BrokerError(
      `isolated tool runtime returned HTTP ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const parsed = (await runtimeBody(
    response,
    exchange,
    'json',
  )) as Partial<CloudflareTransportResponse>;
  if (
    typeof parsed.output !== 'string' ||
    !['completed', 'failed', 'timed_out', 'not_run'].includes(String(parsed.status))
  ) {
    throw new BrokerError('isolated tool runtime returned an invalid Cloudflare result');
  }
  return {
    status: parsed.status as CloudflareTransportResponse['status'],
    output: parsed.output,
    errorCategory: parsed.errorCategory,
    truncated: parsed.truncated === true,
    bytes: typeof parsed.bytes === 'number' ? parsed.bytes : undefined,
    refused: typeof parsed.refused === 'string' ? parsed.refused : undefined,
  };
}

/**
 * Sends one Slack lookup or search to the credential-owning tool runtime's
 * /slack route. The runtime holds the workspace's bot token and re-checks
 * the binding and the arguments; the controller sends neither, only a
 * search's per-event action token.
 */
export async function slackViaRuntime(
  request: SlackTransportRequest,
  runtimeUrl: string,
  runtimeToken: string,
  attemptSignal?: AbortSignal,
): Promise<SlackTransportResponse> {
  const exchange = runtimeExchange(Math.min(300_000, request.timeoutMs + 30_000), attemptSignal);
  exchange.check();
  let response: globalThis.Response;
  try {
    exchange.start();
    response = await fetch(new URL('/slack', runtimeUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: exchange.signal,
    });
  } catch {
    exchange.check();
    // Slack lookups are read-only: a lost answer is failed, not uncertain.
    throw new BrokerError('isolated tool runtime request failed; Slack lookup unavailable');
  }
  exchange.check();
  if (response.status === 401 || response.status === 403)
    throw new BrokerError('isolated tool runtime rejected authentication');
  if (!response.ok) {
    const detail = (await runtimeBody(response, exchange, 'text')) as string;
    throw new BrokerError(
      `isolated tool runtime returned HTTP ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const parsed = (await runtimeBody(response, exchange, 'json')) as Partial<SlackTransportResponse>;
  if (
    typeof parsed.output !== 'string' ||
    !['completed', 'failed', 'timed_out', 'not_run'].includes(String(parsed.status))
  ) {
    throw new BrokerError('isolated tool runtime returned an invalid Slack result');
  }
  return {
    status: parsed.status as SlackTransportResponse['status'],
    output: parsed.output,
    errorCategory: parsed.errorCategory,
    truncated: parsed.truncated === true,
    bytes: typeof parsed.bytes === 'number' ? parsed.bytes : undefined,
    refused: typeof parsed.refused === 'string' ? parsed.refused : undefined,
    pages: typeof parsed.pages === 'number' ? parsed.pages : undefined,
    resultCount: typeof parsed.resultCount === 'number' ? parsed.resultCount : undefined,
    emptyHits: typeof parsed.emptyHits === 'number' ? parsed.emptyHits : undefined,
  };
}

/** Web fetch call forwarded to the isolated web runtime (the only internet path for page downloads). */
export type WebRuntimeRequest = {
  path: '/fetch';
  body: InstanceRef & { url: string; maxOutputBytes: number };
};

/** Bounded, already-shaped web runtime result. */
export interface WebRuntimeResult {
  output: string;
  evidence: string;
}

export async function webViaRuntime(
  request: WebRuntimeRequest,
  runtimeUrl: string,
  runtimeToken: string,
  timeoutMs: number,
  attemptSignal?: AbortSignal,
): Promise<WebRuntimeResult> {
  const exchange = runtimeExchange(Math.min(300_000, timeoutMs + 10_000), attemptSignal);
  exchange.check();
  let response: globalThis.Response;
  try {
    exchange.start();
    response = await fetch(new URL(request.path, runtimeUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: exchange.signal,
    });
  } catch {
    exchange.check();
    // Web reads are idempotent; a transport failure is failed, not uncertain.
    throw new BrokerError('isolated web runtime request failed; web call unavailable');
  }
  exchange.check();
  if (response.status === 401 || response.status === 403)
    throw new BrokerError('isolated web runtime rejected authentication');
  const parsed = (await runtimeBody(response, exchange, 'json').catch(() => {
    exchange.check();
    return {};
  })) as {
    output?: unknown;
    evidence?: unknown;
    error?: unknown;
  };
  if (!response.ok) {
    const detail = typeof parsed.error === 'string' ? parsed.error.slice(0, 200) : '';
    throw new BrokerError(
      `web runtime returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`,
    );
  }
  if (typeof parsed.output !== 'string')
    throw new BrokerError('isolated web runtime returned an invalid result');
  return {
    output: parsed.output,
    evidence: typeof parsed.evidence === 'string' ? parsed.evidence.slice(0, 200) : '',
  };
}
