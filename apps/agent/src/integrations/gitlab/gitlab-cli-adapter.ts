/**
 * Invocation and result mapping for typed GitLab operations (contract v4).
 *
 * Trusted code only: the credential-owning runtime constructs the exact glab
 * invocation from the validated operation. Model input never contributes
 * flags, hosts, methods, or endpoints beyond the validated resource/query
 * arguments, which are URL-encoded literals (never shell-interpolated or
 * passed through `--field` coercion). Request bodies are JSON objects built
 * here and handed to glab through `--input` from a runtime-owned file.
 *
 * Backend: `glab api --method <M> --hostname <GITLAB_HOST>` REST requests.
 * No GraphQL, no pagination-URL following (subsequent pages rebuild from
 * validated operation/page parameters).
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

/**
 * Fixed glab argv for one request: host pinned via `--hostname`, the
 * method explicit, a JSON body only through `--input` (a runtime-owned file).
 */
export function gitlabArgv(
  request: GitlabRequest,
  host: string,
  inputPath: string | null,
): string[] {
  const argv = ['api', '--method', request.method, '--hostname', host];
  if (request.body !== null) {
    if (inputPath === null) throw new Error('a GitLab write needs a request body file');
    argv.push('--input', inputPath, '--header', 'Content-Type: application/json');
  }
  argv.push(request.endpoint);
  return argv;
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
   * Failed CLI exit only: a bounded, credential-scrubbed excerpt of
   * glab's stderr and stdout, for the action evidence and the runner log.
   * Never part of the model text, Slack or the feedback trace.
   */
  detail?: string;
}

/** Bound of a failed call's glab excerpt. */
export const MAX_FAILURE_DETAIL = 500;

/**
 * The excerpt of a failed glab call: stderr then stdout, whitespace
 * collapsed, scrubbed of credential shapes (the tool runtime has already
 * removed its own secrets) and bounded.
 */
export function failureDetail(stderr: string, stdout: string): string | undefined {
  const text = [stderr, stdout]
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
 * Parses glab stdout separately from stderr. A successful exit with malformed
 * or cut-off JSON is a failed result (invalid_response), never an empty
 * success. Normalizes to a stable envelope with explicit truncation markers.
 */
export function normalizeGitlabOutput(args: {
  operation: GitlabTransportOperationName;
  project: string;
  exitCode: number | null;
  status: 'completed' | 'failed' | 'timed_out';
  stdout: string;
  stderr: string;
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
  // A zero process exit does not imply a complete runtime result (e.g.
  // output-pipe drain expiration). Never normalize that failure as data.
  if (args.status === 'failed' && args.exitCode === 0) {
    return {
      ...base,
      ok: false,
      data: null,
      errorCategory: 'invalid_response',
      error: 'GitLab tool runtime failed to complete the response',
      ...(args.stderr.trim() ? { detail: args.stderr.trim().slice(0, 300) } : {}),
    };
  }
  const stderrNote = args.stderr.trim();
  if (stderrNote.length > 0 && args.exitCode === 0) {
    base.warnings.push(`cli stderr: ${stderrNote.slice(0, 300)}`);
  }
  if (args.exitCode !== 0) {
    const detail = failureDetail(args.stderr, args.stdout);
    return {
      ...base,
      ok: false,
      data: null,
      ...classifyCliFailure(`${args.stdout}\n${args.stderr}`, args.exitCode),
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
    const trace = normalizeTrace(args.stdout, args.textMeta);
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
    parsed = JSON.parse(args.stdout);
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
    return {
      ...base,
      ok: true,
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
  stdout: string,
  meta: GitlabTextMeta,
): { data: GitlabTraceData; warnings: string[] } {
  let text = cleanTraceText(stdout);
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

function classifyCliFailure(
  output: string,
  exitCode: number | null,
): { errorCategory: GitlabErrorCategory; error: string } {
  const text = output.slice(0, 4000).toLowerCase();
  if (/\b401\b|unauthorized|invalid[_ ]?token|authentication/.test(text)) {
    return { errorCategory: 'authentication', error: 'GitLab authentication failed' };
  }
  if (/\b403\b|forbidden|access denied|insufficient/.test(text)) {
    return {
      errorCategory: 'forbidden',
      error: 'GitLab refused the request (forbidden for this token)',
    };
  }
  if (/\b404\b|not found/.test(text)) {
    return {
      errorCategory: 'not_found',
      error: 'GitLab resource was not found (or is not visible to this token)',
    };
  }
  if (/\b409\b|conflict|already exists/.test(text)) {
    return {
      errorCategory: 'conflict',
      error: 'GitLab reported a conflict (resource already exists)',
    };
  }
  if (/\b(400|422)\b|bad request|unprocessable/.test(text)) {
    const detail = /"message"\s*:\s*("(?:[^"\\]|\\.)*"|\{[^}]*\}|\[[^\]]*\])/.exec(output);
    return {
      errorCategory: 'invalid_input',
      error: `GitLab rejected the request${detail ? `: ${detail[1]!.slice(0, 200)}` : ''}`,
    };
  }
  if (/\b429\b|rate.?limit|too many requests/.test(text)) {
    return { errorCategory: 'rate_limit', error: 'GitLab rate limit reached; retry later' };
  }
  if (
    /\b501\b|not implemented|unsupported|search.*not.*available|scope.*not.*supported/.test(text)
  ) {
    return {
      errorCategory: 'unsupported',
      error: 'GitLab does not support this operation/scope on this instance',
    };
  }
  if (/\b5\d\d\b|internal error|bad gateway|service unavailable|gateway timeout/.test(text)) {
    return {
      errorCategory: 'upstream',
      error: `GitLab upstream error (exit ${exitCode ?? 'unknown'})`,
    };
  }
  return {
    errorCategory: 'upstream',
    error: `GitLab request failed (exit ${exitCode ?? 'unknown'})`,
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
export function decodeRepositoryFileOutput(stdout: string, captureBound?: number): string {
  if (captureBound !== undefined) {
    return JSON.stringify({
      content: null,
      content_note: `file exceeds the ${captureBound}-byte capture bound of the tool runtime and is reported without content`,
      content_truncated: true,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return stdout;
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
  const body = JSON.stringify(result.data, null, 2).slice(0, MAX_MODEL_BYTES);
  const truncated = result.truncated
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
