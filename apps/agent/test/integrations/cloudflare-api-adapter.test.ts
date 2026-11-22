import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_ENDPOINT,
  CloudflareRequestError,
  boundCloudflareOutput,
  buildCloudflareRequest,
  classifyCloudflareHttp,
  classifyGraphqlErrors,
  cloudflareArgumentProblem,
  cloudflareCredentialFingerprint,
  cloudflarePathTemplate,
  cloudflareZoneSetHash,
  normalizeCloudflareGraphql,
  normalizeCloudflareRest,
  sendCloudflareRequest,
  tokenizeGraphql,
  validateCloudflareGet,
  validateCloudflareGraphql,
  type CloudflareFetch,
  type CloudflareScope,
} from '../../src/integrations/cloudflare/cloudflare-api-adapter.js';
import { ACCOUNT_ID, ZONE_A, ZONE_B, fakeCloudflare } from './helpers/cloudflare-api.js';

const TOKEN = 'cf-read-token-1234567890';
const SCOPE: CloudflareScope = {
  accountId: ACCOUNT_ID,
  zoneIds: [ZONE_A.id, ZONE_B.id],
  restrictedZones: false,
};
const HOURLY = `query Hourly($zoneTag: string, $start: Time, $end: Time) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(limit: 48, filter: { datetime_geq: $start, datetime_lt: $end }, orderBy: [datetimeHour_ASC]) {
        count
        dimensions { datetimeHour }
        sum { edgeResponseBytes }
      }
    }
  }
}`;

describe('Cloudflare REST path validation', () => {
  it('accepts zone, account and token verify paths and bounds the query', () => {
    expect(validateCloudflareGet({ path: '/zones' }, SCOPE)).toEqual({ path: '/zones', query: {} });
    expect(
      validateCloudflareGet(
        { path: `/zones/${ZONE_A.id}/dns_records`, query: { per_page: 500, type: 'A', page: 2 } },
        SCOPE,
      ),
    ).toEqual({
      path: `/zones/${ZONE_A.id}/dns_records`,
      query: { page: '2', per_page: '100', type: 'A' },
    });
    expect(validateCloudflareGet({ path: `/zones/${ZONE_B.id}/settings/ssl` }, SCOPE).path).toBe(
      `/zones/${ZONE_B.id}/settings/ssl`,
    );
    expect(validateCloudflareGet({ path: `/accounts/${ACCOUNT_ID}` }, SCOPE).path).toBe(
      `/accounts/${ACCOUNT_ID}`,
    );
    for (const path of ['/user/tokens/verify', '/accounts/tokens/verify'])
      expect(validateCloudflareGet({ path }, { ...SCOPE, accountId: null }).path).toBe(path);
  });

  it('refuses other roots, traversal, escapes, queries in the path and Logpush', () => {
    const refused = [
      '/user',
      '/graphql',
      '/zones/',
      '//zones',
      '/zones/../user/tokens',
      `/zones/${ZONE_A.id}/./settings`,
      `/zones/${ZONE_A.id}//settings`,
      `/zones/${ZONE_A.id}/settings?x=1`,
      `/zones/${ZONE_A.id}/settings#x`,
      `/zones/${ZONE_A.id}/%2e%2e`,
      `/ZONES/${ZONE_A.id}`,
      `/zones/${ZONE_A.id.toUpperCase()}`,
      `/zones/${ZONE_A.id}/logpush/jobs`,
      `/accounts/${ACCOUNT_ID}/logpush/jobs`,
      'https://api.cloudflare.com/client/v4/zones',
      'zones',
      `/zones/${ZONE_A.id}/dns records`,
      `/zones/${'x'.repeat(600)}`,
    ];
    for (const path of refused)
      expect(() => validateCloudflareGet({ path }, SCOPE), path).toThrow(CloudflareRequestError);
    expect(() => validateCloudflareGet({ path: '/zones', method: 'POST' })).toThrow(
      /unknown argument method/,
    );
    expect(() => validateCloudflareGet({ path: '/zones', query: { per_page: 0 } })).toThrow(
      /per_page/,
    );
    expect(() => validateCloudflareGet({ path: '/zones', query: { name: { a: 1 } } })).toThrow(
      /string, number or boolean/,
    );
    expect(() =>
      validateCloudflareGet({
        path: '/zones',
        query: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])),
      }),
    ).toThrow(/at most 16/);
  });

  it('pins zone and account IDs to the snapshot', () => {
    const other = 'd'.repeat(32);
    expect(() => validateCloudflareGet({ path: `/zones/${other}` }, SCOPE)).toThrow(
      /not one of the zones/,
    );
    expect(() => validateCloudflareGet({ path: `/accounts/${other}` }, SCOPE)).toThrow(
      /not the account/,
    );
    const zoneOnly = { ...SCOPE, accountId: null };
    expect(() => validateCloudflareGet({ path: '/accounts' }, zoneOnly)).toThrow(/zone-level/);
    expect(() => validateCloudflareGet({ path: `/accounts/${ACCOUNT_ID}` }, zoneOnly)).toThrow(
      /zone-level/,
    );
    expect(() =>
      validateCloudflareGet({ path: '/zones' }, { ...SCOPE, restrictedZones: true }),
    ).toThrow(/selected zones only/);
    // Without a scope (guard-level checks) only the grammar applies.
    expect(validateCloudflareGet({ path: `/zones/${other}` }).path).toBe(`/zones/${other}`);
  });

  it('templates IDs out of paths for evidence', () => {
    expect(cloudflarePathTemplate(`/zones/${ZONE_A.id}/dns_records/${'e'.repeat(32)}`)).toBe(
      '/zones/{id}/dns_records/{id}',
    );
  });
});

