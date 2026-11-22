/**
 * Read-only Cloudflare REST and GraphQL Analytics API backend. Trusted code
 * pins the origin (`https://api.cloudflare.com`), the base path
 * (`/client/v4`), the method (`GET` for REST, `POST` only for `/graphql`) and
 * the GraphQL operation type (a single `query`); the bearer token is attached
 * only there. The model supplies a REST path under `/zones`, `/accounts` or
 * the token verify endpoints, or one GraphQL query document; it never sees
 * upstream URLs, headers or HTTP error bodies.
 *
 * The same validators run in the broker (runner) and in the runtime, so a
 * request that reaches Cloudflare was checked twice; the read-only token is
 * the third bound.
 */
import { createHash } from 'node:crypto';

export const CLOUDFLARE_ADAPTER = 'cloudflare-api-v1';
export const CLOUDFLARE_CONTRACT_VERSION = 'cloudflare-read-v1';
export const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
export const CLOUDFLARE_BASE_PATH = '/client/v4';
/** The fixed API endpoint every instance binds to. */
export const CLOUDFLARE_ENDPOINT = `${CLOUDFLARE_API_ORIGIN}${CLOUDFLARE_BASE_PATH}`;
/** Model-facing tool names. */
export const CLOUDFLARE_GRAPHQL_TOOL = 'cloudflare_graphql';
export const CLOUDFLARE_GET_TOOL = 'cloudflare_get';
export const CLOUDFLARE_TOOLS = [CLOUDFLARE_GRAPHQL_TOOL, CLOUDFLARE_GET_TOOL] as const;
/** Upstream response bodies above this size fail with output_limit. */
export const CLOUDFLARE_RESPONSE_MAX_BYTES = 2_000_000;
/** Cloudflare account and zone IDs. */
export const CLOUDFLARE_ID_PATTERN = /^[0-9a-f]{32}$/;

export const MAX_GRAPHQL_QUERY_BYTES = 16_384;
export const MAX_GRAPHQL_VARIABLES_BYTES = 8_192;
export const MAX_REST_PATH_CHARS = 512;
export const MAX_REST_QUERY_KEYS = 16;
export const MAX_REST_PER_PAGE = 100;

export type CloudflareOperation = 'graphql' | 'get';

export type CloudflareErrorCategory =
  | 'invalid_auth'
  | 'forbidden_scope'
  | 'not_found'
  | 'rate_limit'
  | 'timeout'
  | 'invalid_shape'
  | 'query_error'
  | 'upstream_error'
  | 'redirect_refused'
  | 'output_limit'
  | 'network';

/** Fixed model-facing sentences; raw upstream bodies are never returned. */
export const CLOUDFLARE_ERROR_TEXT: Record<CloudflareErrorCategory, string> = {
  invalid_auth: 'Cloudflare rejected the bot token (wrong, expired or revoked).',
  forbidden_scope:
    'Cloudflare refused the read: the bot token is read-only and lacks access to this resource or dataset.',
  not_found: 'The resource does not exist or is not visible to the bot token.',
  rate_limit: 'Cloudflare rate limit reached; do not retry now.',
  timeout: 'The Cloudflare request timed out; narrow the time window or the query.',
  invalid_shape: 'Cloudflare returned an unexpected response.',
  query_error: 'Cloudflare rejected the query.',
  upstream_error: 'Cloudflare returned a server error.',
  redirect_refused: 'Cloudflare answered with a redirect, which the bot does not follow.',
  output_limit:
    'The Cloudflare response exceeded the size limit; narrow the time window or lower the limit.',
  network: 'Cloudflare could not be reached.',
};

/** A request refused by the structural validation (the message is model-facing). */
export class CloudflareRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareRequestError';
  }
}

/**
 * What an instance exposes, from its readiness snapshot: the visible zone
 * IDs, the account (null: zone-level access only) and whether the zones
 * are an operator-chosen subset of what the token can see.
 */
export interface CloudflareScope {
  accountId: string | null;
  zoneIds: readonly string[];
  restrictedZones: boolean;
}

