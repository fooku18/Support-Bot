#!/usr/bin/env node
/**
 * Bounded, read-only qualification of a Datadog access token against the
 * real MCP server, through the compiled runtime adapter (build tool-runtime
 * first). Run it BEFORE entering the token into a Datadog tool instance in
 * the admin UI: the instance's background readiness probe only lists the
 * catalog, while this script also describes/calls tools and proves with
 * --write-probe that Datadog itself refuses a write under scope mcp_read.
 *
 * Tokens are no longer kept in env files (tools are admin-managed instances),
 * so the token is read from stdin only: never from argv (visible in the
 * process list), an env file or the environment. Nothing prints the token,
 * log content or tool results — only names, counts, shapes and categories.
 *
 *   read -rs DD_TOKEN && printf '%s' "$DD_TOKEN" | \
 *     node tests/integration/tools/datadog-qualification.mjs --site datadoghq.eu [--toolsets all] \
 *       [--catalog] [--describe tool,...] [--call tool --args '{"query":"…"}'] \
 *       [--write-probe tool --args '{…}']
 *
 * Writes artifacts/datadog-qualification/<timestamp>.json.
 * Exit codes: 0 report written, 1 usage error, 2 blocked (no token).
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
      site: { type: 'string' },
      toolsets: { type: 'string', default: 'all' },
      catalog: { type: 'boolean', default: false },
      describe: { type: 'string' },
      call: { type: 'string' },
      'write-probe': { type: 'string' },
      args: { type: 'string', default: '{}' },
    },
  }));
} catch (err) {
  console.error(
    `datadog-qualification: ${err instanceof Error ? err.message : 'invalid arguments'}`,
  );
  process.exit(1);
}
const site = (values.site ?? '').trim().toLowerCase();
if (!/^([a-z0-9]{2,8}\.)?datadoghq\.(com|eu)$/.test(site)) {
  console.error(
    'datadog-qualification: --site <site> is required (a commercial Datadog site such as datadoghq.eu)',
  );
  process.exit(1);
}
if (process.stdin.isTTY) {
  console.error(
    'datadog-qualification: pipe the access token on stdin (it is never read from argv or an env file)',
  );
  process.exit(1);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const token = Buffer.concat(chunks).toString('utf8').trim();
if (!token || /<operator:/.test(token)) {
  console.error('BLOCKED: no Datadog access token on stdin');
  process.exit(2);
}

const dist = path.join(root, 'apps/tool-runtime/dist/qualification');
const adapter = await import(path.join(dist, 'datadog-mcp-adapter.js'));
const { DatadogMcpProvider } = await import(path.join(dist, 'datadog-mcp-provider.js'));

const scrub = (text) => String(text).replaceAll(token, '[redacted]');
const report = { at: new Date().toISOString(), site, toolsets: values.toolsets, steps: {} };

/** Shape of a result text without its content. */
function shape(text) {
  const out = { bytes: Buffer.byteLength(text), lines: text.split('\n').length };
  try {
    const data = JSON.parse(text);
    const describe = (value, depth) => {
      if (Array.isArray(value))
        return {
          array: value.length,
          item: depth < 3 && value.length ? describe(value[0], depth + 1) : undefined,
        };
      if (value && typeof value === 'object')
        return depth < 3
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describe(v, depth + 1)]))
          : 'object';
      return typeof value;
    };
    out.json = describe(data, 0);
  } catch {
    out.json = null;
    out.keyNames = [
      ...new Set(
        [...text.matchAll(/^\s*"?([A-Za-z_][A-Za-z0-9_]{0,40})"?\s*[:=]/gm)].map((m) => m[1]),
      ),
    ].slice(0, 40);
  }
  return out;
}

const provider = new DatadogMcpProvider({ site, toolsets: values.toolsets, token });
const state = await provider.refresh();
report.readiness = {
  ready: state.ready,
  status: state.status,
  detail: scrub(state.detail),
  site: state.site,
  endpoint: state.endpoint,
  protocolVersion: state.protocolVersion,
  serverName: state.serverName,
  serverVersion: state.serverVersion,
  toolsets: state.toolsets,
  toolCatalogHash: state.toolCatalogHash,
  toolCount: state.tools.length,
  excludedCount: state.excludedTools.length,
  credentialFingerprint: state.credentialFingerprint,
};
const catalog = provider.snapshotCatalog();
if (values.catalog) {
  report.steps.catalog = {
    tools: state.tools,
    excludedTools: state.excludedTools,
    schemaBytes: Buffer.byteLength(JSON.stringify(catalog.tools)),
  };
}
if (values.describe) {
  report.steps.describe = Object.fromEntries(
    values.describe.split(',').map((name) => {
      const tool = catalog.tools.find((entry) => entry.name === name);
      return [
        name,
        tool ? { description: tool.description, inputSchema: tool.inputSchema } : 'not in catalog',
      ];
    }),
  );
}
const args = JSON.parse(values.args);
if (values.call) {
  const started = Date.now();
  const result = await provider.call(values.call, args, {
    timeoutMs: 60_000,
    maxOutputBytes: 200_000,
  });
  report.steps.call = {
    tool: values.call,
    args,
    status: result.status,
    errorCategory: result.errorCategory ?? null,
    refused: result.refused ? scrub(result.refused) : null,
    truncated: result.truncated ?? false,
    durationMs: Date.now() - started,
    shape: shape(scrub(result.output)),
  };
}
if (values['write-probe']) {
  // Raw session, bypassing the catalog exclusion on purpose: Datadog itself
  // must refuse the write under scope mcp_read.
  const session = new adapter.DatadogMcpSession({
    site: state.site,
    toolsets: state.toolsets,
    token,
  });
  const result = await session.callTool(values['write-probe'], args, {
    timeoutMs: 60_000,
    maxOutputBytes: 4_000,
  });
  report.steps.writeProbe = {
    tool: values['write-probe'],
    args,
    status: result.status,
    errorCategory: result.errorCategory ?? null,
    refusedByDatadog: result.status !== 'completed',
    message:
      result.status === 'completed'
        ? '(completed: over-scoped token)'
        : scrub(result.output).slice(0, 400),
  };
  await session.reset();
}
const dir = path.join(root, 'artifacts/datadog-qualification');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${report.at.replaceAll(':', '-')}.json`);
const text = scrub(JSON.stringify(report, null, 2));
fs.writeFileSync(file, `${text}\n`);
console.log(text);
console.log(`report: ${path.relative(root, file)}`);
process.exit(0);
