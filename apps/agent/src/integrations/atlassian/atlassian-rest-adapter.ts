/**
 * Scoped read-only Atlassian REST backend. Trusted code builds every request:
 * fixed origin, fixed GET paths, per-product credential routing. The model
 * supplies only validated operation arguments and never sees upstream error
 * bodies, URLs or headers.
 */
import {
  CONTINUATION_PATTERN,
  ISSUE_KEY_PATTERN,
  PAGE_ID_PATTERN,
  type AtlassianProduct,
  type ValidatedAtlassianArgs,
} from './atlassian-operations.js';

export const ATLASSIAN_API_ORIGIN = 'https://api.atlassian.com';
export const ATLASSIAN_RESPONSE_MAX_BYTES = 2_000_000;
export const CLOUD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JIRA_ISSUE_FIELDS = 'summary,issuetype,status,assignee,description,labels,project,updated';
const JIRA_SEARCH_FIELDS = 'summary,issuetype,status,assignee,updated';
/**
 * Full-text search keeps Jira's relevance order (no ORDER BY). Designated
 * qualification compares it with `ORDER BY updated DESC` on the fixture phrase
 * and real questions against the designated test site.
 */
export const JIRA_TEXT_SEARCH_ORDER = '';

export interface AtlassianRestRequest {
  product: AtlassianProduct;
  method: 'GET';
  url: URL;
}

function productUrl(
  product: AtlassianProduct,
  cloudId: string,
  path: string,
  query: Record<string, string | number | undefined> = {},
): AtlassianRestRequest {
  if (!CLOUD_ID_PATTERN.test(cloudId)) throw new Error('invalid Atlassian cloud ID');
  const url = new URL(`/ex/${product}/${cloudId}${path}`, ATLASSIAN_API_ORIGIN);
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) url.searchParams.set(key, String(value));
  return { product, method: 'GET', url };
}

export function buildJiraTextJql(query: string, projectKey?: string): string {
  // `query` is already sanitized (no quotes/backslashes); `projectKey` is pattern-bound.
  let jql = `text ~ "${query}"`;
  if (projectKey) jql += ` AND project = "${projectKey}"`;
  return JIRA_TEXT_SEARCH_ORDER ? `${jql} ${JIRA_TEXT_SEARCH_ORDER}` : jql;
}
export function buildConfluenceCql(query: string, spaceKey?: string): string {
  let cql = `siteSearch ~ "${query}" AND type = page`;
  if (spaceKey) cql += ` AND space = "${spaceKey}"`;
  return cql;
}

/** The only request builder for model-initiated reads: one fixed GET per operation. */
export function buildAtlassianRequest(
  args: ValidatedAtlassianArgs,
  cloudId: string,
): AtlassianRestRequest {
  switch (args.kind) {
    case 'searchJiraIssues':
    case 'searchJiraIssuesUsingJql':
      return productUrl('jira', cloudId, '/rest/api/3/search/jql', {
        jql:
          args.kind === 'searchJiraIssues'
            ? buildJiraTextJql(args.query, args.projectKey)
            : args.jql,
        maxResults: args.maxResults,
        fields: JIRA_SEARCH_FIELDS,
        nextPageToken: args.nextPageToken,
      });
    case 'getJiraIssue':
      return productUrl('jira', cloudId, `/rest/api/3/issue/${args.issueKey}`, {
        fields: JIRA_ISSUE_FIELDS,
      });
    case 'listJiraIssueComments':
      return productUrl('jira', cloudId, `/rest/api/3/issue/${args.issueKey}/comment`, {
        orderBy: 'created',
        maxResults: args.maxResults,
        startAt: args.startAt,
      });
    case 'listJiraProjects':
      return productUrl('jira', cloudId, '/rest/api/3/project/search', {
        maxResults: args.maxResults,
        startAt: args.startAt,
      });
    case 'searchConfluencePages':
      return productUrl('confluence', cloudId, '/wiki/rest/api/search', {
        cql: buildConfluenceCql(args.query, args.spaceKey),
        limit: args.maxResults,
        cursor: args.cursor,
      });
    case 'getConfluencePage':
      return productUrl('confluence', cloudId, `/wiki/api/v2/pages/${args.pageId}`, {
        'body-format': 'storage',
      });
  }
}

