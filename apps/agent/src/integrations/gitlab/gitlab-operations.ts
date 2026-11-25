/**
 * Typed GitLab operations over the REST API (contract v6).
 *
 * The GitLab token is the permission boundary: every operation names the
 * project it addresses (`project`: a `group/subgroup/name` path or a numeric
 * project ID) and may reach any project the token can. The exceptions are
 * `list_projects`, instance-wide `search`, and the merge-request and issue
 * lists, which take a `project`, a `group` (`group/subgroup` path or numeric
 * group ID, subgroups included) or neither (the whole instance, then
 * narrowed by at least one person, search, label or milestone filter).
 * People are addressed by GitLab username, never by user ID. The host is never a
 * model argument — the credential-owning runtime pins it to the
 * instance's host. No model-supplied URL, endpoint, method, GraphQL or
 * credential is accepted; every model value becomes a URL-encoded literal or
 * a JSON body built by trusted code.
 *
 * Names are the agent's GitLab tool names. They are
 * inspired by GitLab's MCP catalog but this contract is application-owned.
 *
 * Writes (notes, issues, merge requests, job retries, pipelines) are part of
 * the contract; the broker admits them like reads (live GitLab assignment,
 * call budget) and marks them for reconciliation. Merging, branch/tag
 * deletion, CI variables, and project settings are not part of this contract.
 */

export const GITLAB_CONTRACT_VERSION = 6;

export const GITLAB_READ_OPERATIONS = [
  'get_project',
  'list_projects',
  'get_issue',
  'list_issues',
  'get_issue_notes',
  'search',
  'list_branches',
  'list_merge_requests',
  'get_merge_request',
  'get_merge_request_diffs',
  'get_merge_request_commits',
  'get_merge_request_notes',
  'list_pipelines',
  'get_pipeline',
  'get_pipeline_jobs',
  'get_job',
  'get_job_trace',
  'list_repository_tree',
  'get_repository_file',
  'get_commit',
  'get_merge_request_pipelines',
] as const;

export const GITLAB_WRITE_OPERATIONS = [
  'create_merge_request_note',
  'create_issue_note',
  'create_issue',
  'update_merge_request',
  'create_merge_request',
  'retry_job',
  'create_pipeline',
] as const;

export const GITLAB_OPERATIONS = [...GITLAB_READ_OPERATIONS, ...GITLAB_WRITE_OPERATIONS] as const;

/**
 * Controller-only reads: trusted code (publication) calls them through the
 * tool runtime, but they are never model tools. `get_current_user` is the
 * token's own user, whose identity authors published commits.
 */
export const GITLAB_CONTROLLER_OPERATIONS = ['get_current_user'] as const;

export type GitlabReadOperationName = (typeof GITLAB_READ_OPERATIONS)[number];
export type GitlabWriteOperationName = (typeof GITLAB_WRITE_OPERATIONS)[number];
export type GitlabOperationName = GitlabReadOperationName | GitlabWriteOperationName;
export type GitlabControllerOperationName = (typeof GITLAB_CONTROLLER_OPERATIONS)[number];
/** Every operation the tool runtime serves: the model's plus the controller's. */
export type GitlabTransportOperationName = GitlabOperationName | GitlabControllerOperationName;

/** Model-callable operations only (MCP tools, guard, broker admission). */
export function isGitlabOperationName(value: unknown): value is GitlabOperationName {
  return typeof value === 'string' && (GITLAB_OPERATIONS as readonly string[]).includes(value);
}

/** Operations the tool runtime accepts from trusted runner code. */
export function isGitlabTransportOperationName(
  value: unknown,
): value is GitlabTransportOperationName {
  return (
    isGitlabOperationName(value) ||
    (typeof value === 'string' &&
      (GITLAB_CONTROLLER_OPERATIONS as readonly string[]).includes(value))
  );
}

export function isGitlabWriteOperation(value: unknown): value is GitlabWriteOperationName {
  return (
    typeof value === 'string' && (GITLAB_WRITE_OPERATIONS as readonly string[]).includes(value)
  );
}

export class GitlabOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitlabOperationError';
  }
}

// --- Shared bounds -----------------------------------------------------------

const MAX_SEARCH_LENGTH = 512;
const MAX_PATH_LENGTH = 1024;
const MAX_REF_LENGTH = 256;
const MAX_PROJECT_PATH_LENGTH = 255;
export const MAX_TITLE_LENGTH = 255;
export const MAX_BODY_LENGTH = 60_000;
const MAX_LABELS = 20;
const MAX_LABEL_LENGTH = 100;
const MAX_USER_IDS = 20;
const MAX_MILESTONE_LENGTH = 255;

/** GitLab's own username rule (filters take one username each, never a user ID). */
export const GITLAB_USERNAME_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/;
/** RFC 3339 timestamp with a mandatory time and offset, e.g. 2026-09-01T00:00:00Z. */
export const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function assertNoUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new GitlabOperationError(`${operation}: unknown argument "${key.slice(0, 64)}"`);
    }
  }
}

function asRecord(value: unknown, operation: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitlabOperationError(`${operation}: arguments must be an object`);
  }
  return value as Record<string, unknown>;
}

// eslint-disable-next-line no-control-regex -- intentional control-character rejection set
const CONTROL_CHARACTERS = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const PROJECT_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Shared rule for project and group references: a numeric ID or a plain
 * `group/subgroup/name` path with at least `minSegments` segments. URLs,
 * hosts, `..`, encoded separators, and anything else that is not a plain
 * path are rejected. Returns the normalized form (path or decimal ID string).
 */