// --- REST path validation ---------------------------------------------------------

const REST_PATH = /^\/(zones|accounts)(?:\/([0-9a-f]{32})(\/[a-z0-9_./-]+)?)?$/;
const VERIFY_PATHS = ['/user/tokens/verify', '/accounts/tokens/verify'];
/**
 * Path segments refused although the token could read them: Logpush jobs
 * carry destination credentials (`destination_conf`) that must never reach a
 * Slack thread.
 */
const REFUSED_SEGMENTS = ['logpush'];
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,63}$/;

export interface ValidatedCloudflareGet {
  path: string;
  query: Record<string, string>;
}

function plainRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new CloudflareRequestError(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new CloudflareRequestError(`${tool}: unknown argument ${key.slice(0, 40)}`);
}

/**
 * The raw argument names of a Cloudflare tool call, checked before the SDK
 * parser can strip unknown fields (guard); null when acceptable.
 */
export function cloudflareArgumentProblem(tool: string, input: unknown): string | null {
  const allowed =
    tool === CLOUDFLARE_GRAPHQL_TOOL
      ? ['query', 'variables']
      : tool === CLOUDFLARE_GET_TOOL
        ? ['path', 'query']
        : null;
  if (allowed === null) return `unknown Cloudflare tool ${tool.slice(0, 40)}`;
  try {
    onlyKeys(plainRecord(input, `${tool} arguments`), allowed, tool);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid arguments';
  }
}

/**
 * Validates a `cloudflare_get` request: one path under `/zones`,
 * `/accounts` or a token verify endpoint, and bounded query parameters.
 * With a scope, a zone ID must be one of the instance's zones and an
 * account ID must be the instance's account.
 */
export function validateCloudflareGet(
  input: unknown,
  scope?: CloudflareScope,
): ValidatedCloudflareGet {
  const args = plainRecord(input, 'cloudflare_get arguments');
  onlyKeys(args, ['path', 'query'], CLOUDFLARE_GET_TOOL);
  const path = args.path;
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_REST_PATH_CHARS)
    throw new CloudflareRequestError(
      `path must be a string of 1 to ${MAX_REST_PATH_CHARS} characters`,
    );
  if (/[^\x21-\x7e]/.test(path) || /[?#%\\]/.test(path))
    throw new CloudflareRequestError('path must be a plain API path without query or escapes');
  const segments = path.split('/').slice(1);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new CloudflareRequestError('path must not contain empty, "." or ".." segments');
  if (segments.some((segment) => REFUSED_SEGMENTS.includes(segment)))
    throw new CloudflareRequestError(
      'Logpush configuration is not readable through the bot (it carries destination credentials)',
    );
  const verify = VERIFY_PATHS.includes(path);
  const match = verify ? null : REST_PATH.exec(path);
  if (!verify && match === null)
    throw new CloudflareRequestError(
      'path must be /zones, /zones/{zone_id}[/...], /accounts, /accounts/{account_id}[/...], /user/tokens/verify or /accounts/tokens/verify (lowercase)',
    );
  if (scope !== undefined && match !== null) {
    const [, root, id] = match;
    if (root === 'zones') {
      if (id === undefined && scope.restrictedZones)
        throw new CloudflareRequestError(
          'this channel exposes selected zones only: use the zone IDs listed in the tool description instead of listing zones',
        );
      if (id !== undefined && !scope.zoneIds.includes(id))
        throw new CloudflareRequestError('zone ID is not one of the zones this channel exposes');
    } else {
      if (scope.accountId === null)
        throw new CloudflareRequestError(
          'this channel exposes zone-level Cloudflare data only (no account is configured)',
        );
      if (id !== undefined && id !== scope.accountId)
        throw new CloudflareRequestError('account ID is not the account this channel exposes');
    }
  }
  const query: Record<string, string> = {};
  if (args.query !== undefined && args.query !== null) {
    const raw = plainRecord(args.query, 'query');
    const keys = Object.keys(raw).sort();
    if (keys.length > MAX_REST_QUERY_KEYS)
      throw new CloudflareRequestError(`query takes at most ${MAX_REST_QUERY_KEYS} parameters`);
    for (const key of keys) {
      if (!QUERY_KEY.test(key))
        throw new CloudflareRequestError(`query parameter name ${key.slice(0, 40)} is invalid`);
      const value = raw[key];
      let text: string;
      if (typeof value === 'string') {
        // eslint-disable-next-line no-control-regex -- intentional control-character rejection
        if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))
          throw new CloudflareRequestError(`query parameter ${key} is too long or not printable`);
        text = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
      else if (typeof value === 'boolean') text = String(value);
      else
        throw new CloudflareRequestError(
          `query parameter ${key} must be a string, number or boolean`,
        );
      if (key === 'per_page') {
        const perPage = Number(text);
        if (!Number.isInteger(perPage) || perPage < 1)
          throw new CloudflareRequestError('per_page must be a positive integer');
        text = String(Math.min(perPage, MAX_REST_PER_PAGE));
      }
      query[key] = text;
    }
  }
  return { path, query };
}