describe('Cloudflare GraphQL validation', () => {
  it('accepts one named or anonymous query, fragments and introspection', () => {
    const named = validateCloudflareGraphql(
      { query: HOURLY, variables: { zoneTag: ZONE_A.id, start: 'a', end: 'b' } },
      SCOPE,
    );
    expect(named.datasets).toEqual(['httpRequestsAdaptiveGroups']);
    const anonymous = validateCloudflareGraphql(
      {
        query: `{ viewer { zones(filter: {zoneTag: "${ZONE_A.id}"}) { a: firewallEventsAdaptiveGroups(limit: 5) { count dimensions { action } } } } }`,
      },
      SCOPE,
    );
    expect(anonymous.datasets).toEqual(['firewallEventsAdaptiveGroups']);
    expect(
      validateCloudflareGraphql(
        {
          query:
            'query { viewer { zones(filter: {zoneTag: $z}) { ...F } } } fragment F on zone { httpRequests1hGroups(limit: 1) { count } }',
          variables: { z: ZONE_B.id },
        },
        SCOPE,
      ).query,
    ).toContain('fragment F');
    const introspection = validateCloudflareGraphql(
      { query: '{ __type(name: "ZoneHttpRequestsAdaptiveGroups") { fields { name } } }' },
      SCOPE,
    );
    expect(introspection.datasets).toEqual(['__type']);
    expect(
      validateCloudflareGraphql({ query: '{ __schema { queryType { name } } }' }).datasets,
    ).toEqual(['__schema']);
  });

  it('refuses mutations, subscriptions and multi-operation documents', () => {
    const refused: Array<[string, RegExp]> = [
      ['mutation { purge(zone: "x") { ok } }', /mutation refused/],
      ['subscription { events { id } }', /subscription refused/],
      ['query A { viewer { a } } mutation B { x }', /exactly one operation/],
      ['{ viewer { a } } { viewer { b } }', /exactly one operation/],
      ['query A { a } query B { b }', /exactly one operation/],
      ['fragment F on viewer { a }', /exactly one operation/],
      ['', /GraphQL query document/],
      ['{ viewer { a }', /unbalanced/],
      ['{ viewer { a } } }', /unbalanced/],
      ['schema { query: Q }', /unexpected schema/],
      ['{ a(x: "unterminated) }', /unterminated string/],
      ['{ a } ;', /unexpected character/],
    ];
    for (const [query, message] of refused)
      expect(() => validateCloudflareGraphql({ query }), query).toThrow(message);
    expect(() => validateCloudflareGraphql({ query: '{ a }', operationName: 'x' })).toThrow(
      /unknown argument operationName/,
    );
    expect(() => validateCloudflareGraphql({ query: 'x'.repeat(16_385) })).toThrow(/exceeds/);
    expect(() =>
      validateCloudflareGraphql({ query: '{ a }', variables: { v: 'x'.repeat(9_000) } }),
    ).toThrow(/variables exceed/);
    expect(() => validateCloudflareGraphql({ query: '{ a }', variables: [1] })).toThrow(
      /variables must be an object/,
    );
  });

  it('is not fooled by keywords in comments, strings and block strings', () => {
    // Keywords hidden in comments and strings do not count as operations...
    expect(
      validateCloudflareGraphql({
        query: `# mutation { purge }\n{ viewer { a(x: "mutation { b }", y: """ } mutation { c } """) } }`,
      }).query,
    ).toContain('viewer');
    // ...and a real mutation cannot hide behind a comment or string that closes early.
    expect(() =>
      validateCloudflareGraphql({ query: '{ a(x: "\\" }") } # }\nmutation { b }' }),
    ).toThrow(/exactly one operation/);
    expect(() =>
      validateCloudflareGraphql({ query: '{ a(x: """ \\""" } """) } mutation { b }' }),
    ).toThrow(/exactly one operation/);
    expect(tokenizeGraphql('"a\\u0041\\n"')).toEqual([{ kind: 'string', value: 'aA\n' }]);
  });

  it('pins zone and account tags to the snapshot, through literals, lists and variables', () => {
    const other = 'd'.repeat(32);
    const zones = (filter: string) =>
      `{ viewer { zones(filter: ${filter}) { x(limit: 1) { count } } } }`;
    expect(() =>
      validateCloudflareGraphql({ query: zones(`{zoneTag: "${other}"}`) }, SCOPE),
    ).toThrow(/zoneTag is not one of the zones/);
    expect(() =>
      validateCloudflareGraphql(
        { query: zones(`{zoneTag_in: ["${ZONE_A.id}", "${other}"]}`) },
        SCOPE,
      ),
    ).toThrow(/zoneTag is not one of the zones/);
    expect(() =>
      validateCloudflareGraphql({ query: zones('{zoneTag: $z}'), variables: { z: other } }, SCOPE),
    ).toThrow(/zoneTag is not one of the zones/);
    // A whole filter object passed as a variable is scanned too.
    expect(() =>
      validateCloudflareGraphql(
        { query: zones('$f'), variables: { f: { zoneTag: other } } },
        SCOPE,
      ),
    ).toThrow(/zoneTag is not one of the zones/);
    expect(() => validateCloudflareGraphql({ query: zones('{zoneTag: 5}') }, SCOPE)).toThrow(
      /must be a string/,
    );
    // Unfiltered zones: fine for "every zone the token sees", refused for a subset.
    const unfiltered = '{ viewer { zones { x(limit: 1) { count } } } }';
    expect(validateCloudflareGraphql({ query: unfiltered }, SCOPE).datasets).toEqual(['x']);
    const restricted = { ...SCOPE, restrictedZones: true };
    expect(() => validateCloudflareGraphql({ query: unfiltered }, restricted)).toThrow(
      /filter zones by zoneTag/,
    );
    expect(() =>
      validateCloudflareGraphql(
        { query: zones('$f'), variables: { f: { zoneTag: ZONE_A.id } } },
        restricted,
      ),
    ).toThrow(/filter zones by zoneTag/);
    expect(
      validateCloudflareGraphql({ query: zones(`{zoneTag: "${ZONE_A.id}"}`) }, restricted).datasets,
    ).toEqual(['x']);
    // Account-level datasets need a configured account and its tag.
    const accounts = (filter: string) =>
      `{ viewer { accounts${filter} { y(limit: 1) { count } } } }`;
    expect(
      validateCloudflareGraphql(
        { query: accounts(`(filter: {accountTag: "${ACCOUNT_ID}"})`) },
        SCOPE,
      ).datasets,
    ).toEqual(['y']);
    expect(() => validateCloudflareGraphql({ query: accounts('') }, SCOPE)).toThrow(
      /filter accounts by accountTag/,
    );
    expect(() =>
      validateCloudflareGraphql({ query: accounts(`(filter: {accountTag: "${other}"})`) }, SCOPE),
    ).toThrow(/accountTag is not the account/);
    expect(() =>
      validateCloudflareGraphql(
        { query: accounts(`(filter: {accountTag: "${ACCOUNT_ID}"})`) },
        { ...SCOPE, accountId: null },
      ),
    ).toThrow(/zone-level/);
    // A dimension selected as a field is not a filter.
    expect(
      validateCloudflareGraphql(
        {
          query: `{ viewer { zones(filter: {zoneTag: "${ZONE_A.id}"}) { x(limit: 1) { dimensions { zoneTag } } } } }`,
        },
        restricted,
      ).datasets,
    ).toEqual(['x']);
  });

  it('checks raw argument names for the guard', () => {
    expect(cloudflareArgumentProblem('cloudflare_graphql', { query: '{a}' })).toBeNull();
    expect(cloudflareArgumentProblem('cloudflare_get', { path: '/zones', query: {} })).toBeNull();
    expect(
      cloudflareArgumentProblem('cloudflare_get', { path: '/zones', method: 'DELETE' }),
    ).toMatch(/unknown argument method/);
    expect(cloudflareArgumentProblem('cloudflare_graphql', 'x')).toMatch(/must be an object/);
  });
});