function parseNamespacedRef(
  value: unknown,
  operation: string,
  field: 'project' | 'group',
  minSegments: number,
): string {
  const noun = field === 'project' ? 'group/name' : 'group/subgroup';
  if (isPositiveSafeInt(value)) return String(value);
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitlabOperationError(
      `${operation}: ${field} must be a ${noun} path or a numeric ${field} ID`,
    );
  }
  if (/^[1-9][0-9]{0,15}$/.test(value)) return value;
  if (value.length > MAX_PROJECT_PATH_LENGTH) {
    throw new GitlabOperationError(`${operation}: ${field} path is too long`);
  }
  if (/[:%\\@?#\s]/.test(value) || value.includes('//')) {
    throw new GitlabOperationError(
      `${operation}: ${field} must be a plain ${noun} path (no URL, host, or encoded characters)`,
    );
  }
  const segments = value.split('/');
  if (segments.length < minSegments) {
    throw new GitlabOperationError(
      `${operation}: ${field} path must include its group (group/name)`,
    );
  }
  for (const segment of segments) {
    if (
      !PROJECT_SEGMENT.test(segment) ||
      segment === '..' ||
      segment.endsWith('.git') ||
      segment.endsWith('.atom')
    ) {
      throw new GitlabOperationError(`${operation}: ${field} path segment is not supported`);
    }
  }
  return value;
}

/**
 * Validates a model-supplied project reference: a numeric project ID or a
 * `group/subgroup/name` path. URLs, hosts, `..`, encoded separators, and
 * anything else that is not a plain path are rejected. Returns the
 * normalized form (path string or decimal ID string).
 */
export function parseProjectRef(value: unknown, operation: string): string {
  return parseNamespacedRef(value, operation, 'project', 2);
}

/**
 * Validates a model-supplied group reference with the project rules, except
 * that a top-level group (one path segment) is a valid group path.
 */
export function parseGroupRef(value: unknown, operation: string): string {
  return parseNamespacedRef(value, operation, 'group', 1);
}

export interface PaginationArgs {
  page: number;
  per_page: number;
}

/** Page size of `list_projects` without a search phrase. */
export const LIST_PROJECTS_DEFAULT_PER_PAGE = 50;

function parsePagination(input: Record<string, unknown>, operation: string): PaginationArgs {
  const rawPage = input.page ?? 1;
  const rawPerPage = input.per_page ?? 20;
  if (
    typeof rawPage !== 'number' ||
    !Number.isSafeInteger(rawPage) ||
    rawPage < 1 ||
    rawPage > 10000
  ) {
    throw new GitlabOperationError(`${operation}: page must be a positive safe integer`);
  }
  if (
    typeof rawPerPage !== 'number' ||
    !Number.isSafeInteger(rawPerPage) ||
    rawPerPage < 1 ||
    rawPerPage > 100
  ) {
    throw new GitlabOperationError(`${operation}: per_page must be an integer between 1 and 100`);
  }
  return { page: rawPage, per_page: rawPerPage };
}