/** A path with every 32-hex ID replaced by `{id}` (evidence; never the IDs themselves). */
export function cloudflarePathTemplate(path: string): string {
  return path.replace(/\/[0-9a-f]{32}(?=\/|$)/g, '/{id}').slice(0, MAX_REST_PATH_CHARS);
}

// --- GraphQL validation -----------------------------------------------------------

type GraphqlToken =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string };

const PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

/**
 * GraphQL lexer (spec §2.1): comments, commas and whitespace are ignored;
 * strings and block strings become single tokens, so keywords inside them
 * or inside comments never count as operations.
 */
export function tokenizeGraphql(source: string): GraphqlToken[] {
  const tokens: GraphqlToken[] = [];
  let i = 0;
  const fail = (what: string): never => {
    throw new CloudflareRequestError(`query is not valid GraphQL (${what})`);
  };
  while (i < source.length) {
    const char = source[i]!;
    if (
      char === ' ' ||
      char === '\t' ||
      char === '\n' ||
      char === '\r' ||
      char === ',' ||
      char === '﻿'
    ) {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', i)) {
        let j = i + 3;
        for (;;) {
          if (j >= source.length) fail('unterminated block string');
          if (source.startsWith('\\"""', j)) j += 4;
          else if (source.startsWith('"""', j)) break;
          else j += 1;
        }
        tokens.push({ kind: 'string', value: source.slice(i + 3, j) });
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= source.length || source[j] === '\n' || source[j] === '\r')
          fail('unterminated string');
        const c = source[j]!;
        if (c === '"') break;
        if (c === '\\') {
          const next = source[j + 1] ?? '';
          if (next === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail('invalid escape');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          const escapes: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (!(next in escapes)) fail('invalid escape');
          value += escapes[next];
          j += 2;
          continue;
        }
        value += c;
        j += 1;
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCTUATORS.has(char)) {
      tokens.push({ kind: 'punct', value: char });
      i += 1;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i, i + 256));
    if (name !== null) {
      tokens.push({ kind: 'name', value: name[0] });
      i += name[0].length;
      continue;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      source.slice(i, i + 64),
    );
    if (number !== null) {
      tokens.push({ kind: 'number', value: number[0] });
      i += number[0].length;
      continue;
    }
    fail(`unexpected character at offset ${i}`);
  }
  return tokens;
}

export interface ValidatedCloudflareGraphql {
  query: string;
  variables: Record<string, unknown>;
  /** Datasets (zone/account-level root fields) and introspection fields queried, for evidence. */
  datasets: string[];
}

const ZONE_TAG_KEYS = ['zoneTag', 'zoneTag_in'];
const ACCOUNT_TAG_KEYS = ['accountTag', 'accountTag_in'];