describe('Cloudflare transport', () => {
  it('attaches the bearer token on the pinned origin only and refuses redirects', async () => {
    const api = fakeCloudflare();
    const get = buildCloudflareRequest('get', validateCloudflareGet({ path: '/zones' }));
    const result = await sendCloudflareRequest(get, TOKEN, {
      timeoutMs: 1_000,
      fetchImpl: api.fetchImpl,
    });
    expect(result.errorCategory).toBeUndefined();
    expect(api.seen[0]).toMatchObject({
      method: 'GET',
      authorization: `Bearer ${TOKEN}`,
      contentType: null,
      redirect: 'manual',
    });
    expect(api.seen[0]!.url.toString()).toBe(`${CLOUDFLARE_ENDPOINT}/zones`);
    const graphql = buildCloudflareRequest(
      'graphql',
      validateCloudflareGraphql({ query: '{ viewer { zones { a } } }' }),
    );
    await sendCloudflareRequest(graphql, TOKEN, { timeoutMs: 1_000, fetchImpl: api.fetchImpl });
    expect(api.seen[1]).toMatchObject({
      method: 'POST',
      contentType: 'application/json',
      body: { query: '{ viewer { zones { a } } }', variables: {} },
    });
    expect(api.seen[1]!.url.pathname).toBe('/client/v4/graphql');
  });

  it('refuses requests outside the pinned read-only surface before any fetch', async () => {
    let calls = 0;
    const fetchImpl: CloudflareFetch = async () => {
      calls += 1;
      return Response.json({});
    };
    const bad = [
      { method: 'GET', url: new URL('https://evil.example/client/v4/zones'), body: null },
      { method: 'GET', url: new URL('http://api.cloudflare.com/client/v4/zones'), body: null },
      { method: 'GET', url: new URL('https://api.cloudflare.com/v4/zones'), body: null },
      { method: 'GET', url: new URL('https://u:p@api.cloudflare.com/client/v4/zones'), body: null },
      { method: 'POST', url: new URL(`${CLOUDFLARE_ENDPOINT}/zones/x/purge_cache`), body: '{}' },
      { method: 'POST', url: new URL(`${CLOUDFLARE_ENDPOINT}/graphql?x=1`), body: '{}' },
      { method: 'GET', url: new URL(`${CLOUDFLARE_ENDPOINT}/zones`), body: '{}' },
      { method: 'PUT', url: new URL(`${CLOUDFLARE_ENDPOINT}/zones`), body: null },
      { method: 'DELETE', url: new URL(`${CLOUDFLARE_ENDPOINT}/zones/x`), body: null },
      { method: 'PATCH', url: new URL(`${CLOUDFLARE_ENDPOINT}/zones/x`), body: null },
    ];
    for (const request of bad)
      await expect(
        sendCloudflareRequest(request as never, TOKEN, { timeoutMs: 1_000, fetchImpl }),
      ).rejects.toThrow(/outside the pinned/);
    expect(calls).toBe(0);
  });

  it('classifies redirects, timeouts, oversized bodies and network errors', async () => {
    const get = buildCloudflareRequest('get', { path: '/zones', query: {} });
    const answer =
      (response: Response): CloudflareFetch =>
      async () =>
        response;
    expect(
      (
        await sendCloudflareRequest(get, TOKEN, {
          timeoutMs: 1_000,
          fetchImpl: answer(new Response(null, { status: 302, headers: { location: 'x' } })),
        })
      ).errorCategory,
    ).toBe('redirect_refused');
    expect(
      (
        await sendCloudflareRequest(get, TOKEN, {
          timeoutMs: 1_000,
          maxBytes: 10,
          fetchImpl: answer(new Response('x'.repeat(100))),
        })
      ).errorCategory,
    ).toBe('output_limit');
    expect(
      (
        await sendCloudflareRequest(get, TOKEN, {
          timeoutMs: 20,
          fetchImpl: (_input, init) =>
            new Promise((_resolve, reject) =>
              init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            ),
        })
      ).errorCategory,
    ).toBe('timeout');
    expect(
      (
        await sendCloudflareRequest(get, TOKEN, {
          timeoutMs: 1_000,
          fetchImpl: async () => {
            throw new Error('ECONNREFUSED');
          },
        })
      ).errorCategory,
    ).toBe('network');
  });

  it('classifies HTTP statuses and Cloudflare error codes', () => {
    const body = (code: number, message = 'error') =>
      JSON.stringify({ success: false, errors: [{ code, message }] });
    expect(classifyCloudflareHttp(200, '')).toBeNull();
    expect(classifyCloudflareHttp(401, '')).toBe('invalid_auth');
    // Live answers (2026-09-29): an invalid token on /zones and on the verify endpoint.
    expect(classifyCloudflareHttp(403, body(9109, 'Invalid access token'))).toBe('invalid_auth');
    expect(classifyCloudflareHttp(401, body(1000, 'Invalid API Token'))).toBe('invalid_auth');
    expect(classifyCloudflareHttp(400, body(10000, 'Authentication error'))).toBe('invalid_auth');
    // The same code for a valid token lacking a permission is a scope refusal.
    expect(
      classifyCloudflareHttp(403, body(9109, 'Unauthorized to access requested resource')),
    ).toBe('forbidden_scope');
    expect(classifyCloudflareHttp(403, body(10005, 'forbidden'))).toBe('forbidden_scope');
    expect(classifyCloudflareHttp(403, 'not json')).toBe('forbidden_scope');
    expect(classifyCloudflareHttp(400, body(7003))).toBe('invalid_shape');
    expect(classifyCloudflareHttp(404, '')).toBe('not_found');
    expect(classifyCloudflareHttp(429, '')).toBe('rate_limit');
    expect(classifyCloudflareHttp(503, '')).toBe('upstream_error');
    expect(classifyCloudflareHttp(301, '')).toBe('redirect_refused');
  });
});