function parseOptionalSearch(
  value: unknown,
  operation: string,
  required: boolean,
): string | undefined {
  if (value === undefined) {
    if (required) throw new GitlabOperationError(`${operation}: search is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_SEARCH_LENGTH) {
    throw new GitlabOperationError(
      `${operation}: search must be a non-empty string up to ${MAX_SEARCH_LENGTH} characters`,
    );
  }
  return value;
}

function parseRef(
  value: unknown,
  operation: string,
  required: boolean,
  field = 'ref',
): string | undefined {
  if (value === undefined) {
    if (required) throw new GitlabOperationError(`${operation}: ${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REF_LENGTH) {
    throw new GitlabOperationError(
      `${operation}: ${field} must be a non-empty string up to ${MAX_REF_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTERS.test(value) || /[\s\n\r\t]/.test(value)) {
    throw new GitlabOperationError(`${operation}: ${field} contains unsupported characters`);
  }
  return value;
}

function parsePath(
  value: unknown,
  operation: string,
  required: boolean,
  field: string,
): string | undefined {
  if (value === undefined) {
    if (required) throw new GitlabOperationError(`${operation}: ${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new GitlabOperationError(
      `${operation}: ${field} must be a non-empty string up to ${MAX_PATH_LENGTH} characters`,
    );
  }
  if (/[\0]/.test(value)) {
    throw new GitlabOperationError(`${operation}: ${field} contains unsupported characters`);
  }
  return value;
}

function parseText(
  value: unknown,
  operation: string,
  field: string,
  max: number,
  required: boolean,
): string | undefined {
  if (value === undefined) {
    if (required) throw new GitlabOperationError(`${operation}: ${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new GitlabOperationError(
      `${operation}: ${field} must be a non-empty string up to ${max} characters`,
    );
  }
  if (/\0/.test(value)) {
    throw new GitlabOperationError(`${operation}: ${field} contains unsupported characters`);
  }
  return value;
}

function parseLabels(value: unknown, operation: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_LABELS ||
    !value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.trim().length > 0 &&
        entry.length <= MAX_LABEL_LENGTH &&
        !entry.includes(',') &&
        !CONTROL_CHARACTERS.test(entry),
    )
  ) {
    throw new GitlabOperationError(
      `${operation}: labels must be up to ${MAX_LABELS} label names without commas`,
    );
  }
  return [...(value as string[])];
}

function parseUserIds(value: unknown, operation: string, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_USER_IDS ||
    !value.every((entry) => isPositiveSafeInt(entry))
  ) {
    throw new GitlabOperationError(
      `${operation}: ${field} must be up to ${MAX_USER_IDS} positive user IDs`,
    );
  }
  return [...(value as number[])];
}

function parseUsername(value: unknown, operation: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !GITLAB_USERNAME_PATTERN.test(value)) {
    throw new GitlabOperationError(
      `${operation}: ${field} must be one GitLab username (letters, digits, _ . -; no @, spaces, or URL)`,
    );
  }
  return value;
}

function parseTimestamp(value: unknown, operation: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  const match = typeof value === 'string' ? RFC3339_PATTERN.exec(value) : null;
  const valid =
    match !== null &&
    !Number.isNaN(Date.parse(value as string)) &&
    // Date.parse rolls 2026-02-30 over to March; the calendar day must exist.
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDate() ===
      Number(match[3]);
  if (!valid) {
    throw new GitlabOperationError(
      `${operation}: ${field} must be an RFC 3339 timestamp such as 2026-09-01T00:00:00Z`,
    );
  }
  return value as string;
}

function parseEnum<T extends string>(
  value: unknown,
  operation: string,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new GitlabOperationError(`${operation}: ${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseOrderBy<T extends string>(
  value: unknown,
  operation: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return parseEnum(value, operation, 'order_by', allowed, fallback);
}

function parseSort(value: unknown, operation: string, fallback: SortDirection): SortDirection {
  return parseEnum(value, operation, 'sort', SORT_DIRECTIONS, fallback);
}

function parseMilestone(value: unknown, operation: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_MILESTONE_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new GitlabOperationError(
      `${operation}: milestone must be a milestone title up to ${MAX_MILESTONE_LENGTH} characters (or None, Any)`,
    );
  }
  return value;
}

/** Filters that narrow an instance-wide list enough to be meaningful (decision 3). */
const MR_NARROWING_FILTERS = [
  'author_username',
  'assignee_username',
  'reviewer_username',
  'search',
  'labels',
  'milestone',
] as const;
const ISSUE_NARROWING_FILTERS = [
  'author_username',
  'assignee_username',
  'search',
  'labels',
  'milestone',
] as const;

function formatList(names: readonly string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * Scope of a merge-request or issue list: `project`, `group` (subgroups
 * included), or neither for the whole instance. project and group are
 * mutually exclusive; an instance-wide list needs at least one narrowing
 * filter among the already validated `filters` (an empty label list does
 * not narrow).
 */
function assertScope(
  input: Record<string, unknown>,
  operation: string,
  filters: Record<string, unknown>,
  narrowing: readonly string[],
): { project: string } | { group: string } | Record<string, never> {
  if (input.project !== undefined && input.group !== undefined) {
    throw new GitlabOperationError(`${operation}: give either project or group, not both`);
  }
  if (input.project !== undefined) return { project: parseProjectRef(input.project, operation) };
  if (input.group !== undefined) return { group: parseGroupRef(input.group, operation) };
  const narrowed = narrowing.some((key) => {
    const value = filters[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
  if (!narrowed) {
    throw new GitlabOperationError(
      `${operation}: without project or group the list covers the whole instance and needs at least one of ${formatList(narrowing)}`,
    );
  }
  return {};
}

const DATE_RANGE_FIELDS = [
  'created_after',
  'created_before',
  'updated_after',
  'updated_before',
] as const;

function parseDateRange(
  input: Record<string, unknown>,
  operation: string,
): Partial<Record<(typeof DATE_RANGE_FIELDS)[number], string>> {
  const out: Partial<Record<(typeof DATE_RANGE_FIELDS)[number], string>> = {};
  for (const field of DATE_RANGE_FIELDS) {
    const value = parseTimestamp(input[field], operation, field);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/** Drops undefined entries so validated shapes carry only given filters. */
function definedOnly<T extends Record<string, unknown>>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function requireIid(input: Record<string, unknown>, field: string, operation: string): number {
  const value = input[field];
  if (!isPositiveSafeInt(value))
    throw new GitlabOperationError(`${operation}: ${field} must be a positive safe integer`);
  return value;
}

// --- Per-operation validated argument shapes ---------------------------------

export type MergeRequestState = 'opened' | 'closed' | 'merged' | 'all';
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];
export const MR_ORDER_BY = ['created_at', 'updated_at'] as const;
export const ISSUE_ORDER_BY = ['created_at', 'updated_at', 'due_date'] as const;

/** Date-range filters shared by the merge-request and issue lists (RFC 3339). */
interface DateRangeFilters {
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
}

export type ValidatedGitlabArgs =
  | { kind: 'get_current_user' }
  | { kind: 'get_project'; project: string }
  | { kind: 'list_projects'; search?: string; page: number; per_page: number }
  | { kind: 'get_issue'; project: string; issue_iid: number }
  | ({
      kind: 'list_issues';
      /** Exclusive with group; neither means instance-wide. */
      project?: string;
      group?: string;
      state: 'opened' | 'closed' | 'all';
      search?: string;
      labels?: string[];
      author_username?: string;
      assignee_username?: string;
      milestone?: string;
      order_by: (typeof ISSUE_ORDER_BY)[number];
      sort: SortDirection;
      page: number;
      per_page: number;
    } & DateRangeFilters)
  | { kind: 'get_issue_notes'; project: string; issue_iid: number; page: number; per_page: number }
  | {
      kind: 'search';
      project?: string;
      scope: SearchScope;
      search: string;
      page: number;
      per_page: number;
    }
  | { kind: 'list_branches'; project: string; search?: string; page: number; per_page: number }
  | ({
      kind: 'list_merge_requests';
      /** Exclusive with group; neither means instance-wide. */
      project?: string;
      group?: string;
      state: MergeRequestState;
      search?: string;
      source_branch?: string;
      target_branch?: string;
      author_username?: string;
      assignee_username?: string;
      reviewer_username?: string;
      labels?: string[];
      milestone?: string;
      draft?: boolean;
      order_by: (typeof MR_ORDER_BY)[number];
      sort: SortDirection;
      page: number;
      per_page: number;
    } & DateRangeFilters)
  | { kind: 'get_merge_request'; project: string; merge_request_iid: number }
  | {
      kind: 'get_merge_request_diffs';
      project: string;
      merge_request_iid: number;
      page: number;
      per_page: number;
    }
  | {
      kind: 'get_merge_request_commits';
      project: string;
      merge_request_iid: number;
      page: number;
      per_page: number;
    }
  | {
      kind: 'get_merge_request_notes';
      project: string;
      merge_request_iid: number;
      page: number;
      per_page: number;
    }
  | {
      kind: 'list_pipelines';
      project: string;
      ref?: string;
      status?: string;
      page: number;
      per_page: number;
    }
  | { kind: 'get_pipeline'; project: string; pipeline_id: number }
  | {
      kind: 'get_pipeline_jobs';
      project: string;
      pipeline_id: number;
      page: number;
      per_page: number;
    }
  | { kind: 'get_job'; project: string; job_id: number }
  | { kind: 'get_job_trace'; project: string; job_id: number; head: boolean }
  | {
      kind: 'list_repository_tree';
      project: string;
      ref: string;
      path?: string;
      recursive?: boolean;
      page: number;
      per_page: number;
    }
  | { kind: 'get_repository_file'; project: string; file_path: string; ref: string }
  | { kind: 'get_commit'; project: string; sha: string }
  | {
      kind: 'get_merge_request_pipelines';
      project: string;
      merge_request_iid: number;
      page: number;
      per_page: number;
    }
  | { kind: 'create_merge_request_note'; project: string; merge_request_iid: number; body: string }
  | { kind: 'create_issue_note'; project: string; issue_iid: number; body: string }
  | {
      kind: 'create_issue';
      project: string;
      title: string;
      description?: string;
      labels?: string[];
      assignee_ids?: number[];
      /** Visible only to project members at Reporter and above. */
      confidential?: boolean;
    }
  | {
      kind: 'update_merge_request';
      project: string;
      merge_request_iid: number;
      title?: string;
      description?: string;
      labels?: string[];
      assignee_ids?: number[];
      reviewer_ids?: number[];
      state_event?: 'close' | 'reopen';
    }
  | {
      kind: 'create_merge_request';
      project: string;
      source_branch: string;
      target_branch: string;
      title: string;
      description?: string;
      labels?: string[];
    }
  | { kind: 'retry_job'; project: string; job_id: number }
  | { kind: 'create_pipeline'; project: string; ref: string };

export const PIPELINE_STATUSES = [
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
  'scheduled',
] as const;

/** Project-scoped search scopes. */
export const PROJECT_SEARCH_SCOPES = ['issues', 'merge_requests', 'blobs', 'commits'] as const;
/** Instance-wide search scopes (without `project`). */
export const INSTANCE_SEARCH_SCOPES = [
  'projects',
  'issues',
  'merge_requests',
  'blobs',
  'commits',
] as const;
export type SearchScope = (typeof INSTANCE_SEARCH_SCOPES)[number];

const MR_STATES = ['opened', 'closed', 'merged', 'all'] as const;

/**
 * Strictly validates model-supplied arguments for one operation. Rejects
 * unknown keys, invalid enums, and out-of-bound values; never silently
 * discards unsupported parameters. Accepts controller operations too: model
 * paths admit only `isGitlabOperationName` before calling this.
 */
export function validateGitlabOperation(operation: string, args: unknown): ValidatedGitlabArgs {
  if (!isGitlabTransportOperationName(operation)) {
    throw new GitlabOperationError(`unknown GitLab operation "${String(operation).slice(0, 64)}"`);
  }
  const input = asRecord(args ?? {}, operation);
  const project = (): string => parseProjectRef(input.project, operation);
  switch (operation) {
    case 'get_current_user': {
      assertNoUnknownKeys(input, [], operation);
      return { kind: 'get_current_user' };
    }
    case 'get_project': {
      assertNoUnknownKeys(input, ['project'], operation);
      return { kind: 'get_project', project: project() };
    }
    case 'list_projects': {
      assertNoUnknownKeys(input, ['search', 'page', 'per_page'], operation);
      const search = parseOptionalSearch(input.search, operation, false);
      // Without a phrase: one page of the token's member projects, most
      // recently active first, large enough to list once instead of guessing.
      const pagination = parsePagination(
        search === undefined && input.per_page === undefined
          ? { ...input, per_page: LIST_PROJECTS_DEFAULT_PER_PAGE }
          : input,
        operation,
      );
      return {
        kind: 'list_projects',
        ...(search !== undefined ? { search } : {}),
        ...pagination,
      };
    }
    case 'get_issue': {
      assertNoUnknownKeys(input, ['project', 'issue_iid'], operation);
      return {
        kind: 'get_issue',
        project: project(),
        issue_iid: requireIid(input, 'issue_iid', operation),
      };
    }
    case 'list_issues': {
      assertNoUnknownKeys(
        input,
        [
          'project',
          'group',
          'state',
          'search',
          'labels',
          'author_username',
          'assignee_username',
          'milestone',
          ...DATE_RANGE_FIELDS,
          'order_by',
          'sort',
          'page',
          'per_page',
        ],
        operation,
      );
      const state = input.state ?? 'opened';
      if (state !== 'opened' && state !== 'closed' && state !== 'all') {
        throw new GitlabOperationError('list_issues: state must be one of opened, closed, all');
      }
      const filters = {
        search: parseOptionalSearch(input.search, operation, false),
        labels: parseLabels(input.labels, operation),
        author_username: parseUsername(input.author_username, operation, 'author_username'),
        assignee_username: parseUsername(input.assignee_username, operation, 'assignee_username'),
        milestone: parseMilestone(input.milestone, operation),
      };
      const scope = assertScope(input, operation, filters, ISSUE_NARROWING_FILTERS);
      return {
        kind: 'list_issues',
        ...scope,
        state,
        ...definedOnly(filters),
        ...parseDateRange(input, operation),
        order_by: parseOrderBy(input.order_by, operation, ISSUE_ORDER_BY, 'created_at'),
        sort: parseSort(input.sort, operation, 'desc'),
        ...parsePagination(input, operation),
      };
    }
    case 'get_issue_notes': {
      assertNoUnknownKeys(input, ['project', 'issue_iid', 'page', 'per_page'], operation);
      return {
        kind: 'get_issue_notes',
        project: project(),
        issue_iid: requireIid(input, 'issue_iid', operation),
        ...parsePagination(input, operation),
      };
    }
    case 'search': {
      assertNoUnknownKeys(input, ['project', 'scope', 'search', 'page', 'per_page'], operation);
      const scoped = input.project !== undefined;
      const allowed: readonly string[] = scoped ? PROJECT_SEARCH_SCOPES : INSTANCE_SEARCH_SCOPES;
      if (typeof input.scope !== 'string' || !allowed.includes(input.scope)) {
        throw new GitlabOperationError(
          `search: scope must be one of ${allowed.join(', ')}${scoped ? ' (with project)' : ' (instance-wide)'}`,
        );
      }
      const search = parseOptionalSearch(input.search, operation, true) as string;
      return {
        kind: 'search',
        ...(scoped ? { project: project() } : {}),
        scope: input.scope as SearchScope,
        search,
        ...parsePagination(input, operation),
      };
    }
    case 'list_branches': {
      assertNoUnknownKeys(input, ['project', 'search', 'page', 'per_page'], operation);
      const search = parseOptionalSearch(input.search, operation, false);
      return {
        kind: 'list_branches',
        project: project(),
        ...(search !== undefined ? { search } : {}),
        ...parsePagination(input, operation),
      };
    }
    case 'list_merge_requests': {
      assertNoUnknownKeys(
        input,
        [
          'project',
          'group',
          'state',
          'search',
          'source_branch',
          'target_branch',
          'author_username',
          'assignee_username',
          'reviewer_username',
          'labels',
          'milestone',
          'draft',
          ...DATE_RANGE_FIELDS,
          'order_by',
          'sort',
          'page',
          'per_page',
        ],
        operation,
      );
      const state = input.state ?? 'opened';
      if (typeof state !== 'string' || !(MR_STATES as readonly string[]).includes(state)) {
        throw new GitlabOperationError(
          'list_merge_requests: state must be one of opened, closed, merged, all',
        );
      }
      if (input.draft !== undefined && typeof input.draft !== 'boolean') {
        throw new GitlabOperationError('list_merge_requests: draft must be a boolean');
      }
      const filters = {
        search: parseOptionalSearch(input.search, operation, false),
        source_branch: parseRef(input.source_branch, operation, false, 'source_branch'),
        target_branch: parseRef(input.target_branch, operation, false, 'target_branch'),
        author_username: parseUsername(input.author_username, operation, 'author_username'),
        assignee_username: parseUsername(input.assignee_username, operation, 'assignee_username'),
        reviewer_username: parseUsername(input.reviewer_username, operation, 'reviewer_username'),
        labels: parseLabels(input.labels, operation),
        milestone: parseMilestone(input.milestone, operation),
        draft: input.draft as boolean | undefined,
      };
      const scope = assertScope(input, operation, filters, MR_NARROWING_FILTERS);
      return {
        kind: 'list_merge_requests',
        ...scope,
        state: state as MergeRequestState,
        ...definedOnly(filters),
        ...parseDateRange(input, operation),
        order_by: parseOrderBy(input.order_by, operation, MR_ORDER_BY, 'updated_at'),
        sort: parseSort(input.sort, operation, 'desc'),
        ...parsePagination(input, operation),
      };
    }
    case 'get_merge_request': {
      assertNoUnknownKeys(input, ['project', 'merge_request_iid'], operation);
      return {
        kind: 'get_merge_request',
        project: project(),
        merge_request_iid: requireIid(input, 'merge_request_iid', operation),
      };
    }
    case 'get_merge_request_diffs':
    case 'get_merge_request_commits':
    case 'get_merge_request_notes':
    case 'get_merge_request_pipelines': {
      assertNoUnknownKeys(input, ['project', 'merge_request_iid', 'page', 'per_page'], operation);
      return {
        kind: operation,
        project: project(),
        merge_request_iid: requireIid(input, 'merge_request_iid', operation),
        ...parsePagination(input, operation),
      };
    }
    case 'list_pipelines': {
      assertNoUnknownKeys(input, ['project', 'ref', 'status', 'page', 'per_page'], operation);
      const ref = parseRef(input.ref, operation, false);
      let status: string | undefined;
      if (input.status !== undefined) {
        if (
          typeof input.status !== 'string' ||
          !(PIPELINE_STATUSES as readonly string[]).includes(input.status)
        ) {
          throw new GitlabOperationError(
            `list_pipelines: status must be one of ${PIPELINE_STATUSES.join(', ')}`,
          );
        }
        status = input.status;
      }
      return {
        kind: 'list_pipelines',
        project: project(),
        ...(ref !== undefined ? { ref } : {}),
        ...(status !== undefined ? { status } : {}),
        ...parsePagination(input, operation),
      };
    }
    case 'get_pipeline': {
      assertNoUnknownKeys(input, ['project', 'pipeline_id'], operation);
      return {
        kind: 'get_pipeline',
        project: project(),
        pipeline_id: requireIid(input, 'pipeline_id', operation),
      };
    }
    case 'get_pipeline_jobs': {
      assertNoUnknownKeys(input, ['project', 'pipeline_id', 'page', 'per_page'], operation);
      return {
        kind: 'get_pipeline_jobs',
        project: project(),
        pipeline_id: requireIid(input, 'pipeline_id', operation),
        ...parsePagination(input, operation),
      };
    }
    case 'get_job': {
      assertNoUnknownKeys(input, ['project', 'job_id'], operation);
      return {
        kind: 'get_job',
        project: project(),
        job_id: requireIid(input, 'job_id', operation),
      };
    }
    case 'get_job_trace': {
      assertNoUnknownKeys(input, ['project', 'job_id', 'head'], operation);
      if (input.head !== undefined && typeof input.head !== 'boolean') {
        throw new GitlabOperationError('get_job_trace: head must be a boolean');
      }
      return {
        kind: 'get_job_trace',
        project: project(),
        job_id: requireIid(input, 'job_id', operation),
        head: input.head === true,
      };
    }
    case 'list_repository_tree': {
      assertNoUnknownKeys(
        input,
        ['project', 'path', 'ref', 'recursive', 'page', 'per_page'],
        operation,
      );
      const ref = parseRef(input.ref, operation, true) as string;
      const treePath = parsePath(input.path, operation, false, 'path');
      let recursive: boolean | undefined;
      if (input.recursive !== undefined) {
        if (typeof input.recursive !== 'boolean')
          throw new GitlabOperationError('list_repository_tree: recursive must be a boolean');
        recursive = input.recursive;
      }
      return {
        kind: 'list_repository_tree',
        project: project(),
        ref,
        ...(treePath !== undefined ? { path: treePath } : {}),
        ...(recursive !== undefined ? { recursive } : {}),
        ...parsePagination(input, operation),
      };
    }
    case 'get_repository_file': {
      assertNoUnknownKeys(input, ['project', 'file_path', 'ref'], operation);
      const filePath = parsePath(input.file_path, operation, true, 'file_path') as string;
      const ref = parseRef(input.ref, operation, true) as string;
      return { kind: 'get_repository_file', project: project(), file_path: filePath, ref };
    }
    case 'get_commit': {
      assertNoUnknownKeys(input, ['project', 'sha'], operation);
      if (typeof input.sha !== 'string' || !/^[0-9a-fA-F]{4,64}$/.test(input.sha)) {
        throw new GitlabOperationError('get_commit: sha must be 4-64 hexadecimal characters');
      }
      return { kind: 'get_commit', project: project(), sha: input.sha };
    }
    case 'create_merge_request_note': {
      assertNoUnknownKeys(input, ['project', 'merge_request_iid', 'body'], operation);
      return {
        kind: 'create_merge_request_note',
        project: project(),
        merge_request_iid: requireIid(input, 'merge_request_iid', operation),
        body: parseText(input.body, operation, 'body', MAX_BODY_LENGTH, true) as string,
      };
    }
    case 'create_issue_note': {
      assertNoUnknownKeys(input, ['project', 'issue_iid', 'body'], operation);
      return {
        kind: 'create_issue_note',
        project: project(),
        issue_iid: requireIid(input, 'issue_iid', operation),
        body: parseText(input.body, operation, 'body', MAX_BODY_LENGTH, true) as string,
      };
    }
    case 'create_issue': {
      assertNoUnknownKeys(
        input,
        ['project', 'title', 'description', 'labels', 'assignee_ids', 'confidential'],
        operation,
      );
      if (input.confidential !== undefined && typeof input.confidential !== 'boolean')
        throw new GitlabOperationError('create_issue: confidential must be a boolean');
      const description = parseText(
        input.description,
        operation,
        'description',
        MAX_BODY_LENGTH,
        false,
      );
      const labels = parseLabels(input.labels, operation);
      const assignees = parseUserIds(input.assignee_ids, operation, 'assignee_ids');
      return {
        kind: 'create_issue',
        project: project(),
        title: parseText(input.title, operation, 'title', MAX_TITLE_LENGTH, true) as string,
        ...(description !== undefined ? { description } : {}),
        ...(labels !== undefined ? { labels } : {}),
        ...(assignees !== undefined ? { assignee_ids: assignees } : {}),
        ...(input.confidential !== undefined
          ? { confidential: input.confidential as boolean }
          : {}),
      };
    }
    case 'update_merge_request': {
      assertNoUnknownKeys(
        input,
        [
          'project',
          'merge_request_iid',
          'title',
          'description',
          'labels',
          'assignee_ids',
          'reviewer_ids',
          'state_event',
        ],
        operation,
      );
      const title = parseText(input.title, operation, 'title', MAX_TITLE_LENGTH, false);
      const description = parseText(
        input.description,
        operation,
        'description',
        MAX_BODY_LENGTH,
        false,
      );
      const labels = parseLabels(input.labels, operation);
      const assignees = parseUserIds(input.assignee_ids, operation, 'assignee_ids');
      const reviewers = parseUserIds(input.reviewer_ids, operation, 'reviewer_ids');
      let stateEvent: 'close' | 'reopen' | undefined;
      if (input.state_event !== undefined) {
        if (input.state_event !== 'close' && input.state_event !== 'reopen') {
          throw new GitlabOperationError(
            'update_merge_request: state_event must be close or reopen',
          );
        }
        stateEvent = input.state_event;
      }
      if (
        title === undefined &&
        description === undefined &&
        labels === undefined &&
        assignees === undefined &&
        reviewers === undefined &&
        stateEvent === undefined
      ) {
        throw new GitlabOperationError('update_merge_request: nothing to update');
      }
      return {
        kind: 'update_merge_request',
        project: project(),
        merge_request_iid: requireIid(input, 'merge_request_iid', operation),
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(labels !== undefined ? { labels } : {}),
        ...(assignees !== undefined ? { assignee_ids: assignees } : {}),
        ...(reviewers !== undefined ? { reviewer_ids: reviewers } : {}),
        ...(stateEvent !== undefined ? { state_event: stateEvent } : {}),
      };
    }
    case 'create_merge_request': {
      assertNoUnknownKeys(
        input,
        ['project', 'source_branch', 'target_branch', 'title', 'description', 'labels'],
        operation,
      );
      const sourceBranch = parseRef(
        input.source_branch,
        operation,
        true,
        'source_branch',
      ) as string;
      const targetBranch = parseRef(
        input.target_branch,
        operation,
        true,
        'target_branch',
      ) as string;
      if (sourceBranch === targetBranch) {
        throw new GitlabOperationError(
          'create_merge_request: source_branch and target_branch must differ',
        );
      }
      if (targetBranch.startsWith('support-agent/')) {
        throw new GitlabOperationError(
          'create_merge_request: support-agent/ branches are never merge targets',
        );
      }
      const description = parseText(
        input.description,
        operation,
        'description',
        MAX_BODY_LENGTH,
        false,
      );
      const labels = parseLabels(input.labels, operation);
      return {
        kind: 'create_merge_request',
        project: project(),
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title: parseText(input.title, operation, 'title', MAX_TITLE_LENGTH, true) as string,
        ...(description !== undefined ? { description } : {}),
        ...(labels !== undefined ? { labels } : {}),
      };
    }
    case 'retry_job': {
      assertNoUnknownKeys(input, ['project', 'job_id'], operation);
      return {
        kind: 'retry_job',
        project: project(),
        job_id: requireIid(input, 'job_id', operation),
      };
    }
    case 'create_pipeline': {
      assertNoUnknownKeys(input, ['project', 'ref'], operation);
      return {
        kind: 'create_pipeline',
        project: project(),
        ref: parseRef(input.ref, operation, true) as string,
      };
    }
    default:
      throw new GitlabOperationError(
        `unknown GitLab operation "${String(operation).slice(0, 64)}"`,
      );
  }
}

/**
 * Validates transport-received arguments for one operation at the isolated
 * CLI runtime boundary. The runner sends its runner-validated form, which
 * carries the `kind` discriminator; a present `kind` must equal the
 * operation, otherwise the request is refused. Every other argument is
 * re-validated strictly; nothing is trusted.
 */
export function validateTransportGitlabArgs(operation: string, args: unknown): ValidatedGitlabArgs {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    if (record.kind !== undefined) {
      if (record.kind !== operation) {
        throw new GitlabOperationError(
          `GitLab operation mismatch: transport kind "${String(record.kind).slice(0, 64)}" does not match "${String(operation).slice(0, 64)}"`,
        );
      }
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key !== 'kind') rest[key] = value;
      }
      return validateGitlabOperation(operation, rest);
    }
  }
  return validateGitlabOperation(operation, args);
}

/** The project a validated operation addresses (null for group and instance-wide reads). */
export function operationProject(validated: ValidatedGitlabArgs): string | null {
  return 'project' in validated && typeof validated.project === 'string' ? validated.project : null;
}

/**
 * Evidence label of a validated operation's scope: the project, `group:<path>`
 * for a group-scoped list, or `instance` for instance-wide reads.
 */
export function operationScopeLabel(validated: ValidatedGitlabArgs): string {
  const project = operationProject(validated);
  if (project !== null) return project;
  if ('group' in validated && typeof validated.group === 'string')
    return `group:${validated.group}`;
  return 'instance';
}

// --- Operation metadata for registration/descriptions ------------------------

export interface GitlabOperationMeta {
  name: GitlabOperationName;
  description: string;
}

const PROJECT_NOTE =
  'project is a group/name path or numeric project ID on the configured GitLab host.';
const WRITE_NOTE = 'This is a GitLab write: use it only when the user asked for it. Never merge.';
const LIST_SCOPE_NOTE = (filters: string) =>
  `Scope: project, or group (a group/subgroup path or numeric group ID; subgroups included), or neither for the whole instance (then give at least one of ${filters}). People are GitLab usernames (without @).`;
const DATE_NOTE =
  'created_after/created_before/updated_after/updated_before take RFC 3339 timestamps (e.g. 2026-09-01T00:00:00Z).';

export const GITLAB_OPERATION_METADATA: GitlabOperationMeta[] = [
  {
    name: 'get_project',
    description: `Get a project's metadata (ID, path, default branch, URL). ${PROJECT_NOTE}`,
  },
  {
    name: 'list_projects',
    description:
      'List projects the GitLab token can reach (membership), most recently active first (path_with_namespace, last_activity_at). Without a search phrase it returns the first 50: list once and pick from the result instead of guessing project names; with a phrase it filters by name/path.',
  },
  {
    name: 'get_issue',
    description: `Get one issue by IID (title, description, state, labels, URL). ${PROJECT_NOTE}`,
  },
  {
    name: 'list_issues',
    description: `List issues, newest first by default (state opened by default; also closed, all). ${LIST_SCOPE_NOTE(formatList(ISSUE_NARROWING_FILTERS))} Filters: author_username, assignee_username, search, labels, milestone (title, or None/Any), date ranges; order_by created_at, updated_at or due_date, sort asc or desc. Results include author, assignees, milestone and due date. ${DATE_NOTE} ${PROJECT_NOTE}`,
  },
  {
    name: 'get_issue_notes',
    description: `List an issue's notes (IDs, author, body, system-note flag). ${PROJECT_NOTE}`,
  },
  {
    name: 'search',
    description: `Search. With project: scopes issues, merge_requests, blobs, commits inside that project. Without project: instance-wide scopes projects, issues, merge_requests, blobs, commits. An unavailable scope is an explicit unsupported result, never an empty success. Keyword matching only: for merge requests or issues by author, assignee or reviewer use list_merge_requests / list_issues instead. ${PROJECT_NOTE}`,
  },
  {
    name: 'list_branches',
    description: `List a project's branches (optional search). ${PROJECT_NOTE}`,
  },
  {
    name: 'list_merge_requests',
    description: `List merge requests, most recently updated first by default (state opened by default; also closed, merged, all). ${LIST_SCOPE_NOTE(formatList(MR_NARROWING_FILTERS))} Filters: author_username, assignee_username, reviewer_username, search, labels, milestone (title, or None/Any), draft, source_branch, target_branch, date ranges; order_by created_at or updated_at, sort asc or desc. Results include author, assignees, reviewers and merge status. ${DATE_NOTE} ${PROJECT_NOTE}`,
  },
  {
    name: 'get_merge_request',
    description: `Get one merge request (description, head SHA, branches, state, URL). ${PROJECT_NOTE}`,
  },
  {
    name: 'get_merge_request_diffs',
    description: `List a merge request's changed paths and patch data, with truncation indicators. ${PROJECT_NOTE}`,
  },
  {
    name: 'get_merge_request_commits',
    description: `List a merge request's commits (SHA, title, dates). ${PROJECT_NOTE}`,
  },
  {
    name: 'get_merge_request_notes',
    description: `List a merge request's notes (IDs, author, body, system-note flag). ${PROJECT_NOTE}`,
  },
  {
    name: 'list_pipelines',
    description: `List a project's pipelines (optional ref and status filters). ${PROJECT_NOTE}`,
  },
  {
    name: 'get_pipeline',
    description: `Get one pipeline by ID. ${PROJECT_NOTE}`,
  },
  {
    name: 'get_pipeline_jobs',
    description: `List the jobs of one pipeline. ${PROJECT_NOTE}`,
  },
  {
    name: 'get_job',
    description: `Get one job's metadata, durations and failure reason. Use get_job_trace for the log. ${PROJECT_NOTE}`,
  },
  {
    name: 'get_job_trace',
    description: `Read the last 48 KB of one job's log (or the first 48 KB with head: true): test output, timings, retries, runner messages. Always bounded; the response states how much of the trace it holds. The log may contain sensitive output: quote only what the question needs. Find the job with list_pipelines and get_pipeline_jobs first. ${PROJECT_NOTE}`,
  },
  {
    name: 'list_repository_tree',
    description: `List repository tree entries (paths, object IDs, types) at a ref. ${PROJECT_NOTE}`,
  },
  {
    name: 'get_repository_file',
    description: `Read one bounded decoded text file at a ref; binary/oversize content is reported explicitly. ${PROJECT_NOTE}`,
  },
  {
    name: 'get_commit',
    description: `Get one commit's metadata, parents, and message. ${PROJECT_NOTE}`,
  },
  {
    name: 'get_merge_request_pipelines',
    description: `List a merge request's pipelines. ${PROJECT_NOTE}`,
  },
  {
    name: 'create_merge_request_note',
    description: `Comment on a merge request. ${WRITE_NOTE} ${PROJECT_NOTE}`,
  },
  {
    name: 'create_issue_note',
    description: `Comment on an issue. ${WRITE_NOTE} ${PROJECT_NOTE}`,
  },
  {
    name: 'create_issue',
    description: `Create an issue (confidential: true limits it to project members at Reporter and above). ${WRITE_NOTE} ${PROJECT_NOTE}`,
  },
  {
    name: 'update_merge_request',
    description: `Update a merge request's title, description, labels, assignees, reviewers, or close/reopen it. ${WRITE_NOTE} ${PROJECT_NOTE}`,
  },
  {
    name: 'create_merge_request',
    description: `Create a merge request for an existing source branch. For your own code changes use publish instead. ${WRITE_NOTE} ${PROJECT_NOTE}`,
  },
  {
    name: 'retry_job',
    description: `Retry one CI job. Never retried automatically after an unknown outcome. ${WRITE_NOTE} ${PROJECT_NOTE}`,
  },
  {
    name: 'create_pipeline',
    description: `Run a new pipeline for a branch or tag. Never retried automatically after an unknown outcome. ${WRITE_NOTE} ${PROJECT_NOTE}`,
  },
];
