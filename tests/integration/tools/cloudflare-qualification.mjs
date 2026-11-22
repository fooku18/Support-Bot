#!/usr/bin/env node
/**
 * Bounded, read-only qualification of a Cloudflare API token against the
 * real API, through the compiled runtime adapter and provider (build
 * tool-runtime first). Run it BEFORE entering the token into a Cloudflare
 * tool instance in the admin UI: the instance's readiness probe only lists
 * zones, while this script also records the token's type, status and
 * permission policies, runs the scenario GraphQL query and proves with
 * --write-probe that Cloudflare itself refuses a write.
 *
 * The token is read from stdin only: never from argv (visible in the process
 * list), an env file or the environment. Nothing prints the token, traffic
 * values or zone content: only names, counts, field names, statuses and
 * categories.
 *
 *   read -rs CF_TOKEN && printf '%s' "$CF_TOKEN" | \
 *     node tests/integration/tools/cloudflare-qualification.mjs [--account <account id>] \
 *       [--zone-names a.example.com,b.example.com] [--verify] [--zones] \
 *       [--graphql <zone name>] [--hours 24] [--write-probe <zone name>]
 *
 * --write-probe sends ONE `POST /zones/{id}/purge_cache` for a URL that does
 * not exist (`https://<zone>/_support-agent-qualification-nonexistent`), bypassing
 * the runtime's GET/query-only guard on purpose: a read-only token must be
 * refused (HTTP 403). The operator confirms the endpoint and the zone before
 * it runs.
 *
 * Writes artifacts/cloudflare-qualification/<timestamp>.json.
 * Exit codes: 0 report written, 1 usage error, 2 blocked (no token),
 * 3 the write probe was accepted (over-scoped token: recreate it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let values;
try {
  ({ values } = parseArgs({
    options: {
      account: { type: 'string' },
      'zone-names': { type: 'string' },
      verify: { type: 'boolean', default: false },
      zones: { type: 'boolean', default: false },
      graphql: { type: 'string' },
      hours: { type: 'string', default: '24' },
      'write-probe': { type: 'string' },
    },
  }));
} catch (err) {
  console.error(
    `cloudflare-qualification: ${err instanceof Error ? err.message : 'invalid arguments'}`,
  );
  process.exit(1);
}
const accountId = (values.account ?? '').trim().toLowerCase() || null;
if (accountId !== null && !/^[0-9a-f]{32}$/.test(accountId)) {
  console.error('cloudflare-qualification: --account must be a Cloudflare account ID (32 hex)');
  process.exit(1);
}
const zoneNames = values['zone-names']
  ? values['zone-names']
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  : null;
const hours = Number(values.hours);
if (!Number.isInteger(hours) || hours < 1 || hours > 72) {
  console.error('cloudflare-qualification: --hours must be an integer from 1 to 72');
  process.exit(1);
}
if (process.stdin.isTTY) {
  console.error(
    'cloudflare-qualification: pipe the API token on stdin (it is never read from argv or an env file)',
  );
  process.exit(1);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const token = Buffer.concat(chunks).toString('utf8').trim();
if (!token || /<operator:/.test(token)) {
  console.error('BLOCKED: no Cloudflare API token on stdin');
  process.exit(2);
}

const dist = path.join(root, 'apps/tool-runtime/dist/qualification');
const adapter = await import(path.join(dist, 'cloudflare-api-adapter.js'));
const { CloudflareApiProvider } = await import(path.join(dist, 'cloudflare-api-provider.js'));

const scrub = (text) => String(text).replaceAll(token, '[redacted]');
const report = {
  at: new Date().toISOString(),
  endpoint: adapter.CLOUDFLARE_ENDPOINT,
  accountId,
  zoneNames,
  steps: {},
};

/** One trusted GET (qualification only: any path under the base path). */
async function get(pathname, query = {}) {
  const http = await adapter.sendCloudflareRequest(
    adapter.buildCloudflareRequest('get', { path: pathname, query }),
    token,
    { timeoutMs: 30_000, maxBytes: 1_000_000 },
  );
  if (http.errorCategory) return { httpStatus: http.httpStatus, category: http.errorCategory };
  try {
    const body = JSON.parse(http.body);
    return { httpStatus: http.httpStatus, body };
  } catch {
    return { httpStatus: http.httpStatus, category: 'invalid_shape' };
  }
}

/** Field names of a GraphQL result, never its values. */
function fieldNames(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? fieldNames(value[0], depth) : [];
  if (!value || typeof value !== 'object' || depth > 6) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...fieldNames(entry, depth + 1).map((name) => `${key}.${name}`),
  ]);
}

const provider = new CloudflareApiProvider({ accountId, zones: zoneNames, token });
const state = await provider.refresh();
report.readiness = {
  ready: state.ready,
  status: state.status,
  detail: scrub(state.detail),
  zoneCount: state.zones.length,
  zoneSetHash: state.zoneSetHash,
  credentialFingerprint: state.credentialFingerprint,
};

