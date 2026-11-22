/**
 * Read-only Slack Web API backend for user lookups and public-channel
 * message search. Trusted code pins the origin (`https://slack.com`), the
 * base path (`/api`), the four Web API methods and their verbs (`GET` with
 * query parameters for `auth.test` (readiness), `users.info` and
 * `users.lookupByEmail`; `POST` with a JSON body for
 * `assistant.search.context`, the Real-time Search API); the workspace's bot
 * token is attached only there, and the triggering mention's `action_token`
 * only to the search body. The model supplies a user ID (or a raw mention),
 * an e-mail address or a search query; it never sees the tokens, URLs,
 * headers or upstream error bodies, and there is no listing, history or
 * posting method. Search is pinned to public channels and messages.
 *
 * The same validators run in the broker (runner) and in the runtime, so a
 * request that reaches Slack was checked twice.
 */
import { createHash } from 'node:crypto';
import { EMAIL } from '../../contracts/tool-kinds.js';
import { flattenMessageContent } from '../../contracts/slack-message-content.js';

export const SLACK_ADAPTER = 'slack-api-v1';
export const SLACK_CONTRACT_VERSION = 'slack-read-v1';
export const SLACK_API_ORIGIN = 'https://slack.com';
export const SLACK_BASE_PATH = '/api';
/** The fixed API endpoint every instance binds to. */
export const SLACK_ENDPOINT = `${SLACK_API_ORIGIN}${SLACK_BASE_PATH}`;
/** Model-facing tool names. */
export const SLACK_GET_USER_TOOL = 'slack_get_user';
export const SLACK_LOOKUP_BY_EMAIL_TOOL = 'slack_lookup_user_by_email';
export const SLACK_SEARCH_TOOL = 'slack_search_messages';
export const SLACK_TOOLS = [
  SLACK_GET_USER_TOOL,
  SLACK_LOOKUP_BY_EMAIL_TOOL,
  SLACK_SEARCH_TOOL,
] as const;
/** The only Web API methods this adapter calls. */
export const SLACK_METHODS = [
  'auth.test',
  'users.info',
  'users.lookupByEmail',
  'assistant.search.context',
] as const;
export type SlackMethod = (typeof SLACK_METHODS)[number];
/** The one verb each method is called with. */
export const SLACK_METHOD_VERBS: Record<SlackMethod, 'GET' | 'POST'> = {
  'auth.test': 'GET',
  'users.info': 'GET',
  'users.lookupByEmail': 'GET',
  'assistant.search.context': 'POST',
};
/** Upstream response bodies above this size fail with output_limit. */
export const SLACK_RESPONSE_MAX_BYTES = 256_000;
export const SLACK_TIMEOUT_MS = 15_000;
/** Scopes: `users:read` for users.info, `users:read.email` for e-mails and lookupByEmail. */
export const SLACK_USERS_SCOPE = 'users:read';
export const SLACK_EMAIL_SCOPE = 'users:read.email';
/** The one search scope requested: public channels only (plan decision 3). */
export const SLACK_SEARCH_SCOPE = 'search:read.public';
/** Search bounds (plan decision 5): Slack's page size, pages per call, query and text caps. */
export const SLACK_SEARCH_PAGE = 20;
export const SLACK_SEARCH_MAX_PAGES = 3;
export const SLACK_SEARCH_MAX_QUERY_CHARS = 512;
export const SLACK_SEARCH_MAX_TEXT_CHARS = 2000;
/** Slack user IDs (the mention grammar). */
export const SLACK_USER_ID = /^[UW][A-Z0-9]{1,31}$/;
export const SLACK_TEAM_ID = /^T[A-Z0-9]{1,31}$/;
export const MAX_EMAIL_CHARS = 254;

export type SlackOperation = 'getUser' | 'lookupByEmail' | 'searchMessages';

export type SlackErrorCategory =
  | 'invalid_auth'
  | 'forbidden_scope'
  | 'action_token_invalid'
  | 'not_found'
  | 'rate_limit'
  | 'timeout'
  | 'invalid_shape'
  | 'upstream_error'
  | 'redirect_refused'
  | 'output_limit'
  | 'network';