/** Values bound to a tag key in the document: literals, lists or variables. */
function tagValues(
  tokens: readonly GraphqlToken[],
  index: number,
  variables: Record<string, unknown>,
): string[] {
  const values: string[] = [];
  const variable = (name: string | undefined): void => {
    const value = name === undefined ? undefined : variables[name];
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
      values.push(...(value as string[]));
    else throw new CloudflareRequestError('zoneTag/accountTag variables must be strings');
  };
  let i = index;
  const token = tokens[i];
  if (token?.kind === 'string') return [token.value];
  if (token?.kind === 'punct' && token.value === '$') {
    variable(tokens[i + 1]?.value);
    return values;
  }
  if (token?.kind === 'punct' && token.value === '[') {
    for (i += 1; i < tokens.length; i += 1) {
      const entry = tokens[i]!;
      if (entry.kind === 'punct' && entry.value === ']') return values;
      if (entry.kind === 'string') values.push(entry.value);
      else if (entry.kind === 'punct' && entry.value === '$') {
        variable(tokens[i + 1]?.value);
        i += 1;
      } else throw new CloudflareRequestError('zoneTag/accountTag lists must hold strings');
    }
  }
  throw new CloudflareRequestError('zoneTag/accountTag must be a string, a list or a variable');
}

/** Every value under a tag key anywhere in the variables (a filter object may be a variable). */
function variableTagValues(value: unknown, keys: readonly string[], out: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) variableTagValues(entry, keys, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (keys.includes(key)) {
      if (typeof entry === 'string') out.push(entry);
      else if (Array.isArray(entry) && entry.every((item) => typeof item === 'string'))
        out.push(...(entry as string[]));
      else throw new CloudflareRequestError('zoneTag/accountTag variables must be strings');
    } else variableTagValues(entry, keys, out);
  }
}

/**
 * Validates a `cloudflare_graphql` request: bounded sizes, exactly one
 * operation, and that operation a `query` (anonymous or named); fragments
 * are allowed, `mutation` and `subscription` are refused wherever they
 * appear at operation level. Introspection is allowed. With a scope, every
 * `zoneTag`/`accountTag` value must be one of the instance's zones or its
 * account; account-level datasets need a configured account and an
 * `accountTag` filter, and a zone subset needs a `zoneTag` filter on every
 * `zones` selection.
 */