export type AtlassianReadinessProbe = 'jiraServerInfo' | 'jiraMyself' | 'confluenceSpaces';
export function buildReadinessRequest(
  probe: AtlassianReadinessProbe,
  cloudId: string,
): AtlassianRestRequest {
  switch (probe) {
    case 'jiraServerInfo':
      return productUrl('jira', cloudId, '/rest/api/3/serverInfo');
    case 'jiraMyself':
      return productUrl('jira', cloudId, '/rest/api/3/myself');
    case 'confluenceSpaces':
      return productUrl('confluence', cloudId, '/wiki/api/v2/spaces', { limit: 1 });
  }
}

export type AtlassianErrorCategory =
  | 'invalid_auth'
  | 'insufficient_scope'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'invalid_request'
  | 'redirect_refused'
  | 'upstream_error'
  | 'timeout'
  | 'network'
  | 'invalid_json'
  | 'invalid_shape'
  | 'output_limit'
  | 'site_mismatch';

/** Fixed model-facing sentences; raw upstream bodies are never returned on failure. */
export const ATLASSIAN_ERROR_TEXT: Record<AtlassianErrorCategory, string> = {
  invalid_auth: 'Atlassian rejected the bot credential (wrong, expired or revoked token).',
  insufficient_scope: 'The bot token lacks the scope this read needs.',
  forbidden: 'The bot account is not allowed to read this resource.',
  not_found: 'The resource does not exist or is not visible to the bot account.',
  rate_limit: 'Atlassian rate limit reached; wait before trying again.',
  invalid_request: 'Atlassian rejected the request (check the JQL or the arguments).',
  redirect_refused: 'Atlassian answered with a redirect, which the bot does not follow.',
  upstream_error: 'Atlassian returned a server error.',
  timeout: 'The Atlassian request timed out.',
  network: 'Atlassian could not be reached.',
  invalid_json: 'Atlassian returned a response that is not JSON.',
  invalid_shape: 'Atlassian returned an unexpected response shape.',
  output_limit: 'The Atlassian response exceeded the size limit.',
  site_mismatch: 'The configured cloud ID does not belong to the configured site.',
};

/** Classifies an HTTP answer from status and Atlassian's JSON error text. */
export function classifyAtlassianHttp(status: number, body: string): AtlassianErrorCategory | null {
  if (status >= 200 && status < 300) return null;
  const scope = /scope does not match/i.test(body);
  if (status >= 300 && status < 400) return 'redirect_refused';
  if (status === 401) return scope ? 'insufficient_scope' : 'invalid_auth';
  if (status === 403) return scope ? 'insufficient_scope' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'upstream_error';
}

export interface AtlassianHttpResult {
  /** Present when the request produced a classified failure. */
  errorCategory?: AtlassianErrorCategory;
  httpStatus: number | null;
  body: string;
  retryAfter?: string;
}

export interface AtlassianCredential {
  email: string;
  token: string;
}
export type AtlassianFetch = (input: URL, init: RequestInit) => Promise<Response>;

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { text: '', truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

/**
 * Issues one trusted GET. The credential is attached only when the request
 * targets the fixed origin under the product's own `/ex/{product}/` prefix.
 * Redirects are never followed; no retries.
 */
export async function sendAtlassianRequest(
  request: AtlassianRestRequest,
  credentials: Partial<Record<AtlassianProduct, AtlassianCredential>>,
  options: {
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
    fetchImpl?: AtlassianFetch;
  },
): Promise<AtlassianHttpResult> {
  const credential = credentials[request.product];
  if (
    request.method !== 'GET' ||
    request.url.origin !== ATLASSIAN_API_ORIGIN ||
    !request.url.pathname.startsWith(`/ex/${request.product}/`) ||
    request.url.username ||
    request.url.password ||
    !credential
  )
    throw new Error('Atlassian request outside the trusted origin or credential route');
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${credential.email}:${credential.token}`).toString('base64')}`,
      },
    });
  } catch {
    return { errorCategory: signal.aborted ? 'timeout' : 'network', httpStatus: null, body: '' };
  }
  let body: { text: string; truncated: boolean };
  try {
    body = await readCapped(response, options.maxBytes);
  } catch {
    return {
      errorCategory: signal.aborted ? 'timeout' : 'network',
      httpStatus: response.status,
      body: '',
    };
  }
  // A manual redirect surfaces as status 3xx (or an opaque status 0 response).
  const category =
    response.status === 0 || response.type === 'opaqueredirect'
      ? 'redirect_refused'
      : classifyAtlassianHttp(response.status, body.text);
  if (category) {
    const retryAfter = response.headers.get('retry-after') ?? '';
    return {
      errorCategory: category,
      httpStatus: response.status,
      body: '',
      ...(category === 'rate_limit' && /^[0-9]{1,6}$/.test(retryAfter) ? { retryAfter } : {}),
    };
  }
  if (body.truncated)
    return { errorCategory: 'output_limit', httpStatus: response.status, body: '' };
  return { httpStatus: response.status, body: body.text };
}