/** Fixed model-facing sentences; raw upstream bodies are never returned. */
export const SLACK_ERROR_TEXT: Record<SlackErrorCategory, string> = {
  invalid_auth: "Slack rejected the workspace's bot token (revoked or the app was uninstalled).",
  forbidden_scope:
    'Slack refused the lookup: the bot token lacks the needed scope (users:read / users:read.email).',
  action_token_invalid:
    'Slack message search is no longer available for this turn; ask again in a new message.',
  not_found: 'No Slack user matches in this workspace.',
  rate_limit: 'Slack rate limit reached; do not retry now.',
  timeout: 'The Slack request timed out.',
  invalid_shape: 'Slack returned an unexpected response.',
  upstream_error: 'Slack returned a server error.',
  redirect_refused: 'Slack answered with a redirect, which the bot does not follow.',
  output_limit: 'The Slack response exceeded the size limit.',
  network: 'Slack could not be reached.',
};

/** Search-specific sentences where the lookup wording would mislead. */
const SLACK_SEARCH_ERROR_TEXT: Partial<Record<SlackErrorCategory, string>> = {
  forbidden_scope:
    "Slack refused the message search: the app needs the Agents & AI Apps feature and the search:read.public scope, granted by reinstalling it through the admin's Add to Slack.",
  not_found: 'Slack found no messages.',
};

/** The fixed model-facing sentence of a category for an operation. */
export function slackErrorText(category: SlackErrorCategory, operation?: SlackOperation): string {
  return (
    (operation === 'searchMessages' ? SLACK_SEARCH_ERROR_TEXT[category] : undefined) ??
    SLACK_ERROR_TEXT[category]
  );
}

/** A request refused by the structural validation (the message is model-facing). */
export class SlackRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackRequestError';
  }
}

export function slackToolName(operation: SlackOperation): string {
  return operation === 'getUser'
    ? SLACK_GET_USER_TOOL
    : operation === 'lookupByEmail'
      ? SLACK_LOOKUP_BY_EMAIL_TOOL
      : SLACK_SEARCH_TOOL;
}

// --- Validation -------------------------------------------------------------------

function plainRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new SlackRequestError(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new SlackRequestError(`${tool}: unknown argument ${key.slice(0, 40)}`);
}

/**
 * The raw argument names of a Slack tool call, checked before the SDK
 * parser can strip unknown fields (guard); null when acceptable.
 */
export function slackArgumentProblem(tool: string, input: unknown): string | null {
  const allowed =
    tool === SLACK_GET_USER_TOOL
      ? ['user']
      : tool === SLACK_LOOKUP_BY_EMAIL_TOOL
        ? ['email']
        : tool === SLACK_SEARCH_TOOL
          ? ['query', 'page']
          : null;
  if (allowed === null) return `unknown Slack tool ${tool.slice(0, 40)}`;
  try {
    onlyKeys(plainRecord(input, `${tool} arguments`), allowed, tool);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid arguments';
  }
}

/** A user ID from an ID, `<@U…>` or `<@U…|name>`; throws for anything else. */
export function normalizeSlackUserId(value: unknown): string {
  if (typeof value !== 'string')
    throw new SlackRequestError('user must be a Slack user ID such as U0123456789');
  let raw = value.trim();
  const mention = /^<@([^|>]*)(?:\|[^>]*)?>$/.exec(raw);
  if (mention !== null) raw = mention[1] ?? '';
  if (!SLACK_USER_ID.test(raw))
    throw new SlackRequestError(
      'user must be a Slack user ID such as U0123456789 or a mention such as <@U0123456789>',
    );
  return raw;
}

export function normalizeSlackEmail(value: unknown): string {
  if (typeof value !== 'string') throw new SlackRequestError('email must be an e-mail address');
  const raw = value.trim();
  if (raw.length > MAX_EMAIL_CHARS || !EMAIL.test(raw))
    throw new SlackRequestError('email must be an e-mail address');
  return raw;
}

// eslint-disable-next-line no-control-regex -- control characters are refused in queries
const QUERY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A search query: non-empty, at most 512 characters, no control characters. */
export function normalizeSlackQuery(value: unknown): string {
  if (typeof value !== 'string')
    throw new SlackRequestError('query must be a non-empty search string');
  const raw = value.trim();
  if (raw.length === 0 || raw.length > SLACK_SEARCH_MAX_QUERY_CHARS)
    throw new SlackRequestError(
      `query must be a non-empty search string of at most ${SLACK_SEARCH_MAX_QUERY_CHARS} characters`,
    );
  if (QUERY_CONTROL_CHARACTERS.test(raw))
    throw new SlackRequestError('query must not contain control characters');
  return raw;
}