export function validateCloudflareGraphql(
  input: unknown,
  scope?: CloudflareScope,
): ValidatedCloudflareGraphql {
  const args = plainRecord(input, 'cloudflare_graphql arguments');
  onlyKeys(args, ['query', 'variables'], CLOUDFLARE_GRAPHQL_TOOL);
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0)
    throw new CloudflareRequestError('query must be a GraphQL query document');
  if (Buffer.byteLength(query) > MAX_GRAPHQL_QUERY_BYTES)
    throw new CloudflareRequestError(`query exceeds ${MAX_GRAPHQL_QUERY_BYTES} bytes`);
  const variables =
    args.variables === undefined || args.variables === null
      ? {}
      : plainRecord(args.variables, 'variables');
  if (Buffer.byteLength(JSON.stringify(variables)) > MAX_GRAPHQL_VARIABLES_BYTES)
    throw new CloudflareRequestError(`variables exceed ${MAX_GRAPHQL_VARIABLES_BYTES} bytes`);
  const tokens = tokenizeGraphql(query);

  // Top-level structure: definitions are operations or fragments.
  const operations: string[] = [];
  const datasets: string[] = [];
  let depth = 0;
  let parens = 0;
  let expectingDefinition = true;
  let definition: 'operation' | 'fragment' | null = null;
  let root = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === 'punct') {
      if (token.value === '(') parens += 1;
      else if (token.value === ')') parens -= 1;
      else if (parens === 0 && token.value === '{') {
        if (depth === 0 && expectingDefinition) {
          operations.push('query');
          definition = 'operation';
          expectingDefinition = false;
        }
        depth += 1;
      } else if (parens === 0 && token.value === '}') {
        depth -= 1;
        if (depth === 0) {
          expectingDefinition = true;
          definition = null;
        }
      }
      if (parens < 0 || depth < 0)
        throw new CloudflareRequestError('query has unbalanced brackets');
      continue;
    }
    if (depth === 0 && parens === 0 && token.kind === 'name' && expectingDefinition) {
      if (['query', 'mutation', 'subscription'].includes(token.value)) {
        operations.push(token.value);
        definition = 'operation';
      } else if (token.value === 'fragment') definition = 'fragment';
      else
        throw new CloudflareRequestError(
          `query is not valid GraphQL (unexpected ${token.value.slice(0, 40)} at top level)`,
        );
      expectingDefinition = false;
      continue;
    }
    // Field names of the operation (not arguments, not after a colon alias).
    if (token.kind === 'name' && parens === 0 && definition === 'operation') {
      const next = tokens[i + 1];
      if (next?.kind === 'punct' && next.value === ':') continue;
      if (depth === 1) {
        root = token.value;
        if (root.startsWith('__')) datasets.push(root);
      }
      // viewer { zones|accounts { <dataset> } }
      if (depth === 3 && root === 'viewer') datasets.push(token.value);
    }
  }
  if (depth !== 0 || parens !== 0)
    throw new CloudflareRequestError('query has unbalanced brackets');
  if (operations.length !== 1)
    throw new CloudflareRequestError('query must contain exactly one operation');
  if (operations[0] !== 'query')
    throw new CloudflareRequestError(
      `only read queries are allowed (${operations[0]} refused); Cloudflare access is read-only`,
    );

  if (scope !== undefined) {
    const zoneValues: string[] = [];
    const accountValues: string[] = [];
    parens = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.kind === 'punct' && token.value === '(') parens += 1;
      if (token.kind === 'punct' && token.value === ')') parens -= 1;
      if (token.kind !== 'name') continue;
      const next = tokens[i + 1];
      const previous = tokens[i - 1];
      // An argument or input-object key (not a `$variable` definition).
      const keyed =
        parens > 0 &&
        next?.kind === 'punct' &&
        next.value === ':' &&
        !(previous?.kind === 'punct' && previous.value === '$');
      if (keyed && ZONE_TAG_KEYS.includes(token.value))
        zoneValues.push(...tagValues(tokens, i + 2, variables));
      if (keyed && ACCOUNT_TAG_KEYS.includes(token.value))
        accountValues.push(...tagValues(tokens, i + 2, variables));
      // A `zones`/`accounts` selection (a field, not an argument name).
      if (parens === 0 && (token.value === 'zones' || token.value === 'accounts')) {
        const keys = token.value === 'zones' ? ZONE_TAG_KEYS : ACCOUNT_TAG_KEYS;
        const needsFilter = token.value === 'accounts' || scope.restrictedZones;
        if (token.value === 'accounts' && scope.accountId === null)
          throw new CloudflareRequestError(
            'this channel exposes zone-level Cloudflare data only (no account is configured)',
          );
        if (!needsFilter) continue;
        let hasFilter = false;
        if (next?.kind === 'punct' && next.value === '(') {
          let inner = 0;
          for (let j = i + 1; j < tokens.length; j += 1) {
            const entry = tokens[j]!;
            if (entry.kind === 'punct' && entry.value === '(') inner += 1;
            if (entry.kind === 'punct' && entry.value === ')' && --inner === 0) break;
            const after = tokens[j + 1];
            if (
              entry.kind === 'name' &&
              keys.includes(entry.value) &&
              after?.kind === 'punct' &&
              after.value === ':'
            )
              hasFilter = true;
          }
        }
        if (!hasFilter)
          throw new CloudflareRequestError(
            token.value === 'zones'
              ? 'this channel exposes selected zones only: filter zones by zoneTag (a literal filter, IDs from the tool description)'
              : 'filter accounts by accountTag (the account ID from the tool description)',
          );
      }
    }
    variableTagValues(variables, ZONE_TAG_KEYS, zoneValues);
    variableTagValues(variables, ACCOUNT_TAG_KEYS, accountValues);
    for (const value of zoneValues)
      if (!scope.zoneIds.includes(value))
        throw new CloudflareRequestError('zoneTag is not one of the zones this channel exposes');
    for (const value of accountValues)
      if (scope.accountId === null || value !== scope.accountId)
        throw new CloudflareRequestError('accountTag is not the account this channel exposes');
  }
  return {
    query,
    variables,
    datasets: [...new Set(datasets.map((name) => name.slice(0, 64)))].slice(0, 8),
  };
}

