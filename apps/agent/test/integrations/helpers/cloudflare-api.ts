/**
 * Deterministic fake Cloudflare REST and GraphQL API behind an injected
 * fetch: paginated `GET /zones`, `GET /accounts/{id}`, `POST /graphql` and
 * any other GET answered by a handler. Records every request with its
 * method, URL, headers and body.
 */
import type { CloudflareFetch } from '../../../src/integrations/cloudflare/cloudflare-api-adapter.js';

export const ZONE_A = { id: 'a'.repeat(32), name: 'cloud.example.com' };
export const ZONE_B = { id: 'b'.repeat(32), name: 'shop.example.com' };
export const ACCOUNT_ID = 'c'.repeat(32);

export interface SeenCloudflareRequest {
  method: string;
  url: URL;
  authorization: string | null;
  contentType: string | null;
  redirect: Parameters<CloudflareFetch>[1]['redirect'];
  body: unknown;
}

export interface FakeCloudflareOptions {
  zones?: Array<{ id: string; name: string; status?: string; plan?: string }>;
  /** Status for every request (e.g. 403) when set; the body carries `errorCode` and `errorMessage`. */
  status?: number;
  errorCode?: number;
  errorMessage?: string;
  /** Status of `GET /accounts/{id}`. */
  accountStatus?: number;
  graphql?: (body: { query: string; variables: Record<string, unknown> }) => unknown;
  get?: (url: URL) => unknown;
}

export function fakeCloudflare(options: FakeCloudflareOptions = {}): {
  fetchImpl: CloudflareFetch;
  seen: SeenCloudflareRequest[];
} {
  const seen: SeenCloudflareRequest[] = [];
  const suppliedZones: NonNullable<FakeCloudflareOptions['zones']> = options.zones ?? [
    ZONE_A,
    ZONE_B,
  ];
  const zones = suppliedZones.map((zone) => ({
    id: zone.id,
    name: zone.name,
    status: zone.status ?? 'active',
    plan: { name: zone.plan ?? 'Enterprise Website' },
    account: { id: ACCOUNT_ID, name: 'Example' },
  }));
  const fetchImpl: CloudflareFetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    seen.push({
      method: init.method ?? 'GET',
      url,
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      redirect: init.redirect,
      body,
    });
    if (options.status !== undefined)
      return Response.json(
        {
          success: false,
          errors: [{ code: options.errorCode ?? 0, message: options.errorMessage ?? 'refused' }],
        },
        { status: options.status },
      );
    const path = url.pathname.replace(/^\/client\/v4/, '');
    if (init.method === 'POST' && path === '/graphql')
      return Response.json(
        options.graphql?.(body as { query: string; variables: Record<string, unknown> }) ?? {
          data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } },
          errors: null,
        },
      );
    if (path === '/zones') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '20');
      const slice = zones.slice((page - 1) * perPage, page * perPage);
      return Response.json({
        success: true,
        errors: [],
        result: slice,
        result_info: {
          page,
          per_page: perPage,
          count: slice.length,
          total_count: zones.length,
          total_pages: Math.max(1, Math.ceil(zones.length / perPage)),
        },
      });
    }
    if (/^\/accounts\/[0-9a-f]{32}$/.test(path)) {
      if (options.accountStatus !== undefined && options.accountStatus !== 200)
        return Response.json(
          { success: false, errors: [{ code: 9999, message: 'no' }] },
          { status: options.accountStatus },
        );
      return Response.json({ success: true, result: { id: path.slice(10), name: 'Example' } });
    }
    const answer = options.get?.(url);
    if (answer instanceof Response) return answer;
    return Response.json(answer ?? { success: true, errors: [], result: { path } });
  };
  return { fetchImpl, seen };
}