/** The optional result page, 1 to SLACK_SEARCH_MAX_PAGES (default 1). */
export function normalizeSlackPageArgument(value: unknown): number {
  if (value === undefined) return 1;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > SLACK_SEARCH_MAX_PAGES
  )
    throw new SlackRequestError(`page must be an integer from 1 to ${SLACK_SEARCH_MAX_PAGES}`);
  return value;
}

export type ValidatedSlackRequest =
  | { user: string }
  | { email: string }
  | { query: string; page: number };

/** Validates an operation's arguments (broker and runtime). */
export function validateSlackRequest(
  operation: SlackOperation,
  input: unknown,
): ValidatedSlackRequest {
  const tool = slackToolName(operation);
  const args = plainRecord(input, `${tool} arguments`);
  if (operation === 'getUser') {
    onlyKeys(args, ['user'], tool);
    return { user: normalizeSlackUserId(args.user) };
  }
  if (operation === 'searchMessages') {
    onlyKeys(args, ['query', 'page'], tool);
    return { query: normalizeSlackQuery(args.query), page: normalizeSlackPageArgument(args.page) };
  }
  onlyKeys(args, ['email'], tool);
  return { email: normalizeSlackEmail(args.email) };
}

/**
 * Evidence identity of a lookup argument: a run-salted hash, so the journal
 * never holds the user ID or the e-mail address itself.
 */
export function slackArgumentFingerprint(runId: string, request: ValidatedSlackRequest): string {
  const value =
    'user' in request
      ? `user:${request.user}`
      : 'email' in request
        ? `email:${request.email.toLowerCase()}`
        : `search:${request.page}:${request.query}`;
  return createHash('sha256')
    .update(`support-agent-slack-arg-v1\0${runId}\0${value}`)
    .digest('hex')
    .slice(0, 16);
}

// --- Transport --------------------------------------------------------------------

export type SlackFetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface SlackHttpResult {
  errorCategory?: SlackErrorCategory;
  httpStatus: number | null;
  /** Parsed body of an `ok: true` answer. */
  body: Record<string, unknown> | null;
  /** Granted scopes from `x-oauth-scopes` (null when the header is absent). */
  scopes: string[] | null;
  /** Slack's `error` code of an `ok: false` answer (never model-facing). */
  slackError?: string;
}

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
 * Slack's codes for a rejected search entitlement: a bot token without the
 * Agents & AI Apps feature or an app the method is not available to.
 */
const SLACK_FEATURE_ERRORS = [
  'not_allowed_token_type',
  'feature_not_enabled',
  'not_enabled',
  'access_denied',
  'team_not_eligible',
];

/** Classifies Slack's `error` code of an `ok: false` answer. */
export function classifySlackError(error: string): SlackErrorCategory {
  // Expired or invalid action tokens (no published code list; work order
  // step 1 probes the exact code): any code naming the action token.
  if (/action_token/.test(error)) return 'action_token_invalid';
  if (
    [
      'invalid_auth',
      'not_authed',
      'token_revoked',
      'token_expired',
      'account_inactive',
      'no_permission',
    ].includes(error)
  )
    return 'invalid_auth';
  if (error === 'missing_scope' || SLACK_FEATURE_ERRORS.includes(error)) return 'forbidden_scope';
  if (error === 'user_not_found' || error === 'users_not_found') return 'not_found';
  if (error === 'ratelimited') return 'rate_limit';
  return 'upstream_error';
}

function parseScopes(header: string | null): string[] | null {
  if (header === null) return null;
  return [
    ...new Set(
      header
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => /^[a-z][a-z0-9_.:-]{0,63}$/.test(scope)),
    ),
  ].sort();
}

/** A `GET` with query parameters, or the search method's `POST` with a JSON body. */
export type SlackRequest =
  | { verb: 'GET'; params: Record<string, string> }
  | { verb: 'POST'; body: Record<string, unknown> };

/**
 * The pinned search body: public channels and messages only, Slack's page
 * size, bot and app posts included and their blocks returned:
 * an announcement or alert bot's content lives in blocks, not in `content`.
 */
export function slackSearchBody(
  query: string,
  actionToken: string,
  cursor: string | null,
): Record<string, unknown> {
  return {
    query,
    action_token: actionToken,
    channel_types: ['public_channel'],
    content_types: ['messages'],
    include_bots: true,
    include_message_blocks: true,
    limit: SLACK_SEARCH_PAGE,
    ...(cursor !== null ? { cursor } : {}),
  };
}