/** Validates either operation's request (broker and runtime). */
export function validateCloudflareRequest(
  operation: CloudflareOperation,
  input: unknown,
  scope?: CloudflareScope,
): ValidatedCloudflareGraphql | ValidatedCloudflareGet {
  return operation === 'graphql'
    ? validateCloudflareGraphql(input, scope)
    : validateCloudflareGet(input, scope);
}

// --- Transport --------------------------------------------------------------------

export type CloudflareFetch = (input: URL, init: RequestInit) => Promise<Response>;

/** One trusted API request built from a validated operation. */
export interface CloudflareHttpRequest {
  method: 'GET' | 'POST';
  url: URL;
  body: string | null;
}

export function buildCloudflareRequest(
  operation: CloudflareOperation,
  validated: ValidatedCloudflareGraphql | ValidatedCloudflareGet,
): CloudflareHttpRequest {
  if (operation === 'graphql') {
    const graphql = validated as ValidatedCloudflareGraphql;
    return {
      method: 'POST',
      url: new URL(`${CLOUDFLARE_BASE_PATH}/graphql`, CLOUDFLARE_API_ORIGIN),
      body: JSON.stringify({ query: graphql.query, variables: graphql.variables }),
    };
  }
  const get = validated as ValidatedCloudflareGet;
  const url = new URL(`${CLOUDFLARE_BASE_PATH}${get.path}`, CLOUDFLARE_API_ORIGIN);
  for (const [key, value] of Object.entries(get.query)) url.searchParams.set(key, value);
  return { method: 'GET', url, body: null };
}

/**
 * Whether Cloudflare's errors say the token itself is invalid. Codes alone
 * are ambiguous: live on 2026-09-29, `9109` came back both for an invalid
 * token ("Invalid access token") and for a valid token lacking a permission,
 * so the message decides; `1000` ("Invalid API Token") comes from the verify
 * endpoints.
 */
const INVALID_TOKEN_MESSAGE = /invalid (?:api |access )?token|authentication error|expired/i;

function invalidToken(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    if (!Array.isArray(parsed.errors)) return false;
    return parsed.errors.some((entry) => {
      const error = (entry ?? {}) as { code?: unknown; message?: unknown };
      return (
        error.code === 1000 ||
        (typeof error.message === 'string' && INVALID_TOKEN_MESSAGE.test(error.message))
      );
    });
  } catch {
    return false;
  }
}

/** Classifies an HTTP answer from its status and Cloudflare's error messages. */
export function classifyCloudflareHttp(
  status: number,
  body: string,
): CloudflareErrorCategory | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return 'redirect_refused';
  if (status === 401) return 'invalid_auth';
  if (status === 403 || status === 400) {
    if (invalidToken(body)) return 'invalid_auth';
    return status === 403 ? 'forbidden_scope' : 'invalid_shape';
  }
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'invalid_shape';
  return 'upstream_error';
}