export interface AtlassianResult {
  status: 'completed' | 'failed' | 'timed_out' | 'not_run';
  output: string;
  errorCategory?: string;
  truncated?: boolean;
  refused?: string;
}

const TEXT_CUT = ' […truncated]';
const OUTPUT_CUT = '\n[truncated: Atlassian result exceeded the output limit]';

interface AtlassianPage {
  items: unknown[];
  project(items: unknown[], omitted: number): Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};
function markupToText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .split(/<!\[CDATA\[([\s\S]*?)\]\]>/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/<[^>]*>/g, ' ')
            .replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity),
    )
    .join('');
}
function adfInlineText(node: Record<string, unknown>): string | null {
  const attrs = record(node.attrs);
  if (!attrs) return null;
  const string = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  switch (node.type) {
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return string(attrs.url);
    case 'mention':
    case 'status':
      return string(attrs.text);
    case 'emoji':
      return string(attrs.text) ?? string(attrs.shortName);
    case 'date': {
      const time = new Date(Number(attrs.timestamp));
      return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10);
    }
    default:
      return null;
  }
}
/** Bounded ADF/storage extraction: no HTML execution, URL resolution or external fetch. */
export function extractAtlassianText(
  value: unknown,
  max = 4000,
): { text: string; truncated: boolean } {
  let text = '';
  let visited = 0;
  let truncated = false;
  const add = (part: string): void => {
    if (text.length + part.length > max) truncated = true;
    text += part.slice(0, Math.max(0, max - text.length));
  };
  const walk = (node: unknown, depth: number): void => {
    if (++visited > 2000 || depth > 32 || text.length >= max) {
      truncated = true;
      return;
    }
    if (typeof node === 'string') {
      add(markupToText(node));
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      add(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (text.length >= max) {
          truncated = true;
          break;
        }
        walk(item, depth + 1);
      }
      return;
    }
    const obj = record(node);
    if (!obj) return;
    const inline = adfInlineText(obj);
    if (inline !== null) add(inline);
    else if (typeof obj.text === 'string') walk(obj.text, depth + 1);
    else if (obj.content !== undefined) walk(obj.content, depth + 1);
    else if (obj.storage !== undefined) walk(obj.storage, depth + 1);
    else if (obj.value !== undefined) walk(obj.value, depth + 1);
    if (
      obj.type === 'paragraph' ||
      obj.type === 'hardBreak' ||
      obj.type === 'heading' ||
      obj.type === 'blockCard' ||
      obj.type === 'embedCard'
    )
      add('\n');
  };
  walk(value, 0);
  return { text: text.trim(), truncated };
}
/** Confluence search excerpts carry `@@@hl@@@…@@@endhl@@@` highlight markers and HTML. */
export function plainExcerpt(value: unknown, max = 300): string {
  if (typeof value !== 'string') return '';
  return markupToText(value.replace(/@@@(?:end)?hl@@@/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function failure(
  args: ValidatedAtlassianArgs,
  category: AtlassianErrorCategory,
  retryAfter?: string,
): AtlassianResult {
  const hint = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
  return {
    status: category === 'timeout' ? 'timed_out' : 'failed',
    errorCategory: category,
    output: `${args.kind}: ${category}: ${ATLASSIAN_ERROR_TEXT[category]}${hint}`,
  };
}
function continuation(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && CONTINUATION_PATTERN.test(value) ? value : undefined;
}
function confluenceCursor(next: unknown): string | null | undefined {
  if (next === undefined || next === null) return null;
  if (typeof next !== 'string') return undefined;
  try {
    return continuation(new URL(next, 'https://confluence.invalid').searchParams.get('cursor'));
  } catch {
    return undefined;
  }
}
function nextStartAt(
  startAt: number,
  returned: number,
  total: unknown,
  isLast: unknown,
): number | null {
  if (isLast === true || returned === 0) return null;
  if (typeof total === 'number' && startAt + returned >= total) return null;
  return startAt + returned;
}

/** Normalizes one successful HTTP answer into the bounded model projection. */
export function normalizeAtlassianResponse(
  args: ValidatedAtlassianArgs,
  http: AtlassianHttpResult,
  site: string,
  maxOutputBytes = 12000,
): AtlassianResult {
  if (http.errorCategory) return failure(args, http.errorCategory, http.retryAfter);
  let data: unknown;
  try {
    data = JSON.parse(http.body);
  } catch {
    return failure(args, 'invalid_json');
  }
  const root = record(data);
  if (!root) return failure(args, 'invalid_shape');
  let textTruncated = false;
  const extract = (v: unknown, max = 4000): { text: string; truncated: boolean } => {
    const out = extractAtlassianText(v, max);
    textTruncated ||= out.truncated;
    return out;
  };
  const text = (v: unknown, max = 4000): string => extract(v, max).text;
  const marked = (value: { text: string; truncated: boolean }): string =>
    value.truncated ? `${value.text}${TEXT_CUT}` : value.text;
  const jiraUrl = (key: string): string => `https://${site}/browse/${key}`;
  const pageUrl = (id: string): string => `https://${site}/wiki/pages/viewpage.action?pageId=${id}`;
  const validId = (value: unknown): boolean =>
    (typeof value === 'string' || typeof value === 'number') && PAGE_ID_PATTERN.test(String(value));
  const issueHit = (item: Record<string, unknown>): Record<string, unknown> => {
    const fields = record(item.fields) ?? {};
    return {
      key: item.key,
      summary: text(fields.summary, 500),
      status: text(record(fields.status)?.name, 120),
      type: text(record(fields.issuetype)?.name, 120),
      assignee: text(record(fields.assignee)?.displayName, 120) || null,
      updated: text(fields.updated, 64),
      url: jiraUrl(String(item.key)),
    };
  };
  const tokenPage =
    (key: 'nextPageToken' | 'cursor', value: string | null) =>
    (items: unknown[], omitted: number): Record<string, unknown> => ({
      returnedCount: items.length,
      [key]: omitted > 0 ? null : value,
      ...(omitted > 0
        ? {
            truncated: true,
            omittedCount: omitted,
            continueWith: `repeat this call unchanged except maxResults: ${items.length}, then continue with the ${key} it returns`,
          }
        : {}),
      items,
    });
  let projection: Record<string, unknown> = {};
  let page: AtlassianPage | null = null;
  let body: { key: 'description' | 'body'; text: string } | null = null;
  switch (args.kind) {
    case 'searchJiraIssues':
    case 'searchJiraIssuesUsingJql': {
      const issues = root.issues;
      if (
        !Array.isArray(issues) ||
        issues.length > args.maxResults ||
        issues.some((item) => {
          const obj = record(item);
          return (
            !obj ||
            typeof obj.key !== 'string' ||
            !ISSUE_KEY_PATTERN.test(obj.key) ||
            !record(obj.fields)
          );
        })
      )
        return failure(args, 'invalid_shape');
      const token = root.isLast === true ? null : continuation(root.nextPageToken);
      if (token === undefined) return failure(args, 'invalid_shape');
      page = {
        items: issues.map((item) => issueHit(item as Record<string, unknown>)),
        project: tokenPage('nextPageToken', token),
      };
      break;
    }
    case 'getJiraIssue': {
      const fields = record(root.fields);
      if (typeof root.key !== 'string' || !ISSUE_KEY_PATTERN.test(root.key) || !fields)
        return failure(args, 'invalid_shape');
      const description = extract(fields.description, 4000);
      projection = {
        key: root.key,
        summary: text(fields.summary, 500),
        type: text(record(fields.issuetype)?.name, 120),
        status: text(record(fields.status)?.name, 120),
        project: text(record(fields.project)?.key, 64),
        assignee: text(record(fields.assignee)?.displayName, 120) || null,
        labels: Array.isArray(fields.labels)
          ? fields.labels.slice(0, 20).map((v) => text(v, 120))
          : [],
        updated: text(fields.updated, 64),
        description: marked(description),
        url: jiraUrl(root.key),
      };
      body = { key: 'description', text: description.text };
      break;
    }
    case 'listJiraIssueComments':
    case 'listJiraProjects': {
      const comments = args.kind === 'listJiraIssueComments';
      const items = comments ? root.comments : root.values;
      if (
        !Array.isArray(items) ||
        items.length > args.maxResults ||
        items.some((item) => {
          const obj = record(item);
          if (!obj || !validId(obj.id)) return true;
          return comments
            ? typeof obj.body !== 'string' && !record(obj.body)
            : typeof obj.key !== 'string' || !obj.key || typeof obj.name !== 'string';
        })
      )
        return failure(args, 'invalid_shape');
      const { startAt } = args;
      const total = typeof root.total === 'number' ? root.total : null;
      const next = nextStartAt(startAt, items.length, root.total, root.isLast);
      page = {
        items: items.map((item) => {
          const obj = item as Record<string, unknown>;
          return comments
            ? {
                id: String(obj.id),
                author: text(record(obj.author)?.displayName, 120),
                created: text(obj.created, 64),
                body: marked(extract(obj.body, 2000)),
              }
            : { key: text(obj.key, 64), name: text(obj.name, 500) };
        }),
        project: (kept, omitted) => ({
          startAt,
          returnedCount: kept.length,
          total,
          nextStartAt: omitted > 0 ? startAt + kept.length : next,
          ...(omitted > 0 ? { truncated: true, omittedCount: omitted } : {}),
          items: kept,
        }),
      };
      break;
    }
    case 'searchConfluencePages': {
      const results = root.results;
      if (
        !Array.isArray(results) ||
        results.length > args.maxResults ||
        results.some((item) => {
          const content = record(record(item)?.content);
          return !content || !validId(content.id) || typeof content.title !== 'string';
        })
      )
        return failure(args, 'invalid_shape');
      const cursor = confluenceCursor(record(root._links)?.next);
      if (cursor === undefined) return failure(args, 'invalid_shape');
      page = {
        items: results.map((item) => {
          const obj = item as Record<string, unknown>;
          const content = obj.content as Record<string, unknown>;
          const space = record(content.space);
          const container = record(obj.resultGlobalContainer);
          const containerKey =
            typeof container?.displayUrl === 'string'
              ? /^\/spaces\/(~?[A-Za-z0-9_-]{1,255})(?:\/|$)/.exec(container.displayUrl)?.[1]
              : undefined;
          const id = String(content.id);
          return {
            pageId: id,
            title: text(content.title, 500),
            spaceKey: text(space?.key ?? containerKey, 255) || null,
            spaceName: text(space?.name ?? container?.title, 255) || null,
            excerpt: plainExcerpt(obj.excerpt),
            lastModified: text(obj.lastModified, 64) || null,
            url: pageUrl(id),
          };
        }),
        project: tokenPage('cursor', cursor),
      };
      break;
    }
    case 'getConfluencePage': {
      if (String(root.id) !== args.pageId || typeof root.title !== 'string')
        return failure(args, 'invalid_shape');
      const content = extract(record(root.body)?.storage ?? root.body, 4000);
      projection = {
        pageId: args.pageId,
        title: text(root.title, 500),
        status: text(root.status, 120),
        spaceId: validId(root.spaceId) ? String(root.spaceId) : null,
        body: marked(content),
        url: pageUrl(args.pageId),
      };
      body = { key: 'body', text: content.text };
      break;
    }
  }
  const bound = Math.max(1, Math.min(maxOutputBytes, 12000));
  const render = (value: unknown): string => `${args.kind}: ${JSON.stringify(value)}`;
  const fits = (value: string): boolean => Buffer.byteLength(value) <= bound;
  let output: string;
  if (page !== null) {
    const { items, project } = page;
    const keeping = (kept: number) => render(project(items.slice(0, kept), items.length - kept));
    output = keeping(items.length);
    if (!fits(output) && items.length > 1) {
      let low = 1;
      let high = items.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(keeping(mid))) low = mid;
        else high = mid - 1;
      }
      output = keeping(low);
      textTruncated = true;
    }
  } else {
    output = render(projection);
    let rest = body?.text ?? '';
    while (body !== null && !fits(output) && rest.length > 0) {
      const excess = Buffer.byteLength(output) - bound;
      rest = rest
        .slice(0, Math.max(0, rest.length - Math.max(64, excess)))
        .replace(/[\uD800-\uDBFF]$/, '');
      projection[body.key] = `${rest}${TEXT_CUT}`;
      textTruncated = true;
      output = render(projection);
    }
  }
  if (!fits(output)) {
    textTruncated = true;
    const marker = Buffer.byteLength(OUTPUT_CUT) < bound ? OUTPUT_CUT : '';
    const room = bound - Buffer.byteLength(marker);
    output = Buffer.from(output).subarray(0, room).toString('utf8');
    while (Buffer.byteLength(output) > room) output = output.slice(0, -1);
    output += marker;
  }
  return { status: 'completed', output, truncated: textTruncated };
}
