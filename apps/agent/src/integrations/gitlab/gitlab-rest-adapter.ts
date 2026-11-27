/**
 * Requests, transport and result mapping for typed GitLab operations.
 *
 * Trusted code only: the credential-owning runtime builds the exact REST
 * request from the validated operation. Model input never contributes hosts,
 * methods, headers or endpoints beyond the validated resource/query
 * arguments, which are URL-encoded literals. Request bodies are JSON objects
 * built here.
 *
 * Backend: HTTPS requests under `/api/v4` of the instance host. No GraphQL,
 * no pagination-URL following (subsequent pages rebuild from validated
 * operation/page parameters).
 *
 * Every endpoint answers JSON except the job trace (`get_job_trace`), which
 * is plain text. Its request carries `responseKind: 'text'` and a `retain`
 * bound; the runtime streams the body and keeps only that bound (see
 * `MAX_TRACE_BYTES` / `MAX_TRACE_RAW_BYTES`).
 */

import {
  GITLAB_CONTRACT_VERSION,
  type GitlabTransportOperationName,
  type ValidatedGitlabArgs,
} from './gitlab-operations.js';

export const GITLAB_ADAPTER_VERSION = GITLAB_CONTRACT_VERSION;

/** Bytes of a job trace the model receives: the tail by default, the head on request. */
export const MAX_TRACE_BYTES = 48_000;
/** Hard cut: the runtime stops reading a trace at this many bytes and reports it as cut. */
export const MAX_TRACE_RAW_BYTES = 8 * 1024 * 1024;

/** Which part of a streamed text body the runtime keeps, and how much. */
export interface GitlabTextRetain {
  bytes: number;
  part: 'head' | 'tail';
}

/** What the runtime kept of a streamed text body (byte counts before redaction). */
export interface GitlabTextMeta {
  /** Bytes the runtime read (at most MAX_TRACE_RAW_BYTES + one chunk when cut). */
  totalBytes: number;
  /** Bytes of the trace in the retained text. */
  returnedBytes: number;
  part: 'head' | 'tail';
  /** The read stopped before EOF (hard byte cap or incomplete pipe drain). */
  cut: boolean;
}

export interface GitlabRequest {
  operation: GitlabTransportOperationName;
  method: 'GET' | 'POST' | 'PUT';
  /** API path relative to /api/v4 (encoded literals only). */
  endpoint: string;
  /** JSON body for writes (null for reads). */
  body: Record<string, unknown> | null;
  /** Human-readable resource identity for journals (no content). */
  resourceIdentity: string;
  /** Body format: JSON for every endpoint except the job trace. */
  responseKind: 'json' | 'text';
  /** Streaming retention bound for a text body (null for JSON). */
  retain: GitlabTextRetain | null;
}

function encodeProject(project: string): string {
  return encodeURIComponent(project);
}

type ListArgs = Extract<ValidatedGitlabArgs, { kind: 'list_merge_requests' | 'list_issues' }>;

/**
 * Base path and journal identity of a merge-request or issue list by scope:
 * `projects/<enc>/<collection>`, `groups/<enc>/<collection>` (subgroups
 * included by GitLab's default), or the instance-wide `<collection>`, which
 * needs `scope=all` because GitLab's default there is the token's own items.
 */