/**
 * The only way a request reaches Slack: the pinned origin over HTTPS, one of
 * the four methods with its pinned verb (`GET` with query parameters, or the
 * search method's `POST` with a JSON body), the bearer token attached here
 * and nowhere else, redirects refused, the body capped. No retries (a rate
 * limit is refused, never waited out).
 */
export async function sendSlackRequest(
  method: SlackMethod,
  request: SlackRequest,
  token: string,
  options: {
    timeoutMs: number;
    maxBytes?: number;
    signal?: AbortSignal;
    fetchImpl?: SlackFetch;
  },
): Promise<SlackHttpResult> {
  if (
    !(SLACK_METHODS as readonly string[]).includes(method) ||
    SLACK_METHOD_VERBS[method] !== request.verb
  )
    throw new Error('Slack request outside the pinned read-only API surface');
  const url = new URL(`${SLACK_BASE_PATH}/${method}`, SLACK_API_ORIGIN);
  if (request.verb === 'GET')
    for (const [key, value] of Object.entries(request.params)) url.searchParams.set(key, value);
  if (url.protocol !== 'https:' || url.origin !== SLACK_API_ORIGIN)
    throw new Error('Slack request outside the pinned read-only API surface');
  const timeout = AbortSignal.timeout(Math.min(options.timeoutMs, SLACK_TIMEOUT_MS));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(
      url,
      request.verb === 'GET'
        ? {
            method: 'GET',
            redirect: 'manual',
            signal,
            headers: { accept: 'application/json', authorization: `Bearer ${token}` },
          }
        : {
            method: 'POST',
            redirect: 'manual',
            signal,
            headers: {
              accept: 'application/json',
              'content-type': 'application/json; charset=utf-8',
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(request.body),
          },
    );
  } catch {
    return {
      errorCategory: signal.aborted ? 'timeout' : 'network',
      httpStatus: null,
      body: null,
      scopes: null,
    };
  }
  const scopes = parseScopes(response.headers.get('x-oauth-scopes'));
  const fail = (errorCategory: SlackErrorCategory, slackError?: string): SlackHttpResult => ({
    errorCategory,
    httpStatus: response.status,
    body: null,
    scopes,
    ...(slackError !== undefined ? { slackError } : {}),
  });
  if (response.status === 0 || response.type === 'opaqueredirect') {
    await response.body?.cancel().catch(() => {});
    return fail('redirect_refused');
  }
  let text: { text: string; truncated: boolean };
  try {
    text = await readCapped(response, options.maxBytes ?? SLACK_RESPONSE_MAX_BYTES);
  } catch {
    return fail(signal.aborted ? 'timeout' : 'network');
  }
  if (response.status >= 300 && response.status < 400) return fail('redirect_refused');
  if (response.status === 429) return fail('rate_limit');
  if (response.status >= 500) return fail('upstream_error');
  if (response.status < 200 || response.status >= 300) return fail('invalid_shape');
  if (text.truncated) return fail('output_limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return fail('invalid_shape');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return fail('invalid_shape');
  const body = parsed as Record<string, unknown>;
  if (body.ok !== true) {
    const error = typeof body.error === 'string' ? body.error.slice(0, 64) : 'unknown';
    return fail(classifySlackError(error), error);
  }
  return { httpStatus: response.status, body, scopes };
}

// --- Results ----------------------------------------------------------------------

/** The bounded profile the model sees; nothing else of Slack's user object. */
export interface SlackUserProfile {
  id: string;
  name: string | null;
  realName: string | null;
  displayName: string | null;
  title: string | null;
  /** Null when the bot token lacks `users:read.email` (Slack omits it). */
  email: string | null;
  timeZone: string | null;
  isBot: boolean;
  isDeleted: boolean;
  /** Guest account (single- or multi-channel). */
  isRestricted: boolean;
  isAdmin: boolean;
}

// eslint-disable-next-line no-control-regex -- strips control characters from upstream text
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

function field(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, max);
  return text.length === 0 ? null : text;
}

/** Normalizes Slack's user object into the bounded profile; null when malformed. */
export function normalizeSlackUser(raw: unknown): SlackUserProfile | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const user = raw as Record<string, unknown>;
  const id = typeof user.id === 'string' ? user.id : '';
  if (!SLACK_USER_ID.test(id)) return null;
  const profile =
    user.profile !== null && typeof user.profile === 'object' && !Array.isArray(user.profile)
      ? (user.profile as Record<string, unknown>)
      : {};
  return {
    id,
    name: field(user.name, 128),
    realName: field(profile.real_name ?? user.real_name),
    displayName: field(profile.display_name),
    title: field(profile.title),
    email: field(profile.email, MAX_EMAIL_CHARS),
    timeZone: field(user.tz, 64),
    isBot: user.is_bot === true || user.id === 'USLACKBOT',
    isDeleted: user.deleted === true,
    isRestricted: user.is_restricted === true || user.is_ultra_restricted === true,
    isAdmin: user.is_admin === true || user.is_owner === true,
  };
}