if (values.verify) {
  // User tokens verify at /user/tokens/verify, account tokens at
  // /accounts/{id}/tokens/verify; the implementation assumes neither.
  const user = await get('/user/tokens/verify');
  const verify = { user: { httpStatus: user.httpStatus, category: user.category ?? null } };
  let tokenType = null;
  let tokenId = null;
  if (user.body?.success === true) {
    tokenType = 'user';
    tokenId = user.body.result?.id ?? null;
    verify.status = user.body.result?.status ?? null;
    verify.expiresOn = user.body.result?.expires_on ?? null;
  } else if (accountId !== null) {
    const account = await get(`/accounts/${accountId}/tokens/verify`);
    verify.account = { httpStatus: account.httpStatus, category: account.category ?? null };
    if (account.body?.success === true) {
      tokenType = 'account';
      tokenId = account.body.result?.id ?? null;
      verify.status = account.body.result?.status ?? null;
      verify.expiresOn = account.body.result?.expires_on ?? null;
    }
  }
  verify.tokenType = tokenType;
  if (tokenId !== null && typeof tokenId === 'string' && /^[0-9a-f]{32}$/.test(tokenId)) {
    // Permission policies when the token may read itself (names only).
    const detail =
      tokenType === 'user'
        ? await get(`/user/tokens/${tokenId}`)
        : await get(`/accounts/${accountId}/tokens/${tokenId}`);
    verify.policies =
      detail.body?.success === true
        ? (detail.body.result?.policies ?? []).map((policy) => ({
            effect: policy.effect ?? null,
            permissionGroups: (policy.permission_groups ?? []).map((group) => group.name ?? null),
            resourceCount: Object.keys(policy.resources ?? {}).length,
          }))
        : { httpStatus: detail.httpStatus, category: detail.category ?? 'not_returned' };
  }
  report.steps.verify = verify;
}

if (values.zones) {
  report.steps.zones = {
    count: state.zones.length,
    names: state.zones.map((zone) => zone.name),
    statuses: [...new Set(state.zones.map((zone) => zone.status))],
    plans: [...new Set(state.zones.map((zone) => zone.plan))],
  };
}

const zoneByName = (name) => state.zones.find((zone) => zone.name === name.trim().toLowerCase());

if (values.graphql) {
  const zone = zoneByName(values.graphql);
  if (zone === undefined)
    report.steps.graphql = { zone: values.graphql, error: 'zone not visible' };
  else {
    const end = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const start = new Date(end.getTime() - hours * 3_600_000);
    const query = `query Hourly($zoneTag: string, $start: Time, $end: Time) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(limit: ${hours * 2}, filter: { datetime_geq: $start, datetime_lt: $end }, orderBy: [datetimeHour_ASC]) {
        count
        dimensions { datetimeHour }
        sum { edgeResponseBytes }
      }
      firewallEventsAdaptiveGroups(limit: 20, filter: { datetime_geq: $start, datetime_lt: $end }, orderBy: [count_DESC]) {
        count
        dimensions { action }
      }
    }
  }
}`;
    const started = Date.now();
    const http = await adapter.sendCloudflareRequest(
      adapter.buildCloudflareRequest(
        'graphql',
        adapter.validateCloudflareGraphql(
          {
            query,
            variables: { zoneTag: zone.id, start: start.toISOString(), end: end.toISOString() },
          },
          provider.scope(),
        ),
      ),
      token,
      { timeoutMs: 60_000 },
    );
    const step = {
      zone: zone.name,
      window: { start: start.toISOString(), end: end.toISOString() },
      httpStatus: http.httpStatus,
      category: http.errorCategory ?? null,
      durationMs: Date.now() - started,
    };
    if (!http.errorCategory) {
      try {
        const body = JSON.parse(http.body);
        const zones = body.data?.viewer?.zones ?? [];
        step.errors = Array.isArray(body.errors)
          ? body.errors.map((error) => scrub(error?.message ?? 'error').slice(0, 200))
          : [];
        step.hourlyRows = zones[0]?.httpRequestsAdaptiveGroups?.length ?? null;
        step.firewallGroups = zones[0]?.firewallEventsAdaptiveGroups?.length ?? null;
        step.fieldNames = [...new Set(fieldNames(body.data ?? {}))].slice(0, 40);
      } catch {
        step.category = 'invalid_shape';
      }
    }
    report.steps.graphql = step;
  }
}

let overScoped = false;
if (values['write-probe']) {
  const zone = zoneByName(values['write-probe']);
  if (zone === undefined)
    report.steps.writeProbe = { zone: values['write-probe'], error: 'zone not visible' };
  else {
    // Raw request, bypassing the runtime's GET/query-only guard on purpose:
    // Cloudflare itself must refuse the write for a read-only token. The URL
    // does not exist, so even an accepted purge has no effect.
    const url = new URL(
      `${adapter.CLOUDFLARE_BASE_PATH}/zones/${zone.id}/purge_cache`,
      adapter.CLOUDFLARE_API_ORIGIN,
    );
    let status = null;
    let codes = [];
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          files: [`https://${zone.name}/_support-agent-qualification-nonexistent`],
        }),
      });
      status = response.status;
      const body = await response.json().catch(() => ({}));
      codes = (body?.errors ?? []).map((error) => error?.code ?? null);
    } catch (err) {
      status = err instanceof Error ? `network: ${err.name}` : 'network';
    }
    overScoped = typeof status === 'number' && status >= 200 && status < 300;
    report.steps.writeProbe = {
      zone: zone.name,
      request: 'POST /zones/{id}/purge_cache (nonexistent URL)',
      httpStatus: status,
      errorCodes: codes,
      refusedByCloudflare: status === 403,
      verdict: overScoped
        ? 'ACCEPTED: the token can purge cache; it is over-scoped and must be recreated with Read permissions only'
        : status === 403
          ? 'refused (403): the token has no Cache Purge permission'
          : 'inconclusive: expected HTTP 403',
    };
  }
}

const dir = path.join(root, 'artifacts/cloudflare-qualification');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${report.at.replaceAll(':', '-')}.json`);
const text = scrub(JSON.stringify(report, null, 2));
fs.writeFileSync(file, `${text}\n`);
console.log(text);
console.log(`report: ${path.relative(root, file)}`);
process.exit(overScoped ? 3 : 0);