function listScope(
  validated: ListArgs,
  collection: 'merge_requests' | 'issues',
): { path: string; instanceScope: 'all' | undefined; resourceIdentity: string } {
  if (validated.project !== undefined) {
    return {
      path: `projects/${encodeProject(validated.project)}/${collection}`,
      instanceScope: undefined,
      resourceIdentity: `${collection}@${validated.project.slice(0, 120)}`,
    };
  }
  if (validated.group !== undefined) {
    return {
      path: `groups/${encodeProject(validated.group)}/${collection}`,
      instanceScope: undefined,
      resourceIdentity: `${collection}@group:${validated.group.slice(0, 120)}`,
    };
  }
  return { path: collection, instanceScope: 'all', resourceIdentity: `${collection}@instance` };
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * Builds the fixed REST request for one validated operation. The project is
 * a URL-encoded path segment (`group%2Fname` or a numeric ID); every other
 * model value is URL-encoded or placed in the JSON body.
 */
export function buildGitlabRequest(validated: ValidatedGitlabArgs): GitlabRequest {
  const get = (endpoint: string, resourceIdentity: string): GitlabRequest => ({
    operation: validated.kind,
    method: 'GET',
    endpoint,
    body: null,
    resourceIdentity,
    responseKind: 'json',
    retain: null,
  });
  const write = (
    method: 'POST' | 'PUT',
    endpoint: string,
    body: Record<string, unknown>,
    resourceIdentity: string,
  ): GitlabRequest => ({
    operation: validated.kind,
    method,
    endpoint,
    body,
    resourceIdentity,
    responseKind: 'json',
    retain: null,
  });
  if (validated.kind === 'get_current_user') return get('user', 'current user');
  if (validated.kind === 'list_projects') {
    return get(
      `projects${query({ membership: true, simple: true, order_by: 'last_activity_at', sort: 'desc', search: validated.search, page: validated.page, per_page: validated.per_page })}`,
      `projects${validated.search ? ` "${validated.search.slice(0, 80)}"` : ''}`,
    );
  }
  if (validated.kind === 'list_merge_requests') {
    const scope = listScope(validated, 'merge_requests');
    return get(
      `${scope.path}${query({
        scope: scope.instanceScope,
        state: validated.state === 'all' ? undefined : validated.state,
        search: validated.search,
        source_branch: validated.source_branch,
        target_branch: validated.target_branch,
        author_username: validated.author_username,
        assignee_username: validated.assignee_username,
        reviewer_username: validated.reviewer_username,
        labels: validated.labels?.join(','),
        milestone: validated.milestone,
        wip: validated.draft === undefined ? undefined : validated.draft ? 'yes' : 'no',
        created_after: validated.created_after,
        created_before: validated.created_before,
        updated_after: validated.updated_after,
        updated_before: validated.updated_before,
        merged_after: validated.merged_after,
        merged_before: validated.merged_before,
        order_by: validated.order_by,
        sort: validated.sort,
        page: validated.page,
        per_page: validated.per_page,
      })}`,
      scope.resourceIdentity,
    );
  }
  if (validated.kind === 'list_issues') {
    const scope = listScope(validated, 'issues');
    return get(
      `${scope.path}${query({
        scope: scope.instanceScope,
        state: validated.state === 'all' ? undefined : validated.state,
        search: validated.search,
        author_username: validated.author_username,
        assignee_username: validated.assignee_username,
        labels: validated.labels?.join(','),
        milestone: validated.milestone,
        created_after: validated.created_after,
        created_before: validated.created_before,
        updated_after: validated.updated_after,
        updated_before: validated.updated_before,
        order_by: validated.order_by,
        sort: validated.sort,
        page: validated.page,
        per_page: validated.per_page,
      })}`,
      scope.resourceIdentity,
    );
  }
  if (validated.kind === 'search' && validated.project === undefined) {
    return get(
      `search${query({ scope: validated.scope, search: validated.search, page: validated.page, per_page: validated.per_page })}`,
      `instance search ${validated.scope} "${validated.search.slice(0, 80)}"`,
    );
  }
  const project = validated.project as string;
  const base = `projects/${encodeProject(project)}`;
  const at = `@${project.slice(0, 120)}`;
  switch (validated.kind) {
    case 'get_project':
      return get(base, `project ${project.slice(0, 120)}`);
    case 'get_issue':
      return get(`${base}/issues/${validated.issue_iid}`, `issue #${validated.issue_iid}${at}`);
    case 'get_issue_notes':
      return get(
        `${base}/issues/${validated.issue_iid}/notes${query({ page: validated.page, per_page: validated.per_page, sort: 'asc', order_by: 'created_at' })}`,
        `issue #${validated.issue_iid} notes${at}`,
      );
    case 'search':
      return get(
        `${base}/search${query({ scope: validated.scope, search: validated.search, page: validated.page, per_page: validated.per_page })}`,
        `search ${validated.scope} "${validated.search.slice(0, 80)}"${at}`,
      );
    case 'list_branches':
      return get(
        `${base}/repository/branches${query({ search: validated.search, page: validated.page, per_page: validated.per_page })}`,
        `branches${at}`,
      );
    case 'get_merge_request':
      return get(
        `${base}/merge_requests/${validated.merge_request_iid}`,
        `merge_request !${validated.merge_request_iid}${at}`,
      );
    case 'get_merge_request_diffs':
      return get(
        `${base}/merge_requests/${validated.merge_request_iid}/diffs${query({ page: validated.page, per_page: validated.per_page })}`,
        `merge_request !${validated.merge_request_iid} diffs${at}`,
      );
    case 'get_merge_request_commits':
      return get(
        `${base}/merge_requests/${validated.merge_request_iid}/commits${query({ page: validated.page, per_page: validated.per_page })}`,
        `merge_request !${validated.merge_request_iid} commits${at}`,
      );
    case 'get_merge_request_notes':
      return get(
        `${base}/merge_requests/${validated.merge_request_iid}/notes${query({ page: validated.page, per_page: validated.per_page, sort: 'asc', order_by: 'created_at' })}`,
        `merge_request !${validated.merge_request_iid} notes${at}`,
      );
    case 'get_merge_request_pipelines':
      return get(
        `${base}/merge_requests/${validated.merge_request_iid}/pipelines${query({ page: validated.page, per_page: validated.per_page })}`,
        `merge_request !${validated.merge_request_iid} pipelines${at}`,
      );
    case 'list_pipelines':
      return get(
        `${base}/pipelines${query({ ref: validated.ref, status: validated.status, page: validated.page, per_page: validated.per_page })}`,
        `pipelines${at}`,
      );
    case 'get_pipeline':
      return get(
        `${base}/pipelines/${validated.pipeline_id}`,
        `pipeline ${validated.pipeline_id}${at}`,
      );
    case 'get_pipeline_jobs':
      return get(
        `${base}/pipelines/${validated.pipeline_id}/jobs${query({ page: validated.page, per_page: validated.per_page })}`,
        `pipeline ${validated.pipeline_id} jobs${at}`,
      );
    case 'get_job':
      return get(`${base}/jobs/${validated.job_id}`, `job ${validated.job_id}${at}`);
    case 'get_job_trace':
      return {
        ...get(`${base}/jobs/${validated.job_id}/trace`, `job ${validated.job_id} trace${at}`),
        responseKind: 'text',
        retain: { bytes: MAX_TRACE_BYTES, part: validated.head ? 'head' : 'tail' },
      };
    case 'list_repository_tree':
      return get(
        `${base}/repository/tree${query({ ref: validated.ref, path: validated.path, recursive: validated.recursive, page: validated.page, per_page: validated.per_page })}`,
        `tree ${validated.path ?? ''}@${validated.ref.slice(0, 40)}${at}`,
      );
    case 'get_repository_file': {
      // The file path is one URL-encoded path parameter (slashes as %2F).
      return get(
        `${base}/repository/files/${encodeURIComponent(validated.file_path)}${query({ ref: validated.ref })}`,
        `file ${validated.file_path.slice(0, 120)}@${validated.ref.slice(0, 40)}${at}`,
      );
    }
    case 'get_commit':
      return get(
        `${base}/repository/commits/${encodeURIComponent(validated.sha)}`,
        `commit ${validated.sha.slice(0, 12)}${at}`,
      );
    case 'list_commits':
      return get(
        `${base}/repository/commits${query({ ref_name: validated.ref, path: validated.path, since: validated.since, until: validated.until, page: validated.page, per_page: validated.per_page })}`,
        `commits${at}`,
      );
    case 'list_deployments':
      return get(
        `${base}/deployments${query({ environment: validated.environment, updated_after: validated.updated_after, updated_before: validated.updated_before, order_by: 'updated_at', sort: 'desc', page: validated.page, per_page: validated.per_page })}`,
        `deployments${at}`,
      );
    case 'create_merge_request_note':
      return write(
        'POST',
        `${base}/merge_requests/${validated.merge_request_iid}/notes`,
        { body: validated.body },
        `note on merge_request !${validated.merge_request_iid}${at}`,
      );
    case 'create_issue_note':
      return write(
        'POST',
        `${base}/issues/${validated.issue_iid}/notes`,
        { body: validated.body },
        `note on issue #${validated.issue_iid}${at}`,
      );
    case 'create_issue':
      return write(
        'POST',
        `${base}/issues`,
        {
          title: validated.title,
          ...(validated.description !== undefined ? { description: validated.description } : {}),
          ...(validated.labels !== undefined ? { labels: validated.labels.join(',') } : {}),
          ...(validated.assignee_ids !== undefined ? { assignee_ids: validated.assignee_ids } : {}),
          ...(validated.confidential !== undefined ? { confidential: validated.confidential } : {}),
        },
        `new issue${at}`,
      );
    case 'update_merge_request':
      return write(
        'PUT',
        `${base}/merge_requests/${validated.merge_request_iid}`,
        {
          ...(validated.title !== undefined ? { title: validated.title } : {}),
          ...(validated.description !== undefined ? { description: validated.description } : {}),
          ...(validated.labels !== undefined ? { labels: validated.labels.join(',') } : {}),
          ...(validated.assignee_ids !== undefined ? { assignee_ids: validated.assignee_ids } : {}),
          ...(validated.reviewer_ids !== undefined ? { reviewer_ids: validated.reviewer_ids } : {}),
          ...(validated.state_event !== undefined ? { state_event: validated.state_event } : {}),
        },
        `merge_request !${validated.merge_request_iid}${at}`,
      );
    case 'create_merge_request':
      return write(
        'POST',
        `${base}/merge_requests`,
        {
          source_branch: validated.source_branch,
          target_branch: validated.target_branch,
          title: validated.title,
          remove_source_branch: false,
          ...(validated.description !== undefined ? { description: validated.description } : {}),
          ...(validated.labels !== undefined ? { labels: validated.labels.join(',') } : {}),
        },
        `new merge_request ${validated.source_branch.slice(0, 80)} -> ${validated.target_branch.slice(0, 80)}${at}`,
      );
    case 'retry_job':
      return write(
        'POST',
        `${base}/jobs/${validated.job_id}/retry`,
        {},
        `retry job ${validated.job_id}${at}`,
      );
    case 'create_pipeline':
      return write(
        'POST',
        `${base}/pipeline${query({ ref: validated.ref })}`,
        {},
        `new pipeline @${validated.ref.slice(0, 80)}${at}`,
      );
    default:
      throw new Error('unsupported GitLab operation mapping');
  }
}

// --- Transport --------------------------------------------------------------------

export type GitlabFetch = (input: URL, init: RequestInit) => Promise<Response>;

const GITLAB_BASE_PATH = '/api/v4/';
/** Bytes kept of an error answer (for its message and the failure excerpt). */
const MAX_ERROR_BODY_BYTES = 16_384;
/** GitLab redirects reads of a renamed or transferred project to its new path. */
const MAX_REDIRECTS = 3;

/** Outcome of one GitLab request (not yet redacted; the runtime does that). */
export interface GitlabHttpResult {
  /** `completed`: a 2xx answer, read to its end or to its bound. */
  status: 'completed' | 'failed' | 'timed_out';
  /** Status of GitLab's answer; null when there was none. */
  httpStatus: number | null;
  /** The answer's body, bounded (the retained text for a job trace). */
  output: string;
  truncated: boolean;
  /** Fixed sentence of a transport failure (never upstream text). */
  error?: string;
  /** Retention report of a streamed text body (`get_job_trace` only). */
  textMeta?: GitlabTextMeta;
}

/**
 * The pinned URL of one request. Refuses anything URL parsing would move off
 * the instance's `/api/v4` or normalize to another path (e.g. `..`).
 */
export function gitlabUrl(host: string, endpoint: string): URL {
  const url = URL.parse(`https://${host}${GITLAB_BASE_PATH}${endpoint}`);
  if (
    url === null ||
    url.host !== host.toLowerCase() ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `${GITLAB_BASE_PATH}${endpoint.split('?', 1)[0]}`
  )
    throw new Error('GitLab request outside the pinned API surface');
  return url;
}

/** Target of a redirect that stays on the same origin's API, or null. */
function redirectTarget(response: Response, from: URL): URL | null {
  const location = response.headers.get('location');
  const url = location === null ? null : URL.parse(location, from);
  return url !== null &&
    url.origin === from.origin &&
    url.pathname.startsWith(GITLAB_BASE_PATH) &&
    !url.username &&
    !url.password &&
    !url.hash
    ? url
    : null;
}

/** Feeds the body to `push` until it returns false; the rest is discarded. */
async function readBody(response: Response, push: (chunk: Buffer) => boolean): Promise<void> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!push(Buffer.from(value))) {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Collects at most `limit` bytes of a body. */
function boundedCollector(limit: number): {
  push(chunk: Buffer): boolean;
  finish(): { output: string; truncated: boolean };
} {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  return {
    push(chunk) {
      const room = limit - total;
      truncated = chunk.length > room;
      chunks.push(chunk.subarray(0, room));
      total += Math.min(chunk.length, room);
      return !truncated;
    },
    finish: () => ({
      output: Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[output truncated]' : ''),
      truncated,
    }),
  };
}

/**
 * The only way a request reaches GitLab: HTTPS under `/api/v4` of the
 * instance host, the token attached here and nowhere else, the body capped.
 * Only a read follows a redirect, and only within that host's API. No retries.
 */
export async function sendGitlabRequest(
  request: GitlabRequest,
  host: string,
  token: string,
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    fetchImpl?: GitlabFetch;
  },
): Promise<GitlabHttpResult> {
  let url = gitlabUrl(host, request.endpoint);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const failed = (httpStatus: number | null, error: string): GitlabHttpResult => ({
    status: signal.aborted ? 'timed_out' : 'failed',
    httpStatus,
    output: '',
    truncated: false,
    error,
  });
  let response: Response;
  for (let redirects = 0; ; redirects += 1) {
    try {
      signal.throwIfAborted();
      response = await doFetch(url, {
        method: request.method,
        redirect: 'manual',
        signal,
        headers: {
          accept: request.responseKind === 'text' ? 'text/plain' : 'application/json',
          'private-token': token,
          ...(request.body !== null ? { 'content-type': 'application/json' } : {}),
        },
        ...(request.body !== null ? { body: JSON.stringify(request.body) } : {}),
      });
    } catch {
      return failed(null, 'GitLab could not be reached');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = redirectTarget(response, url);
    await response.body?.cancel().catch(() => {});
    if (request.method !== 'GET' || next === null || redirects === MAX_REDIRECTS)
      return failed(response.status, 'GitLab answered with a redirect that is not followed');
    url = next;
  }
  if (!response.ok) {
    const body = boundedCollector(Math.min(options.maxOutputBytes, MAX_ERROR_BODY_BYTES));
    try {
      await readBody(response, body.push);
    } catch {
      // The status alone classifies the failure.
    }
    return { status: 'failed', httpStatus: response.status, ...body.finish() };
  }
  const incomplete = 'GitLab closed the connection before the response was complete';
  if (request.retain !== null) {
    const retainer = createTextRetainer(request.retain);
    let complete = true;
    try {
      await readBody(response, (chunk) => retainer.push(chunk) === 'continue');
    } catch {
      complete = false;
    }
    const { text, meta } = retainer.finish();
    if (!complete) meta.cut = true;
    return {
      ...(complete
        ? { status: 'completed', httpStatus: response.status }
        : failed(response.status, incomplete)),
      output: text,
      truncated: meta.cut || meta.returnedBytes < meta.totalBytes,
      textMeta: meta,
    };
  }
  const body = boundedCollector(options.maxOutputBytes);
  try {
    await readBody(response, body.push);
  } catch {
    return {
      ...failed(response.status, incomplete),
      output: body.finish().output,
      truncated: true,
    };
  }
  return { status: 'completed', httpStatus: response.status, ...body.finish() };
}

/**
 * Streaming retention of a text body: counts every byte, keeps only the
 * first (`head`) or last (`tail`) `retain.bytes`, and reports `cut` once
 * the count passes `hardCut` (the caller then stops reading). When the
 * body was larger than the retained part, the partial line at the cut edge
 * is dropped, so no half token or broken UTF-8 sequence reaches redaction.
 */
export function createTextRetainer(
  retain: GitlabTextRetain,
  hardCut: number = MAX_TRACE_RAW_BYTES,
): {
  push(chunk: Buffer): 'continue' | 'cut';
  finish(): { text: string; meta: GitlabTextMeta };
} {
  const limit = Math.max(1, Math.floor(retain.bytes));
  let total = 0;
  let cut = false;
  let kept = Buffer.alloc(0);
  return {
    push(chunk) {
      if (cut) return 'cut';
      total += chunk.length;
      if (retain.part === 'head') {
        if (kept.length < limit) {
          kept = Buffer.concat([kept, chunk.subarray(0, limit - kept.length)]);
        }
      } else {
        kept = Buffer.concat([kept, chunk]);
        // Compact lazily so a stream of small chunks stays linear.
        if (kept.length > 2 * limit) kept = Buffer.from(kept.subarray(kept.length - limit - 1));
      }
      if (total > hardCut) cut = true;
      return cut ? 'cut' : 'continue';
    },
    finish() {
      let out = retain.part === 'tail' ? kept.subarray(Math.max(0, kept.length - limit)) : kept;
      if (out.length < total) {
        if (retain.part === 'tail') {
          // The byte before the window tells whether it starts at a line.
          const before = kept.length > out.length ? kept[kept.length - out.length - 1] : undefined;
          const newline = before === 0x0a ? -1 : out.indexOf(0x0a);
          if (before !== 0x0a)
            out = newline >= 0 ? out.subarray(newline + 1) : out.subarray(utf8Start(out));
        } else {
          const newline = out.lastIndexOf(0x0a);
          out = newline >= 0 ? out.subarray(0, newline + 1) : out.subarray(0, utf8End(out));
        }
      }
      return {
        text: out.toString('utf8'),
        meta: { totalBytes: total, returnedBytes: out.length, part: retain.part, cut },
      };
    },
  };
}

/** First index that does not continue a UTF-8 sequence. */
function utf8Start(buf: Buffer): number {
  let i = 0;
  while (i < buf.length && i < 4 && (buf[i]! & 0xc0) === 0x80) i += 1;
  return i;
}

/** End index that excludes a trailing incomplete UTF-8 sequence. */
function utf8End(buf: Buffer): number {
  for (let back = 1; back <= Math.min(4, buf.length); back += 1) {
    const byte = buf[buf.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return width > back ? buf.length - back : buf.length;
  }
  return buf.length;
}

// --- Result normalization ----------------------------------------------------

export type GitlabErrorCategory =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unsupported'
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'upstream'
  | 'invalid_response';

export interface GitlabNormalizedResult {
  ok: boolean;
  operation: GitlabTransportOperationName;
  project: string;
  /** Bounded normalized payload (already truncated with markers where needed). */
  data: unknown;
  pagination: { page?: number; per_page?: number; next_page?: number | null };
  truncated: boolean;
  warnings: string[];
  errorCategory?: GitlabErrorCategory;
  /** Short sanitized error for model delivery (no credentials). */
  error?: string;
  /**
   * Failed request only: a bounded, credential-scrubbed excerpt of GitLab's
   * answer, for the action evidence and the runner log.
   * Never part of the model text, Slack or the feedback trace.
   */
  detail?: string;
}

/** Bound of a failed request's excerpt. */
export const MAX_FAILURE_DETAIL = 500;

/**
 * The excerpt of a failed request: the reason then GitLab's answer,
 * whitespace collapsed, scrubbed of credential shapes (the tool runtime has
 * already removed its own secrets) and bounded.
 */
export function failureDetail(reason: string, output: string): string | undefined {
  const text = [reason, output]
    .map((part) =>
      part
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1[redacted]@')
        .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
        .replace(/(?:glpat|gldt|glptt|glrt|gloas|glcbt|glimt)-[A-Za-z0-9_-]{6,}/g, '[redacted]')
        .replace(/\b((?:private|job|deploy)-token\s*[:=]\s*)\S+/gi, '$1[redacted]')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((part) => part.length > 0)
    .join(' | ');
  if (text.length === 0) return undefined;
  return text.length > MAX_FAILURE_DETAIL ? `${text.slice(0, MAX_FAILURE_DETAIL - 1)}…` : text;
}

const MAX_MODEL_BYTES = 60_000;
const MAX_COLLECTION_ITEMS = 100;
const MAX_TEXT_FIELD = 12_000;
const MAX_PATCH_BYTES = 20_000;

function truncateText(value: string, limit = MAX_TEXT_FIELD): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, limit)}\n[…truncated ${value.length - limit} chars]`,
    truncated: true,
  };
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function truncateCollection(items: unknown[]): { items: unknown[]; truncated: boolean } {
  if (items.length <= MAX_COLLECTION_ITEMS) return { items, truncated: false };
  return { items: items.slice(0, MAX_COLLECTION_ITEMS), truncated: true };
}

/**
 * Normalizes one answer to a stable envelope with explicit truncation
 * markers. A 2xx answer with malformed or cut-off JSON is a failed result
 * (invalid_response), never an empty success.
 */
export function normalizeGitlabOutput(args: {
  operation: GitlabTransportOperationName;
  project: string;
  status: 'completed' | 'failed' | 'timed_out';
  httpStatus: number | null;
  output: string;
  /** Transport failure reported by the tool runtime. */
  error?: string;
  page?: number;
  per_page?: number;
  scope?: string;
  /** Retention report of a streamed text body (`get_job_trace` only). */
  textMeta?: GitlabTextMeta;
}): GitlabNormalizedResult {
  const base = {
    operation: args.operation,
    project: args.project,
    pagination: { page: args.page, per_page: args.per_page, next_page: null as number | null },
    truncated: false,
    warnings: [] as string[],
  };
  if (args.status === 'timed_out') {
    return {
      ...base,
      ok: false,
      data: null,
      errorCategory: 'timeout',
      error: 'GitLab request timed out',
    };
  }
  if (args.status === 'failed') {
    // A 2xx status does not imply a complete answer (e.g. the connection
    // dropped mid-body). Never normalize that failure as data.
    if (args.httpStatus !== null && args.httpStatus >= 200 && args.httpStatus < 300)
      return {
        ...base,
        ok: false,
        data: null,
        errorCategory: 'invalid_response',
        error: 'GitLab tool runtime failed to complete the response',
        ...(args.error === undefined ? {} : { detail: args.error.slice(0, 300) }),
      };
    const detail = failureDetail(
      args.error ?? (args.httpStatus === null ? '' : `HTTP ${args.httpStatus}`),
      args.output,
    );
    return {
      ...base,
      ok: false,
      data: null,
      ...classifyHttpFailure(args.httpStatus, args.output),
      ...(detail === undefined ? {} : { detail }),
    };
  }
  if (args.operation === 'get_job_trace') {
    if (args.textMeta === undefined) {
      return {
        ...base,
        ok: false,
        data: null,
        errorCategory: 'invalid_response',
        error: 'the tool runtime did not report the trace retention',
      };
    }
    const trace = normalizeTrace(args.output, args.textMeta);
    return {
      ...base,
      ok: true,
      data: trace.data,
      truncated: trace.data.truncated,
      warnings: [...base.warnings, ...trace.warnings],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.output);
  } catch {
    return {
      ...base,
      ok: false,
      data: null,
      errorCategory: 'invalid_response',
      error: 'GitLab returned malformed JSON',
    };
  }
  try {
    const normalized = normalizeOperationPayload(args.operation, parsed, args.scope);
    let serialized = JSON.stringify(normalized.data);
    let truncated = normalized.truncated;
    if (serialized.length > MAX_MODEL_BYTES) {
      serialized = JSON.stringify(
        `${serialized.slice(0, MAX_MODEL_BYTES)}\n[…output truncated at ${MAX_MODEL_BYTES} bytes]`,
      );
      truncated = true;
    }
    const warnings = [...base.warnings, ...normalized.warnings];
    if (truncated && !warnings.some((w) => w.includes('truncated'))) {
      warnings.push('output truncated to the model bound with explicit markers');
    }
    const rows = Array.isArray(parsed) ? parsed.length : 0;
    const nextPage =
      args.page !== undefined && args.per_page !== undefined && rows >= args.per_page
        ? args.page + 1
        : null;
    if (nextPage !== null) {
      warnings.push(
        `page ${args.page} is full (${rows} rows): more may exist; read page ${nextPage} before treating the list as complete`,
      );
    }
    return {
      ...base,
      ok: true,
      pagination: { ...base.pagination, next_page: nextPage },
      data: JSON.parse(serialized) as unknown,
      truncated,
      warnings,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      data: null,
      errorCategory: 'invalid_response',
      error: err instanceof Error ? err.message.slice(0, 200) : 'invalid response shape',
    };
  }
}

// --- Job trace (plain text) ----------------------------------------------------

export interface GitlabTraceData {
  text: string;
  total_bytes: number;
  returned_bytes: number;
  part: 'head' | 'tail';
  truncated: boolean;
}

// GitLab's collapsible-section markers: `section_start:<ts>:<name>[opts]\r\e[0K`.
const SECTION_MARKER =
  // eslint-disable-next-line no-control-regex -- the markers end in CR and an ANSI erase
  /section_(start|end):\d+:([A-Za-z0-9_.-]+)(?:\[[^\]\n]*\])?\r?(?:\x1b\[0?K)?/g;
// eslint-disable-next-line no-control-regex -- ANSI CSI, OSC and two-byte escapes
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex -- remaining control characters except tab/newline/CR
const TRACE_CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

/**
 * Readable trace text: section markers become `[section <name>]` /
 * `[end section <name>]`, ANSI escapes and stray control characters go, and
 * carriage-return overwrites (progress bars) keep only the last visible
 * state of each line.
 */
export function cleanTraceText(raw: string): string {
  const marked = raw.replace(SECTION_MARKER, (_match, kind: string, name: string) =>
    kind === 'start' ? `[section ${name}] ` : `[end section ${name}]\n`,
  );
  const plain = marked.replace(ANSI_ESCAPE, '').replace(TRACE_CONTROL, '');
  return plain
    .split(/\r?\n/)
    .map((line) => {
      if (!line.includes('\r')) return line;
      const states = line.split('\r').filter((state) => state.length > 0);
      return states.length > 0 ? states[states.length - 1]! : '';
    })
    .join('\n')
    .replace(/\[section ([^\]]+)\] \n/g, '[section $1]\n');
}

function normalizeTrace(
  output: string,
  meta: GitlabTextMeta,
): { data: GitlabTraceData; warnings: string[] } {
  let text = cleanTraceText(output);
  const warnings: string[] = [];
  // Cleanup only shortens; the serialized envelope must still fit the model
  // bound (JSON escapes can grow a line), so trim from the far end.
  const room = MAX_MODEL_BYTES - 1_000;
  while (Buffer.byteLength(JSON.stringify(text)) > room) {
    const excess = Buffer.byteLength(JSON.stringify(text)) - room;
    const drop = Math.max(256, Math.ceil(excess / 2));
    text = meta.part === 'tail' ? text.slice(drop) : text.slice(0, -drop);
  }
  const truncated = meta.cut || meta.returnedBytes < meta.totalBytes;
  if (truncated) {
    const bound = String(MAX_TRACE_BYTES).replace(/\B(?=(\d{3})+$)/g, ' ');
    const of = meta.cut ? `more than ${meta.totalBytes}` : `${meta.totalBytes}`;
    warnings.push(
      meta.part === 'tail'
        ? `trace bounded to the last ${bound} bytes of ${of}; call with head: true for the beginning`
        : `trace bounded to the first ${bound} bytes of ${of}; call without head for the end`,
    );
  }
  if (meta.cut) {
    warnings.push(
      `trace read stopped at the ${MAX_TRACE_RAW_BYTES}-byte hard cut; total_bytes counts what was read`,
    );
  }
  return {
    data: {
      text,
      total_bytes: meta.totalBytes,
      returned_bytes: meta.returnedBytes,
      part: meta.part,
      truncated,
    },
    warnings,
  };
}

const PROJECT_NOT_FOUND = 'GitLab project was not found (or is not visible to this token)';
const MAX_PROJECT_CANDIDATES = 5;

/**
 * Adds the reachable projects named like the last segment of a project path
 * GitLab did not find, so a path without its top-level group or a moved
 * project can be corrected in one step. One membership-scoped `list_projects`
 * read through `list`; the result is unchanged when that read fails.
 */
export async function hintProjectPaths(
  result: GitlabNormalizedResult,
  list: (validated: ValidatedGitlabArgs) => Promise<GitlabNormalizedResult>,
): Promise<GitlabNormalizedResult> {
  if (result.error !== PROJECT_NOT_FOUND || /^\d+$/.test(result.project)) return result;
  const name = result.project.split('/').at(-1)!;
  let found: GitlabNormalizedResult;
  try {
    found = await list({ kind: 'list_projects', search: name, page: 1, per_page: 100 });
  } catch {
    return result;
  }
  if (!found.ok || !Array.isArray(found.data)) return result;
  const wanted = result.project.toLowerCase();
  const paths = found.data
    .map((entry) => (entry as Record<string, unknown> | null)?.path_with_namespace)
    .filter(
      (path): path is string =>
        typeof path === 'string' && path.split('/').at(-1)!.toLowerCase() === name.toLowerCase(),
    );
  const suffix = (path: string) => Number(path.toLowerCase().endsWith(`/${wanted}`));
  paths.sort((a, b) => suffix(b) - suffix(a));
  const listed =
    paths.slice(0, MAX_PROJECT_CANDIDATES).join(', ') +
    (paths.length > MAX_PROJECT_CANDIDATES ? ', …' : '');
  const hint =
    paths.length > 0
      ? `Projects named "${name}" this token can reach: ${listed}. Use the full path, starting at the top-level group.`
      : found.data.length >= 100
        ? `More than 100 reachable projects match "${name}"; search list_projects with more of the path.`
        : `No project named "${name}" is visible to this token; list_projects shows the reachable ones.`;
  return { ...result, error: `${result.error}. ${hint}` };
}

function classifyHttpFailure(
  httpStatus: number | null,
  output: string,
): { errorCategory: GitlabErrorCategory; error: string } {
  if (httpStatus === null)
    return { errorCategory: 'upstream', error: 'GitLab could not be reached' };
  if (httpStatus === 401)
    return { errorCategory: 'authentication', error: 'GitLab authentication failed' };
  if (httpStatus === 403)
    return {
      errorCategory: 'forbidden',
      error: 'GitLab refused the request (forbidden for this token)',
    };
  if (httpStatus === 404)
    return {
      errorCategory: 'not_found',
      error: /"message"\s*:\s*"404 Project Not Found"/.test(output)
        ? PROJECT_NOT_FOUND
        : 'GitLab resource was not found (or is not visible to this token)',
    };
  const rejected = httpStatus === 400 || httpStatus === 422;
  if (httpStatus === 409 || (rejected && /already exists/i.test(output)))
    return {
      errorCategory: 'conflict',
      error: 'GitLab reported a conflict (resource already exists)',
    };
  if (rejected) {
    const detail = /"message"\s*:\s*("(?:[^"\\]|\\.)*"|\{[^}]*\}|\[[^\]]*\])/.exec(output);
    return {
      errorCategory: 'invalid_input',
      error: `GitLab rejected the request${detail ? `: ${detail[1]!.slice(0, 200)}` : ''}`,
    };
  }
  if (httpStatus === 429)
    return { errorCategory: 'rate_limit', error: 'GitLab rate limit reached; retry later' };
  if (httpStatus === 501)
    return {
      errorCategory: 'unsupported',
      error: 'GitLab does not support this operation/scope on this instance',
    };
  return {
    errorCategory: 'upstream',
    error: `GitLab ${httpStatus >= 500 ? 'upstream error' : 'request failed'} (HTTP ${httpStatus})`,
  };
}

function normalizeOperationPayload(
  operation: GitlabTransportOperationName,
  parsed: unknown,
  scope?: string,
): { data: unknown; truncated: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (Array.isArray(parsed)) {
    const { items, truncated } = truncateCollection(parsed);
    const data = items.map((entry) => boundEntry(operation, entry, scope));
    if (truncated)
      warnings.push(
        `collection truncated to ${MAX_COLLECTION_ITEMS} items with an explicit marker`,
      );
    return { data, truncated, warnings };
  }
  if (parsed !== null && typeof parsed === 'object') {
    return { data: boundEntry(operation, parsed, scope), truncated: false, warnings };
  }
  throw new Error('unexpected GitLab response shape');
}

const PROJECT_FIELDS = [
  'id',
  'path_with_namespace',
  'name',
  'default_branch',
  'web_url',
  'description',
  'visibility',
  'last_activity_at',
  'archived',
] as const;
const ISSUE_FIELDS = [
  'id',
  'iid',
  'project_id',
  'title',
  'description',
  'state',
  'labels',
  'web_url',
  'created_at',
  'updated_at',
  'author',
  'assignees',
  'assignees_truncated',
  'closed_at',
  'due_date',
  'milestone',
  'confidential',
  'user_notes_count',
] as const;
const MR_FIELDS = [
  'id',
  'iid',
  'project_id',
  'title',
  'description',
  'state',
  'source_branch',
  'target_branch',
  'sha',
  'web_url',
  'created_at',
  'updated_at',
  'labels',
  'draft',
  'author',
  'assignees',
  'assignees_truncated',
  'reviewers',
  'reviewers_truncated',
  'merged_at',
  'closed_at',
  'detailed_merge_status',
  'has_conflicts',
  'milestone',
  'user_notes_count',
] as const;
/** People fields are reduced to these keys; people arrays are capped. */
const PERSON_FIELDS = ['id', 'username', 'name'] as const;
const MAX_PEOPLE = 20;
const NOTE_FIELDS = ['id', 'body', 'author', 'system', 'created_at', 'updated_at', 'noteable_iid'];

function boundEntry(
  operation: GitlabTransportOperationName,
  entry: unknown,
  scope?: string,
): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const bounded: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  for (const field of ['description', 'body', 'message', 'data', 'diff', 'patch']) {
    if (typeof bounded[field] === 'string') {
      const limit = field === 'diff' || field === 'patch' ? MAX_PATCH_BYTES : MAX_TEXT_FIELD;
      const { text, truncated } = truncateText(bounded[field] as string, limit);
      bounded[field] = text;
      if (truncated) bounded[`${field}_truncated`] = true;
    }
  }
  if (typeof bounded.author === 'object' && bounded.author !== null) {
    bounded.author = pick(bounded.author as Record<string, unknown>, PERSON_FIELDS);
  }
  for (const field of ['assignees', 'reviewers']) {
    const people = bounded[field];
    if (!Array.isArray(people)) continue;
    bounded[field] = people
      .slice(0, MAX_PEOPLE)
      .map((person: unknown) =>
        typeof person === 'object' && person !== null && !Array.isArray(person)
          ? pick(person as Record<string, unknown>, PERSON_FIELDS)
          : person,
      );
    if (people.length > MAX_PEOPLE) bounded[`${field}_truncated`] = true;
  }
  if (typeof bounded.milestone === 'object' && bounded.milestone !== null) {
    bounded.milestone = pick(bounded.milestone as Record<string, unknown>, ['id', 'title']);
  }
  if (operation === 'get_repository_file') return normalizeRepositoryFile(bounded);
  switch (operation) {
    case 'get_current_user':
      return pick(bounded, ['id', 'username', 'name', 'email', 'commit_email', 'public_email']);
    case 'get_project':
    case 'list_projects':
      return pick(bounded, PROJECT_FIELDS);
    case 'search':
      switch (scope) {
        case 'projects':
          return pick(bounded, PROJECT_FIELDS);
        case 'issues':
          return pick(bounded, ISSUE_FIELDS);
        case 'merge_requests':
          return pick(bounded, MR_FIELDS);
        case 'blobs':
          return pick(bounded, ['project_id', 'path', 'filename', 'ref', 'startline', 'data']);
        case 'commits':
          return pick(bounded, [
            'id',
            'short_id',
            'project_id',
            'title',
            'author_name',
            'created_at',
            'web_url',
          ]);
        default:
          return bounded;
      }
    case 'list_branches': {
      const out = pick(bounded, ['name', 'default', 'protected', 'merged', 'web_url']);
      if (typeof bounded.commit === 'object' && bounded.commit !== null) {
        out.commit = pick(bounded.commit as Record<string, unknown>, [
          'id',
          'short_id',
          'title',
          'committed_date',
        ]);
      }
      return out;
    }
    case 'list_merge_requests':
    case 'get_merge_request':
    case 'create_merge_request':
    case 'update_merge_request':
      return pick(bounded, MR_FIELDS);
    case 'get_merge_request_diffs':
      return pick(bounded, [
        'old_path',
        'new_path',
        'a_mode',
        'b_mode',
        'diff',
        'new_file',
        'renamed_file',
        'deleted_file',
      ]);
    case 'get_merge_request_commits':
      return pick(bounded, [
        'id',
        'short_id',
        'title',
        'message',
        'author_name',
        'created_at',
        'committed_date',
      ]);
    case 'get_merge_request_notes':
    case 'get_issue_notes':
    case 'create_merge_request_note':
    case 'create_issue_note':
      return pick(bounded, NOTE_FIELDS);
    case 'list_pipelines':
    case 'get_merge_request_pipelines':
      return pick(bounded, ['id', 'sha', 'ref', 'status', 'web_url', 'created_at', 'updated_at']);
    case 'get_pipeline':
    case 'create_pipeline':
      return pick(bounded, [
        'id',
        'sha',
        'ref',
        'status',
        'web_url',
        'created_at',
        'updated_at',
        'duration',
        'coverage',
      ]);
    case 'get_pipeline_jobs':
      return pick(bounded, [
        'id',
        'name',
        'stage',
        'status',
        'web_url',
        'created_at',
        'started_at',
        'finished_at',
      ]);
    case 'get_job':
    case 'retry_job':
      return pick(bounded, [
        'id',
        'name',
        'stage',
        'status',
        'ref',
        'failure_reason',
        'web_url',
        'created_at',
        'started_at',
        'finished_at',
        'duration',
      ]);
    case 'list_repository_tree':
      return pick(bounded, ['id', 'name', 'type', 'path', 'mode']);
    case 'list_commits':
      return pick(bounded, ['id', 'short_id', 'title', 'author_name', 'committed_date', 'web_url']);
    case 'list_deployments':
      return normalizeDeployment(bounded);
    case 'get_commit':
      return pick(bounded, [
        'id',
        'short_id',
        'title',
        'message',
        'author_name',
        'author_email',
        'created_at',
        'parent_ids',
        'web_url',
      ]);
    case 'get_issue':
    case 'list_issues':
    case 'create_issue':
      return pick(bounded, ISSUE_FIELDS);
    default:
      return bounded;
  }
}

function normalizeDeployment(entry: Record<string, unknown>): Record<string, unknown> {
  const out = pick(entry, ['id', 'iid', 'ref', 'sha', 'status', 'created_at', 'updated_at']);
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const user = record(entry.user);
  if (user !== null) out.user = pick(user, PERSON_FIELDS);
  const environment = record(entry.environment);
  if (environment !== null) out.environment = pick(environment, ['name']);
  const job = record(entry.deployable);
  if (job !== null) {
    const deployable = pick(job, ['id', 'status', 'finished_at', 'web_url']);
    const pipeline = record(job.pipeline);
    if (pipeline !== null) deployable.pipeline = pick(pipeline, ['id']);
    out.deployable = deployable;
  }
  return out;
}

const REPOSITORY_FILE_FIELDS = [
  'file_path',
  'file_name',
  'size',
  'ref',
  'blob_id',
  'commit_id',
  'last_commit_id',
] as const;

/** Decoded-file report fields the tool runtime sets beside `content`. */
const DECODED_FILE_FIELDS = ['content_note', 'binary', 'content_truncated'] as const;

function decodeRepositoryFileContent(encoding: unknown, content: unknown): Record<string, unknown> {
  if (encoding !== 'base64' || typeof content !== 'string') {
    return {
      content: null,
      content_note: 'repository file content is not base64 text in this response',
    };
  }
  const decoded = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  if (decoded.length > MAX_MODEL_BYTES) {
    return {
      content: null,
      content_note: `file exceeds the ${MAX_MODEL_BYTES}-byte bound and is reported without content`,
      content_truncated: true,
    };
  }
  const binary = {
    content: null,
    content_note: 'binary file content is not returned as text',
    binary: true,
  };
  const sample = decoded.subarray(0, 8000);
  let nonText = 0;
  for (const byte of sample) {
    if (byte === 0) return binary;
    if (byte < 9 || (byte > 13 && byte < 32 && byte !== 27)) nonText += 1;
  }
  if (sample.length > 0 && nonText / sample.length > 0.3) return binary;
  return { encoding: 'text', content: decoded.toString('utf8') };
}

/**
 * Decodes a `get_repository_file` payload in the credential-owning tool
 * runtime, before its redaction: GitLab sends the content base64-encoded,
 * and a credential inside an encoded file would pass redaction unseen and
 * reach the model once decoded later. The result is the payload with
 * `encoding: 'text'` and the decoded `content`, or `content: null` with a
 * `content_note` and `binary` or `content_truncated` when the file is binary,
 * larger than the model bound, or larger than the runtime's capture bound
 * (`captureBound`, when the capture was cut). Output that is not a JSON
 * object passes unchanged; {@link normalizeGitlabOutput} reports it.
 */
export function decodeRepositoryFileOutput(output: string, captureBound?: number): string {
  if (captureBound !== undefined) {
    return JSON.stringify({
      content: null,
      content_note: `file exceeds the ${captureBound}-byte capture bound of the tool runtime and is reported without content`,
      content_truncated: true,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return output;
  const { content, encoding, ...rest } = parsed as Record<string, unknown>;
  return JSON.stringify({ ...rest, ...decodeRepositoryFileContent(encoding, content) });
}

/**
 * Bounds a file the tool runtime decoded ({@link decodeRepositoryFileOutput}).
 * Content the runtime did not decode is withheld, never decoded here, so it
 * cannot bypass the runtime's redaction.
 */
function normalizeRepositoryFile(entry: Record<string, unknown>): unknown {
  const out = pick(entry, REPOSITORY_FILE_FIELDS);
  if (entry.encoding === 'text' && typeof entry.content === 'string') {
    const { text, truncated } = truncateText(entry.content);
    return {
      ...out,
      encoding: 'text',
      content: text,
      ...(truncated ? { content_truncated: true } : {}),
    };
  }
  if (entry.content === null && typeof entry.content_note === 'string') {
    return { ...out, content: null, ...pick(entry, DECODED_FILE_FIELDS) };
  }
  return {
    ...out,
    content: null,
    content_note: 'repository file content was not decoded by the tool runtime',
  };
}

/** Renders the normalized envelope as compact model text. */
export function renderGitlabResultText(result: GitlabNormalizedResult): string {
  const header = `${result.ok ? 'ok' : 'failed'} (${result.operation} @ ${result.project})`;
  if (!result.ok) {
    return `${header}: [${result.errorCategory ?? 'upstream'}] ${result.error ?? 'request failed'}`;
  }
  if (result.operation === 'get_job_trace') return renderTraceText(header, result);
  const json = JSON.stringify(result.data);
  const body = json.slice(0, MAX_MODEL_BYTES);
  const truncated =
    result.truncated || json.length > MAX_MODEL_BYTES
      ? '\n[truncated: bounded to the model output limit with explicit markers]'
      : '';
  const warnings =
    result.warnings.length > 0 ? `\n[warnings: ${result.warnings.join(' | ').slice(0, 500)}]` : '';
  return `${header}:\n${body}${truncated}${warnings}`;
}

/**
 * A trace renders as its byte report followed by the cleaned log lines
 * verbatim (not a JSON string), so the model reads it as a log.
 */
function renderTraceText(header: string, result: GitlabNormalizedResult): string {
  const trace = result.data as GitlabTraceData;
  const report = `part: ${trace.part}, total_bytes: ${trace.total_bytes}, returned_bytes: ${trace.returned_bytes}, truncated: ${trace.truncated}`;
  const warnings =
    result.warnings.length > 0 ? `\n[warnings: ${result.warnings.join(' | ').slice(0, 500)}]` : '';
  return `${header}:\n${report}${warnings}\n--- trace ${trace.part} ---\n${trace.text}\n--- end of returned trace ---`;
}