export interface SlackCallResult {
  status: 'completed' | 'failed' | 'timed_out' | 'not_run';
  output: string;
  errorCategory?: SlackErrorCategory;
  truncated?: boolean;
  /** Bytes of the model-facing output. */
  bytes?: number;
  refused?: string;
  /** Message search: Slack requests made and messages returned. */
  pages?: number;
  resultCount?: number;
  /** Message search: returned messages whose content stayed unreadable. */
  emptyHits?: number;
}

export function slackFailure(
  operation: SlackOperation,
  category: SlackErrorCategory,
  extra: Pick<SlackCallResult, 'pages'> = {},
): SlackCallResult {
  const output = `${slackToolName(operation)}: ${category}: ${slackErrorText(category, operation)}`;
  return {
    status: category === 'timeout' ? 'timed_out' : 'failed',
    errorCategory: category,
    output,
    bytes: Buffer.byteLength(output),
    ...extra,
  };
}

/** Turns a users.info / users.lookupByEmail answer into the model-facing result. */
export function normalizeSlackUserResult(
  operation: SlackOperation,
  http: SlackHttpResult,
  options: { maxOutputBytes: number },
): SlackCallResult {
  if (http.errorCategory) return slackFailure(operation, http.errorCategory);
  const user = normalizeSlackUser(http.body?.user);
  if (user === null) return slackFailure(operation, 'invalid_shape');
  const output = JSON.stringify({ user });
  if (Buffer.byteLength(output) > Math.max(256, options.maxOutputBytes))
    return slackFailure(operation, 'output_limit');
  return { status: 'completed', output, bytes: Buffer.byteLength(output) };
}

/** One message as the model sees it; nothing else of Slack's result object. */
export interface SlackSearchMessage {
  channel: string | null;
  channelId: string;
  author: string | null;
  authorId: string | null;
  isAuthorBot: boolean;
  /** ISO 8601 time of the message. */
  date: string;
  /**
   * Slack's `content` merged with the message's blocks and attachments
   * (bot and app posts), deduplicated, capped at SLACK_SEARCH_MAX_TEXT_CHARS.
   */
  text: string;
  /** Only an https permalink on the workspace's slack.com host, else null. */
  permalink: string | null;
  /** Set when the message exists but search returned none of its content. */
  contentUnavailable?: true;
}

/** The model-facing search answer (decision 6). */
export interface SlackSearchResult {
  messages: SlackSearchMessage[];
  page: number;
  nextPage: number | null;
  /** A message text was capped or messages were dropped for the output bound. */
  truncated: boolean;
}

/** Control characters stripped from a hit's text; line breaks between blocks stay. */
// eslint-disable-next-line no-control-regex -- strips control characters from upstream text
const TEXT_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f]+/g;
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{1,31}$/;
const SLACK_MESSAGE_TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;

/**
 * A permalink the model may see: https, on `workspaceHost` when auth.test
 * named one, else on any `*.slack.com` host.
 */
export function slackPermalink(value: unknown, workspaceHost: string | null): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !host.endsWith('.slack.com') ||
    (workspaceHost !== null && host !== workspaceHost)
  )
    return null;
  return url.toString();
}

/**
 * Normalizes one `results.messages[]` entry; null when malformed. The text
 * is the shared flattener's reading of `content`, `blocks` and `attachments`
 * (the same as thread context): a person's text mirrored in a rich-text
 * block counts once (the mirror is skipped), a bot post built from blocks or
 * attachments reads as its header, sections, fields and context. A hit whose `content` is not a
 * string, or is absent without blocks or attachments, is malformed; one
 * whose flattened text is empty keeps `text: ""` and is marked
 * `contentUnavailable`.
 */