export interface CloudflareHttpResult {
  errorCategory?: CloudflareErrorCategory;
  httpStatus: number | null;
  body: string;
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
 * The only way a request reaches Cloudflare: the pinned origin over HTTPS,
 * `GET` under the base path or `POST` to `/graphql`, the bearer token
 * attached here and nowhere else, redirects refused, the body capped. No
 * retries.
 */
export async function sendCloudflareRequest(
  request: CloudflareHttpRequest,
  token: string,
  options: {
    timeoutMs: number;
    maxBytes?: number;
    signal?: AbortSignal;
    fetchImpl?: CloudflareFetch;
  },
): Promise<CloudflareHttpResult> {
  const url = request.url;
  const graphqlPath = `${CLOUDFLARE_BASE_PATH}/graphql`;
  if (
    url.protocol !== 'https:' ||
    url.origin !== CLOUDFLARE_API_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(`${CLOUDFLARE_BASE_PATH}/`) ||
    !(
      (request.method === 'GET' && request.body === null) ||
      (request.method === 'POST' && url.pathname === graphqlPath && url.search === '')
    )
  )
    throw new Error('Cloudflare request outside the pinned read-only API surface');
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (request.body !== null) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await doFetch(url, {
      method: request.method,
      redirect: 'manual',
      signal,
      headers,
      ...(request.body !== null ? { body: request.body } : {}),
    });
  } catch {
    return { errorCategory: signal.aborted ? 'timeout' : 'network', httpStatus: null, body: '' };
  }
  if (response.status === 0 || response.type === 'opaqueredirect') {
    await response.body?.cancel().catch(() => {});
    return { errorCategory: 'redirect_refused', httpStatus: response.status, body: '' };
  }
  let body: { text: string; truncated: boolean };
  try {
    body = await readCapped(response, options.maxBytes ?? CLOUDFLARE_RESPONSE_MAX_BYTES);
  } catch {
    return {
      errorCategory: signal.aborted ? 'timeout' : 'network',
      httpStatus: response.status,
      body: '',
    };
  }
  const category = classifyCloudflareHttp(response.status, body.truncated ? '' : body.text);
  if (category) return { errorCategory: category, httpStatus: response.status, body: '' };
  if (body.truncated)
    return { errorCategory: 'output_limit', httpStatus: response.status, body: '' };
  return { httpStatus: response.status, body: body.text };
}

// --- Results ----------------------------------------------------------------------

export interface CloudflareCallResult {
  status: 'completed' | 'failed' | 'timed_out' | 'not_run';
  output: string;
  errorCategory?: CloudflareErrorCategory;
  truncated?: boolean;
  /** Bytes of the model-facing output. */
  bytes?: number;
  refused?: string;
}

/** Bounds the model-facing text; truncation is always marked. */
export function boundCloudflareOutput(
  text: string,
  maxOutputBytes: number,
): { output: string; truncated: boolean } {
  const marker = '\n[truncated: Cloudflare result exceeded the output limit]';
  const bound = Math.max(256, maxOutputBytes);
  if (Buffer.byteLength(text) <= bound) return { output: text, truncated: false };
  let out = Buffer.from(text)
    .subarray(0, bound - Buffer.byteLength(marker))
    .toString('utf8');
  while (Buffer.byteLength(out) + Buffer.byteLength(marker) > bound) out = out.slice(0, -1);
  return { output: `${out}${marker}`, truncated: true };
}

export function cloudflareFailure(
  tool: string,
  category: CloudflareErrorCategory,
  detail = '',
): CloudflareCallResult {
  const output = `${tool}: ${category}: ${CLOUDFLARE_ERROR_TEXT[category]}${detail}`;
  return {
    status: category === 'timeout' ? 'timed_out' : 'failed',
    errorCategory: category,
    output,
    bytes: Buffer.byteLength(output),
  };
}

function completed(text: string, maxOutputBytes: number): CloudflareCallResult {
  const bounded = boundCloudflareOutput(text, maxOutputBytes);
  return {
    status: 'completed',
    output: bounded.output,
    truncated: bounded.truncated,
    bytes: Buffer.byteLength(bounded.output),
  };
}

/** Classifies GraphQL `errors[]` by their messages (never echoed for auth failures). */
export function classifyGraphqlErrors(errors: readonly unknown[]): CloudflareErrorCategory {
  const text = errors
    .map((entry) => {
      const message = (entry as { message?: unknown } | null)?.message;
      return typeof message === 'string' ? message : '';
    })
    .join('\n');
  if (/authentication|unauthori[sz]ed|invalid (?:api )?token|expired token/i.test(text))
    return 'invalid_auth';
  if (
    /does not have access|not authori[sz]ed|permission|zone not found|account not found|forbidden/i.test(
      text,
    )
  )
    return 'forbidden_scope';
  if (/rate.?limit|too many requests|limit exceeded|quota/i.test(text)) return 'rate_limit';
  if (/timeout|timed out/i.test(text)) return 'timeout';
  return 'query_error';
}