describe('Cloudflare results', () => {
  it('returns GraphQL data, summarizes query errors and hides auth details', () => {
    const ok = normalizeCloudflareGraphql(
      { httpStatus: 200, body: JSON.stringify({ data: { viewer: { zones: [] } }, errors: null }) },
      10_000,
    );
    expect(ok).toMatchObject({ status: 'completed', output: '{"data":{"viewer":{"zones":[]}}}' });
    const queryError = normalizeCloudflareGraphql(
      {
        httpStatus: 200,
        body: JSON.stringify({
          data: null,
          errors: [{ message: 'unknown field "requestz"\u0007', path: ['viewer', 'zones', 0] }],
        }),
      },
      10_000,
    );
    expect(queryError).toMatchObject({ status: 'failed', errorCategory: 'query_error' });
    expect(queryError.output).toContain('unknown field "requestz" (at viewer.zones.0)');
    const auth = normalizeCloudflareGraphql(
      {
        httpStatus: 200,
        body: JSON.stringify({
          data: null,
          errors: [{ message: 'authentication error: token abc123 invalid' }],
        }),
      },
      10_000,
    );
    expect(auth).toMatchObject({ errorCategory: 'invalid_auth' });
    expect(auth.output).not.toContain('abc123');
    expect(classifyGraphqlErrors([{ message: 'zone "x" does not have access to the path' }])).toBe(
      'forbidden_scope',
    );
    expect(classifyGraphqlErrors([{ message: 'rate limiter budget depleted, quota' }])).toBe(
      'rate_limit',
    );
    // Partial data keeps the data and a bounded summary.
    const partial = normalizeCloudflareGraphql(
      {
        httpStatus: 200,
        body: JSON.stringify({ data: { a: 1 }, errors: [{ message: 'limit too large' }] }),
      },
      10_000,
    );
    expect(partial.status).toBe('completed');
    expect(partial.output).toContain('"partialErrors":["limit too large"]');
    expect(
      normalizeCloudflareGraphql({ httpStatus: 200, body: 'nope' }, 10_000).errorCategory,
    ).toBe('invalid_shape');
    expect(
      normalizeCloudflareGraphql({ errorCategory: 'rate_limit', httpStatus: 429, body: '' }, 10_000)
        .output,
    ).toBe('cloudflare_graphql: rate_limit: Cloudflare rate limit reached; do not retry now.');
  });

  it('returns REST results with paging only and classifies unsuccessful answers', () => {
    const ok = normalizeCloudflareRest(
      {
        httpStatus: 200,
        body: JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { id: ZONE_A.id },
          result_info: { page: 1 },
        }),
      },
      10_000,
    );
    expect(ok.output).toBe(`{"result":{"id":"${ZONE_A.id}"},"result_info":{"page":1}}`);
    expect(
      normalizeCloudflareRest(
        {
          httpStatus: 200,
          body: JSON.stringify({
            success: false,
            errors: [{ code: 9109, message: 'Invalid access token' }],
          }),
        },
        10_000,
      ).errorCategory,
    ).toBe('invalid_auth');
    expect(normalizeCloudflareRest({ httpStatus: 200, body: '[]' }, 10_000).errorCategory).toBe(
      'invalid_shape',
    );
  });

  it('bounds output with an explicit marker', () => {
    const bounded = boundCloudflareOutput('x'.repeat(5_000), 1_000);
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.output)).toBeLessThanOrEqual(1_000);
    expect(bounded.output).toMatch(/\[truncated: Cloudflare result exceeded the output limit\]$/);
  });

  it('fingerprints tokens and hashes zone sets stably', () => {
    expect(cloudflareCredentialFingerprint(TOKEN)).toMatch(/^[a-f0-9]{16}$/);
    expect(cloudflareCredentialFingerprint(TOKEN)).toBe(cloudflareCredentialFingerprint(TOKEN));
    expect(cloudflareCredentialFingerprint(`${TOKEN}x`)).not.toBe(
      cloudflareCredentialFingerprint(TOKEN),
    );
    expect(cloudflareZoneSetHash([ZONE_A, ZONE_B])).toBe(cloudflareZoneSetHash([ZONE_B, ZONE_A]));
    expect(cloudflareZoneSetHash([ZONE_A])).not.toBe(cloudflareZoneSetHash([ZONE_A, ZONE_B]));
    expect(cloudflareZoneSetHash([ZONE_A])).toMatch(/^[a-f0-9]{32}$/);
  });
});