export function normalizeSlackSearchMessage(
  raw: unknown,
  workspaceHost: string | null,
): { message: SlackSearchMessage; capped: boolean } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const channelId = typeof entry.channel_id === 'string' ? entry.channel_id : '';
  const ts = typeof entry.message_ts === 'string' ? entry.message_ts : '';
  if (!SLACK_CHANNEL_ID.test(channelId) || !SLACK_MESSAGE_TS.test(ts)) return null;
  // `content` may be absent for a post built from blocks or attachments only.
  const content = entry.content ?? null;
  const hasParts = Array.isArray(entry.blocks) || Array.isArray(entry.attachments);
  if (content !== null && typeof content !== 'string') return null;
  if (content === null && !hasParts) return null;
  const seconds = Number(ts);
  const date = new Date(Math.floor(seconds * 1000));
  if (!Number.isFinite(seconds) || Number.isNaN(date.getTime())) return null;
  // A person's message: `content` is its text and the rich-text block only
  // Slack's mirror of it, with mentions rendered differently, so the
  // flattener's comparison could not drop it. Bot posts keep every block.
  const mirrorOnly =
    entry.is_author_bot !== true && typeof content === 'string' && content.trim().length > 0;
  const blocks =
    mirrorOnly && Array.isArray(entry.blocks)
      ? entry.blocks.filter(
          (block) =>
            !(
              block !== null &&
              typeof block === 'object' &&
              'type' in block &&
              block.type === 'rich_text'
            ),
        )
      : entry.blocks;
  const clean = flattenMessageContent({ text: content, blocks, attachments: entry.attachments })
    .replace(TEXT_CONTROL_CHARACTERS, ' ')
    .trim();
  const capped = clean.length > SLACK_SEARCH_MAX_TEXT_CHARS;
  const authorId = typeof entry.author_user_id === 'string' ? entry.author_user_id : '';
  return {
    message: {
      channel: field(entry.channel_name, 128),
      channelId,
      author: field(entry.author_name, 128),
      authorId: SLACK_USER_ID.test(authorId) ? authorId : null,
      isAuthorBot: entry.is_author_bot === true,
      date: date.toISOString(),
      text: capped ? `${clean.slice(0, SLACK_SEARCH_MAX_TEXT_CHARS - 1)}…` : clean,
      permalink: slackPermalink(entry.permalink, workspaceHost),
      ...(clean.length === 0 ? { contentUnavailable: true as const } : {}),
    },
    capped,
  };
}

/**
 * One `assistant.search.context` answer: its well-formed messages (channel,
 * author, ISO date, flattened and capped text, filtered permalink) and
 * Slack's next cursor (null when done); null when the answer is malformed.
 * Blocks and attachments reach the model only as that text; nothing else of
 * Slack's result objects (context messages, profiles) is kept.
 */
export function normalizeSlackSearchResult(
  http: SlackHttpResult,
  workspaceHost: string | null,
): { messages: SlackSearchMessage[]; capped: boolean; nextCursor: string | null } | null {
  const results = http.body?.results;
  if (results === null || typeof results !== 'object' || Array.isArray(results)) return null;
  const raw = (results as Record<string, unknown>).messages;
  if (!Array.isArray(raw)) return null;
  const messages: SlackSearchMessage[] = [];
  let capped = false;
  for (const entry of raw.slice(0, SLACK_SEARCH_PAGE * 2)) {
    const normalized = normalizeSlackSearchMessage(entry, workspaceHost);
    if (normalized === null) continue;
    messages.push(normalized.message);
    capped ||= normalized.capped;
  }
  const meta = http.body?.response_metadata;
  const cursor =
    meta !== null && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).next_cursor
      : undefined;
  return {
    messages,
    capped,
    nextCursor:
      typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 1024 ? cursor : null,
  };
}

/**
 * The model-facing search output for one page: messages are dropped from
 * the end (and `truncated` set) until the JSON fits the output bound.
 */
export function slackSearchOutput(
  result: SlackSearchResult,
  maxOutputBytes: number,
): { output: string; result: SlackSearchResult } {
  const bound = Math.max(256, maxOutputBytes);
  const shaped = { ...result, messages: [...result.messages] };
  let output = JSON.stringify(shaped);
  while (Buffer.byteLength(output) > bound && shaped.messages.length > 0) {
    shaped.messages.pop();
    shaped.truncated = true;
    output = JSON.stringify(shaped);
  }
  return { output, result: shaped };
}

// --- Identity ---------------------------------------------------------------------

/** Stable, non-reversible token identity (changes only when the token is rotated). */
export function slackCredentialFingerprint(token: string): string {
  return createHash('sha256').update(`support-agent-slack-v1\0${token}`).digest('hex').slice(0, 16);
}