// eslint-disable-next-line no-control-regex -- strips control characters from upstream text
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/**
 * Bounded summaries of query errors (message and path), so the model can
 * correct a field or filter name. Only for `query_error`: auth, scope and
 * rate-limit errors are answered with the fixed sentences.
 */
export function summarizeGraphqlErrors(errors: readonly unknown[]): string[] {
  return errors.slice(0, 3).map((entry) => {
    const record = (entry ?? {}) as { message?: unknown; path?: unknown };
    const message =
      typeof record.message === 'string'
        ? record.message.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, 300)
        : 'error';
    const path = Array.isArray(record.path)
      ? ` (at ${record.path
          .filter((part) => typeof part === 'string' || typeof part === 'number')
          .join('.')
          .slice(0, 120)})`
      : '';
    return `${message}${path}`;
  });
}

/** Turns a GraphQL HTTP answer into the model-facing result. */
export function normalizeCloudflareGraphql(
  http: CloudflareHttpResult,
  maxOutputBytes: number,
): CloudflareCallResult {
  if (http.errorCategory) return cloudflareFailure(CLOUDFLARE_GRAPHQL_TOOL, http.errorCategory);
  let parsed: { data?: unknown; errors?: unknown };
  try {
    parsed = JSON.parse(http.body) as { data?: unknown; errors?: unknown };
  } catch {
    return cloudflareFailure(CLOUDFLARE_GRAPHQL_TOOL, 'invalid_shape');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return cloudflareFailure(CLOUDFLARE_GRAPHQL_TOOL, 'invalid_shape');
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  const hasData = parsed.data !== null && parsed.data !== undefined;
  if (errors.length > 0) {
    const category = classifyGraphqlErrors(errors);
    if (category !== 'query_error' || !hasData)
      return cloudflareFailure(
        CLOUDFLARE_GRAPHQL_TOOL,
        category,
        category === 'query_error' ? `\n${summarizeGraphqlErrors(errors).join('\n')}` : '',
      );
  }
  if (!hasData) return cloudflareFailure(CLOUDFLARE_GRAPHQL_TOOL, 'invalid_shape');
  return completed(
    JSON.stringify({
      data: parsed.data,
      ...(errors.length > 0 ? { partialErrors: summarizeGraphqlErrors(errors) } : {}),
    }),
    maxOutputBytes,
  );
}

/** Turns a REST HTTP answer into the model-facing result (`result` and paging only). */
export function normalizeCloudflareRest(
  http: CloudflareHttpResult,
  maxOutputBytes: number,
): CloudflareCallResult {
  if (http.errorCategory) return cloudflareFailure(CLOUDFLARE_GET_TOOL, http.errorCategory);
  let parsed: { success?: unknown; result?: unknown; result_info?: unknown; errors?: unknown };
  try {
    parsed = JSON.parse(http.body) as typeof parsed;
  } catch {
    return cloudflareFailure(CLOUDFLARE_GET_TOOL, 'invalid_shape');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return cloudflareFailure(CLOUDFLARE_GET_TOOL, 'invalid_shape');
  if (parsed.success !== true) {
    return cloudflareFailure(
      CLOUDFLARE_GET_TOOL,
      invalidToken(http.body) ? 'invalid_auth' : 'invalid_shape',
    );
  }
  return completed(
    JSON.stringify({
      result: parsed.result ?? null,
      ...(parsed.result_info !== undefined ? { result_info: parsed.result_info } : {}),
    }),
    maxOutputBytes,
  );
}

// --- Identity ---------------------------------------------------------------------

/** Stable, non-reversible token identity (changes only when the token is rotated). */
export function cloudflareCredentialFingerprint(token: string): string {
  return createHash('sha256')
    .update(`support-agent-cloudflare-v1\0${token}`)
    .digest('hex')
    .slice(0, 16);
}

/** Stable hash of the exposed zone set (independent of order). */
export function cloudflareZoneSetHash(zones: ReadonlyArray<{ id: string; name: string }>): string {
  const lines = zones.map((zone) => `${zone.id}:${zone.name}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}
