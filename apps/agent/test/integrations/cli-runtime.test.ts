import { testSelection } from '../model-fixture.js';
/**
 * Isolated tool runtime: admin-managed GitLab/Atlassian/Datadog instances,
 * per-instance credentials and readiness, workspace binding, credential
 * scoping, sandbox round trip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  assertCliRuntimeEnvClean,
  classifyProbeOutput,
  CliInstanceRegistry,
  createTextRetainer,
  glabBinaryPath,
  handleAtlassian,
  handleGitlab,
  stdioDrained,
  initialGitlabState,
  inspectGlabBinary,
  PROBE_ATTEMPTS,
  PROBE_RETRY_MS,
  probeGlab,
  redactCliOutput,
  redactRuntimeOutput,
  redactTraceOutput,
  setInstanceRegistry,
  type CliInstanceRegistryDeps,
  type GlabBinary,
  type ProbeResult,
  type ProviderState,
  trustedSpawnEnv,
} from '../../../tool-runtime/src/main.js';
import { configureOutbound, sandboxProxyEnv } from '../../src/infrastructure/outbound.js';
import { normalizeGitlabOutput } from '../../src/integrations/gitlab/gitlab-cli-adapter.js';
import { validateGitlabOperation } from '../../src/integrations/gitlab/gitlab-operations.js';
import {
  ATLASSIAN_READINESS_REFRESH_MS,
  AtlassianRestProvider,
} from '../../src/integrations/atlassian/atlassian-rest-provider.js';
import { DatadogMcpProvider } from '../../src/integrations/datadog/datadog-mcp-provider.js';
import { compileDocument } from '../../../admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';
import { nativeReadServices } from '../../src/application/bindings/read-services.js';
import { createReadServiceTools } from '../../src/mastra/tools/read-services.js';
import type { AtlassianFetch } from '../../src/integrations/atlassian/atlassian-rest-adapter.js';
import {
  ToolInstanceError,
  type SyncedToolInstance,
  type ToolInstanceStatusReport,
} from '../../src/integrations/tools/tool-instances.js';
import { fakeDatadog } from './helpers/datadog-mcp.js';

const TEAM = 'T0TEAM1';
const OTHER_TEAM = 'T0OTHER';
const GITLAB_HOST = 'gitlab.example.invalid';
const SITE = 's.atlassian.net';
const CLOUD_ID = '00000000-0000-4000-8000-000000000000';

const GITLAB_ID = 'ti_0000000000000001';
const GITLAB_B_ID = 'ti_0000000000000002';
const ATLASSIAN_ID = 'ti_0000000000000003';
const DATADOG_ID = 'ti_0000000000000004';

function gitlabInstance(
  overrides: Partial<SyncedToolInstance<'gitlab'>> = {},
): SyncedToolInstance<'gitlab'> {
  return {
    id: GITLAB_ID,
    teamId: TEAM,
    kind: 'gitlab',
    label: 'GitLab (test)',
    host: GITLAB_HOST,
    settings: {},
    credentialVersion: 1,
    hasCredential: true,
    ...overrides,
  };
}

function atlassianInstance(
  overrides: Partial<SyncedToolInstance<'atlassian'>> = {},
): SyncedToolInstance<'atlassian'> {
  return {
    id: ATLASSIAN_ID,
    teamId: TEAM,
    kind: 'atlassian',
    label: 'Jira (test)',
    host: SITE,
    settings: { cloudId: CLOUD_ID, email: 'test@example.invalid', operations: null },
    credentialVersion: 1,
    hasCredential: true,
    ...overrides,
  };
}

function datadogInstance(
  overrides: Partial<SyncedToolInstance<'datadog'>> = {},
): SyncedToolInstance<'datadog'> {
  return {
    id: DATADOG_ID,
    teamId: TEAM,
    kind: 'datadog',
    label: 'Datadog (test)',
    host: 'datadoghq.eu',
    settings: { toolsets: 'all', denyTools: [] },
    credentialVersion: 1,
    hasCredential: true,
    ...overrides,
  };
}

const listing = (...instances: SyncedToolInstance[]) =>
  new Map(instances.map((instance) => [instance.id, instance]));

const MISSING_GLAB: GlabBinary = {
  path: '/nonexistent/glab',
  installed: false,
  sha256: null,
  version: null,
};

function binaryInfo(binary: string): GlabBinary {
  return {
    path: binary,
    installed: true,
    sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    version: 'glab test',
  };
}

function readyState(binary: string, host: string): ProviderState {
  return {
    ...initialGitlabState(host, binaryInfo(binary)),
    ready: true,
    status: 'ready',
    detail: 'test-qualified',
  };
}

/** Synthetic Atlassian answering readiness probes and one issue read. */
function fakeAtlassian(requests: URL[] = []): AtlassianFetch {
  return async (url) => {
    requests.push(url);
    const json = (data: unknown) => new Response(JSON.stringify(data));
    if (url.pathname.endsWith('/serverInfo')) return json({ baseUrl: `https://${SITE}` });
    if (url.pathname.endsWith('/myself')) return json({ accountId: 'a' });
    if (url.pathname.endsWith('/wiki/api/v2/spaces'))
      return json({ results: [], _links: { base: `https://${SITE}/wiki` } });
    return json({
      key: 'ABC-1',
      fields: { summary: 'echo synthetic-jira-token-value', status: { name: 'Done' } },
    });
  };
}

/** Registry with injected secret source, status sink and probes (never real network). */
function harness(overrides: Partial<CliInstanceRegistryDeps> = {}) {
  const reports: ToolInstanceStatusReport[] = [];
  const secretCalls: string[] = [];
  const probeCalls: Array<{ host: string; credential: string; binary: string }> = [];
  const secrets = new Map<string, { credential: string; credentialVersion: number }>();
  let probeAnswers: ProbeResult[] = [];
  const registry = new CliInstanceRegistry({
    admitted: {
      gitlab: new Set([GITLAB_HOST]),
      atlassian: new Set([SITE]),
      datadog: new Set(['datadoghq.eu']),
      cloudflare: new Set(['api.cloudflare.com']),
    },
    glab: { path: '/opt/glab', installed: true, sha256: 'a'.repeat(64), version: 'glab test' },
    secret: async (instanceId) => {
      secretCalls.push(instanceId);
      const secret = secrets.get(instanceId);
      if (secret === undefined)
        throw new ToolInstanceError(`tool instance ${instanceId} has no usable credential`);
      return secret;
    },
    report: async (statuses) => {
      reports.push(...statuses);
    },
    probeGitlab: async (host, credential, binary) => {
      probeCalls.push({ host, credential, binary });
      return (
        probeAnswers.shift() ?? {
          ok: true,
          status: 'ready',
          detail: 'authenticated against the instance host',
        }
      );
    },
    atlassianFetch: fakeAtlassian(),
    ...overrides,
  });
  setInstanceRegistry(registry);
  return {
    registry,
    reports,
    secretCalls,
    probeCalls,
    secrets,
    answerProbes: (answers: ProbeResult[]) => {
      probeAnswers = answers;
    },
  };
}

/** Fake launcher emulating tool-sandbox.sh: source the env file, map /tmp, exec the binary. */
function fakeSandbox(root: string): string {
  const sandbox = path.join(root, 'sandbox');
  fs.writeFileSync(
    sandbox,
    '#!/bin/bash\nstaging=$1; shift 2; [[ "$1" == --cwd=* ]] && shift; set -a; . "$staging/env"; set +a; export SANDBOX_TMP="$staging/tmp"; exec "$@"\n',
    { mode: 0o755 },
  );
  return sandbox;
}

const call = (
  operation: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  instanceId: GITLAB_ID,
  teamId: TEAM,
  operation,
  operationArgs: validateGitlabOperation(operation, args),
  timeoutMs: 20_000,
  maxOutputBytes: 100_000,
  ...extra,
});

afterEach(() => {
  setInstanceRegistry(null);
  vi.useRealTimers();
});

describe('cli-runtime environment', () => {
  it('refuses controller credentials, requires its token and refuses the removed tool variables', () => {
    const base = { CLI_RUNTIME_TOKEN: 'runtime-token' };
    assertCliRuntimeEnvClean(base);
    // The egress allowlists and the admin endpoint are the new configuration.
    assertCliRuntimeEnvClean({
      ...base,
      GITLAB_HOSTS: GITLAB_HOST,
      ATLASSIAN_SITES: SITE,
      DATADOG_SITES: 'datadoghq.eu',
      CLOUDFLARE_HOSTS: 'api.cloudflare.com',
      ADMIN_URL: 'http://admin:9883',
      ADMIN_INTERNAL_TOKEN: 'admin-token',
    });
    expect(() => assertCliRuntimeEnvClean({ ...base, SUPPORT_AGENT_SERVICE_TOKEN: 'x' })).toThrow(
      /must not receive controller credentials \(SUPPORT_AGENT_SERVICE_TOKEN\)/,
    );
    expect(() => assertCliRuntimeEnvClean({ ...base, SLACK_BOT_TOKEN: 'xoxb-1' })).toThrow(
      /controller credentials/,
    );
    expect(() => assertCliRuntimeEnvClean({})).toThrow(/CLI_RUNTIME_TOKEN is required/);
    expect(() => assertCliRuntimeEnvClean({ CLI_RUNTIME_TOKEN: '  ' })).toThrow(
      /CLI_RUNTIME_TOKEN is required/,
    );
    for (const name of [
      'GITLAB_HOST',
      'GITLAB_TOKEN',
      'ATLASSIAN_ENABLED',
      'ATLASSIAN_SITE',
      'ATLASSIAN_CLOUD_ID',
      'ATLASSIAN_EMAIL',
      'ATLASSIAN_JIRA_API_TOKEN',
      'ATLASSIAN_CONFLUENCE_API_TOKEN',
      'ATLASSIAN_API_TOKEN',
      'DATADOG_ENABLED',
      'DATADOG_SITE',
      'DATADOG_ACCESS_TOKEN',
      'DATADOG_TOOLSETS',
      'CLI_ACLI_ENABLED',
      'MCP_ATLASSIAN_ENABLED',
      'ATLASSIAN_MCP_API_KEY',
      'TOOL_ACLI_BIN',
      'CLI_RUNTIME_AUTH_DIR',
    ]) {
      // Even an empty value is refused: the variable must be gone.
      for (const value of ['', 'value-that-must-not-leak'])
        expect(() => assertCliRuntimeEnvClean({ ...base, [name]: value })).toThrow(
          new RegExp(
            `obsolete tool variables \\(tools are admin-managed instances now\\): ${name}$`,
          ),
        );
    }
    try {
      assertCliRuntimeEnvClean({ ...base, GITLAB_TOKEN: 'value-that-must-not-leak' });
    } catch (err) {
      expect(String(err)).not.toContain('value-that-must-not-leak');
    }
  });

  it('packages glab at a fixed path; the override must be absolute without traversal', () => {
    expect(glabBinaryPath({})).toBe('/usr/local/bin/glab');
    expect(glabBinaryPath({ TOOL_GLAB_BIN: '/opt/glab' })).toBe('/opt/glab');
    expect(() => glabBinaryPath({ TOOL_GLAB_BIN: 'glab' })).toThrow(/absolute path/);
    expect(() => glabBinaryPath({ TOOL_GLAB_BIN: '/opt/../bin/glab' })).toThrow(/traversal/);
  });

  it('inspects the glab binary and derives the pre-probe state (version/digest informational)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-binary-'));
    try {
      const binary = path.join(root, 'glab');
      fs.writeFileSync(binary, '#!/bin/sh\necho "glab 9.9.9 (test)"\n', { mode: 0o755 });
      const info = inspectGlabBinary(binary);
      expect(info).toMatchObject({ path: binary, installed: true, version: 'glab 9.9.9 (test)' });
      expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(initialGitlabState(GITLAB_HOST, info)).toEqual({
        tool: 'glab',
        ready: false,
        status: 'pending',
        detail: 'readiness has not been established yet',
        version: 'glab 9.9.9 (test)',
        binaryPath: binary,
        binarySha256: info.sha256,
        host: GITLAB_HOST,
        contractVersion: 5,
      });
      const plain = path.join(root, 'not-executable');
      fs.writeFileSync(plain, 'x', { mode: 0o644 });
      for (const missing of [path.join(root, 'missing'), plain, root]) {
        const absent = inspectGlabBinary(missing);
        expect(absent).toEqual({ path: missing, installed: false, sha256: null, version: null });
        expect(initialGitlabState(GITLAB_HOST, absent)).toMatchObject({
          ready: false,
          status: 'missing_binary',
          binaryPath: null,
        });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cli-runtime instance registry', () => {
  it('blocks an instance on a non-admitted host: never fetches its secret, never probes it', async () => {
    const h = harness();
    h.secrets.set(GITLAB_ID, { credential: 'glpat-blocked-secret', credentialVersion: 1 });
    await h.registry.apply(
      listing(
        gitlabInstance({ host: 'gitlab.evil.example' }),
        atlassianInstance({ host: 'other.atlassian.net' }),
        datadogInstance({ host: 'us5.datadoghq.com' }),
      ),
    );
    expect(h.secretCalls).toEqual([]);
    expect(h.probeCalls).toEqual([]);
    expect(h.reports).toEqual([
      {
        instanceId: GITLAB_ID,
        state: 'blocked',
        detail:
          'host not admitted: gitlab.evil.example is not in GITLAB_HOSTS (operator egress allowlist)',
        credentialVersion: 1,
        toolsCount: null,
      },
      expect.objectContaining({
        instanceId: ATLASSIAN_ID,
        state: 'blocked',
        detail: expect.stringMatching(/other\.atlassian\.net is not in ATLASSIAN_SITES/),
      }),
      expect.objectContaining({
        instanceId: DATADOG_ID,
        state: 'blocked',
        detail: expect.stringMatching(/us5\.datadoghq\.com is not in DATADOG_SITES/),
      }),
    ]);
    expect(h.registry.statuses().map((s) => s.state)).toEqual(['blocked', 'blocked', 'blocked']);
    // A blocked instance is refused, never used.
    const refused = await handleGitlab(call('get_project', { project: 'g/p' }));
    expect(refused).toMatchObject({ status: 'not_run' });
    expect(refused.refused).toMatch(/is blocked: host not admitted/);
  });

  it('retries an instance whose credential could not be read (the listing stays unchanged)', async () => {
    const h = harness();
    await h.registry.apply(listing(gitlabInstance()));
    expect(h.registry.statuses()[0]).toMatchObject({ state: 'error' });
    expect(h.registry.statuses()[0]?.detail).toMatch(/^credential unavailable/);
    // The same listing again (a 304 would not even call apply): no retry.
    await h.registry.apply(listing(gitlabInstance()));
    expect(h.secretCalls).toEqual([GITLAB_ID, GITLAB_ID]);
    // The admin service answers again; the retry timer re-reads it.
    h.secrets.set(GITLAB_ID, { credential: 'glpat-retried-secret', credentialVersion: 1 });
    await h.registry.retryTransient();
    await vi.waitFor(() => expect(h.registry.statuses()[0]?.state).toBe('ready'));
    expect(h.secretCalls).toHaveLength(3);
    // Nothing transient left: a retry is a no-op.
    await h.registry.retryTransient();
    expect(h.secretCalls).toHaveLength(3);
    expect(JSON.stringify(h.registry.statuses())).not.toContain('glpat-retried-secret');
  });

  it('reports an instance without a usable credential as error', async () => {
    const h = harness();
    h.secrets.set(ATLASSIAN_ID, { credential: 'not-json', credentialVersion: 1 });
    await h.registry.apply(
      listing(
        gitlabInstance({ hasCredential: false }),
        // hasCredential, but the admin answers 404 (disabled meanwhile).
        gitlabInstance({ id: GITLAB_B_ID }),
        atlassianInstance(),
      ),
    );
    expect(h.secretCalls).toEqual([GITLAB_B_ID, ATLASSIAN_ID]);
    expect(h.probeCalls).toEqual([]);
    expect(h.reports).toEqual([
      {
        instanceId: GITLAB_ID,
        state: 'error',
        detail: 'no credential',
        credentialVersion: 1,
        toolsCount: null,
      },
      {
        instanceId: GITLAB_B_ID,
        state: 'error',
        detail: `credential unavailable: tool instance ${GITLAB_B_ID} has no usable credential`,
        credentialVersion: 1,
        toolsCount: null,
      },
      {
        instanceId: ATLASSIAN_ID,
        state: 'error',
        detail: 'credential is malformed',
        credentialVersion: 1,
        toolsCount: null,
      },
    ]);
    // Without a secret source nothing can become usable.
    const bare = new CliInstanceRegistry({
      admitted: {
        gitlab: new Set([GITLAB_HOST]),
        atlassian: new Set(),
        datadog: new Set(),
        cloudflare: new Set(),
      },
      glab: MISSING_GLAB,
    });
    await bare.apply(listing(gitlabInstance()));
    expect(bare.statuses()[0]).toMatchObject({ state: 'error', detail: 'no credential' });
  });

  it('prepares, probes in the background and reports each outcome with the credential version', async () => {
    const datadog = fakeDatadog();
    const h = harness({ datadogFetch: datadog.fetchImpl });
    h.secrets.set(GITLAB_ID, { credential: 'glpat-runtime-held-secret', credentialVersion: 3 });
    h.secrets.set(ATLASSIAN_ID, {
      credential: JSON.stringify({ jira: 'synthetic-jira-token-value' }),
      credentialVersion: 2,
    });
    h.secrets.set(DATADOG_ID, { credential: 'dd-held-token-123456', credentialVersion: 5 });
    await h.registry.apply(
      listing(
        gitlabInstance({ credentialVersion: 3 }),
        atlassianInstance({ credentialVersion: 2 }),
        datadogInstance({ credentialVersion: 5 }),
        // Kinds of the web runtime are not served here.
        {
          id: 'ti_0000000000000009',
          teamId: TEAM,
          kind: 'webFetch',
          label: 'Web fetch',
          host: null,
          settings: {},
          credentialVersion: 0,
          hasCredential: false,
        },
      ),
    );
    await vi.waitFor(() => expect(h.reports).toHaveLength(3));
    expect(h.probeCalls).toEqual([
      { host: GITLAB_HOST, credential: 'glpat-runtime-held-secret', binary: '/opt/glab' },
    ]);
    const byId = new Map(h.reports.map((report) => [report.instanceId, report]));
    expect(byId.get(GITLAB_ID)).toEqual({
      instanceId: GITLAB_ID,
      state: 'ready',
      detail: 'authenticated against the instance host',
      credentialVersion: 3,
      toolsCount: null,
    });
    expect(byId.get(ATLASSIAN_ID)).toMatchObject({
      state: 'ready',
      credentialVersion: 2,
      toolsCount: null,
    });
    expect(byId.get(DATADOG_ID)).toMatchObject({
      state: 'ready',
      credentialVersion: 5,
      toolsCount: 3,
    });
    const statuses = h.registry.statuses();
    expect(statuses.map((s) => [s.instanceId, s.kind, s.state])).toEqual([
      [GITLAB_ID, 'gitlab', 'ready'],
      [ATLASSIAN_ID, 'atlassian', 'ready'],
      [DATADOG_ID, 'datadog', 'ready'],
    ]);
    expect(statuses[1]?.atlassian).toMatchObject({
      site: SITE,
      cloudId: CLOUD_ID,
      products: { jira: 'ready', confluence: 'not_configured' },
    });
    expect(datadog.seen[0]?.authorization).toBe('Bearer dd-held-token-123456');
    // Secrets are held for redaction only; neither statuses nor reports carry them.
    const held = h.registry.secrets();
    expect(held).toEqual(
      expect.arrayContaining([
        'glpat-runtime-held-secret',
        'synthetic-jira-token-value',
        'dd-held-token-123456',
      ]),
    );
    for (const secret of held) {
      expect(JSON.stringify(statuses)).not.toContain(secret);
      expect(JSON.stringify(h.reports)).not.toContain(secret);
    }
  });

  it('reconciles listings: removes vanished instances, re-prepares on a credential version change', async () => {
    const h = harness();
    h.secrets.set(GITLAB_ID, { credential: 'glpat-first-secret', credentialVersion: 1 });
    h.secrets.set(GITLAB_B_ID, { credential: 'glpat-second-secret', credentialVersion: 1 });
    await h.registry.apply(listing(gitlabInstance(), gitlabInstance({ id: GITLAB_B_ID })));
    await vi.waitFor(() => expect(h.reports).toHaveLength(2));
    expect(h.secretCalls).toEqual([GITLAB_ID, GITLAB_B_ID]);

    // Unchanged listing: nothing is re-fetched or re-probed.
    await h.registry.apply(listing(gitlabInstance(), gitlabInstance({ id: GITLAB_B_ID })));
    expect(h.secretCalls).toHaveLength(2);
    expect(h.probeCalls).toHaveLength(2);

    // B vanished (disabled or deleted): no longer served, its credential dropped.
    await h.registry.apply(listing(gitlabInstance()));
    expect(h.registry.get(GITLAB_B_ID)).toBeUndefined();
    expect(h.registry.statuses().map((s) => s.instanceId)).toEqual([GITLAB_ID]);
    expect(h.registry.secrets()).not.toContain('glpat-second-secret');
    const gone = await handleGitlab(
      call('get_project', { project: 'g/p' }, { instanceId: GITLAB_B_ID }),
    );
    expect(gone.refused).toBe('unknown gitlab tool instance');

    // Rotation: a new credential version re-fetches the secret and re-probes.
    h.secrets.set(GITLAB_ID, { credential: 'glpat-rotated-secret', credentialVersion: 2 });
    await h.registry.apply(listing(gitlabInstance({ credentialVersion: 2 })));
    await vi.waitFor(() => expect(h.reports).toHaveLength(3));
    expect(h.secretCalls).toEqual([GITLAB_ID, GITLAB_B_ID, GITLAB_ID]);
    expect(h.probeCalls.at(-1)).toMatchObject({ credential: 'glpat-rotated-secret' });
    expect(h.reports.at(-1)).toMatchObject({ instanceId: GITLAB_ID, credentialVersion: 2 });
    expect(h.registry.secrets()).toEqual(['glpat-rotated-secret']);
    expect(h.registry.statuses()[0]?.credentialVersion).toBe(2);

    // A host moved off the allowlist turns the instance blocked.
    await h.registry.apply(
      listing(gitlabInstance({ credentialVersion: 2, host: 'gitlab.new.example' })),
    );
    expect(h.registry.statuses()[0]).toMatchObject({ state: 'blocked' });
    expect(h.registry.secrets()).toEqual([]);
  });

  it('re-probes a failing GitLab instance a bounded number of times and reports the category', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const h = harness();
    h.registry.install({
      instance: gitlabInstance({ credentialVersion: 7 }),
      unusable: null,
      gitlab: {
        credential: 'glpat-probe-secret',
        state: initialGitlabState(GITLAB_HOST, {
          ...MISSING_GLAB,
          installed: true,
          path: '/opt/glab',
        }),
      },
    });
    const invalid: ProbeResult = { ok: false, status: 'invalid_auth', detail: '401 Unauthorized' };
    h.answerProbes([invalid, invalid, invalid, invalid]);
    const failing = h.registry.probe(GITLAB_ID);
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS * (PROBE_ATTEMPTS - 1));
    await failing;
    expect(h.probeCalls).toHaveLength(PROBE_ATTEMPTS);
    expect(h.reports).toEqual([
      {
        instanceId: GITLAB_ID,
        state: 'error',
        detail: '401 Unauthorized',
        credentialVersion: 7,
        toolsCount: null,
      },
    ]);
    expect(h.registry.statuses()[0]?.gitlab).toMatchObject({
      ready: false,
      status: 'invalid_auth',
    });
    const refused = await handleGitlab(call('get_project', { project: 'g/p' }));
    expect(refused.refused).toMatch(/GitLab instance is not ready \(status invalid_auth\)/);

    // A transient failure followed by success stops retrying.
    h.answerProbes([{ ok: false, status: 'unreachable', detail: 'dial tcp' }]);
    const recovering = h.registry.probe(GITLAB_ID);
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS);
    await recovering;
    expect(h.probeCalls).toHaveLength(PROBE_ATTEMPTS + 2);
    expect(h.reports.at(-1)).toMatchObject({ state: 'ready', credentialVersion: 7 });
  });

  it('never probes a GitLab instance whose packaged binary is missing', async () => {
    const h = harness({ glab: MISSING_GLAB });
    h.secrets.set(GITLAB_ID, { credential: 'glpat-runtime-held-secret', credentialVersion: 1 });
    await h.registry.apply(listing(gitlabInstance()));
    await vi.waitFor(() => expect(h.reports).toHaveLength(1));
    expect(h.probeCalls).toEqual([]);
    expect(h.reports[0]).toMatchObject({
      state: 'error',
      detail: 'the packaged glab binary is not executable at /nonexistent/glab',
    });
  });

  it('re-probes stale Atlassian readiness at bounded frequency (expired token turns it not ready)', async () => {
    let now = 1_000_000;
    let revoked = false;
    const requests: URL[] = [];
    const good = fakeAtlassian(requests);
    const fetchImpl: AtlassianFetch = async (url, init) =>
      revoked ? new Response('{"message":"Unauthorized"}', { status: 401 }) : good(url, init);
    const provider = new AtlassianRestProvider(
      { site: SITE, cloudId: CLOUD_ID, email: 'a@b.c', tokens: { jira: 'jira-token-value' } },
      fetchImpl,
      () => now,
    );
    const h = harness();
    h.registry.install({ instance: atlassianInstance(), unusable: null, atlassian: provider });
    await h.registry.probe(ATLASSIAN_ID);
    expect(h.reports.at(-1)).toMatchObject({ state: 'ready' });
    const probes = requests.length;
    revoked = true;
    h.registry.refreshIfStale();
    await Promise.resolve();
    expect(requests.length).toBe(probes);
    now += ATLASSIAN_READINESS_REFRESH_MS;
    h.registry.refreshIfStale();
    await vi.waitFor(() => expect(h.reports).toHaveLength(2));
    expect(h.reports.at(-1)).toMatchObject({ instanceId: ATLASSIAN_ID, state: 'error' });
    expect(h.reports.at(-1)?.detail).toMatch(/jira: invalid_auth/);
  });
});

describe('isolated tool runtime (GitLab via glab; scoped Atlassian REST)', () => {
  it('refuses unknown, foreign, other-kind and unready GitLab instances', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-resolve-'));
    try {
      const binary = path.join(root, 'glab');
      fs.writeFileSync(binary, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
      const h = harness();
      h.registry.install({
        instance: gitlabInstance(),
        unusable: null,
        gitlab: { credential: 'runtime-held-secret', state: readyState(binary, GITLAB_HOST) },
      });
      h.registry.install({
        instance: gitlabInstance({ id: GITLAB_B_ID }),
        unusable: null,
        gitlab: {
          credential: 'runtime-held-secret',
          state: initialGitlabState(GITLAB_HOST, binaryInfo(binary)),
        },
      });
      h.registry.install({
        instance: atlassianInstance(),
        unusable: { state: 'error', detail: 'no credential' },
      });
      const sandbox = fakeSandbox(root);
      const cases: Array<[Record<string, unknown>, string | RegExp]> = [
        [{ instanceId: undefined }, 'unknown gitlab tool instance'],
        [{ instanceId: 'ti_ffffffffffffffff' }, 'unknown gitlab tool instance'],
        [{ instanceId: ATLASSIAN_ID }, 'unknown gitlab tool instance'],
        [{ teamId: OTHER_TEAM }, `tool instance ${GITLAB_ID} belongs to another workspace`],
        [{ teamId: undefined }, `tool instance ${GITLAB_ID} belongs to another workspace`],
        [{ instanceId: GITLAB_B_ID }, /GitLab instance is not ready \(status pending\)/],
      ];
      for (const [overrides, expected] of cases) {
        const result = await handleGitlab(
          call('get_project', { project: 'g/p' }, overrides),
          undefined,
          sandbox,
        );
        expect(result.status, JSON.stringify(overrides)).toBe('not_run');
        expect(result.refused).toMatch(expected);
      }
      expect(
        (await handleGitlab(call('get_project', { project: 'g/p' }), undefined, sandbox)).status,
      ).toBe('completed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-validates every request and refuses raw access, unknown fields, and hostile projects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-validate-'));
    try {
      const binary = path.join(root, 'glab');
      fs.writeFileSync(binary, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
      const h = harness();
      h.registry.install({
        instance: gitlabInstance(),
        unusable: null,
        gitlab: { credential: 'runtime-held-secret', state: readyState(binary, GITLAB_HOST) },
      });
      const sandbox = fakeSandbox(root);
      const target = { instanceId: GITLAB_ID, teamId: TEAM };
      const refusals: Array<[unknown, RegExp]> = [
        [
          { ...call('get_project', { project: 'g/p' }), credentialVersion: 2 },
          /credential binding changed/,
        ],
        [
          { ...call('get_project', { project: 'g/p' }), credentialVersion: '1' },
          /credential binding changed/,
        ],
        [{ ...target, tool: 'glab', argv: ['mr', 'list'] }, /unknown transport field/],
        [
          { ...call('get_project', { project: 'g/p' }), repository: 'x' },
          /unknown transport field/,
        ],
        // The runner cannot name a host or a credential.
        [{ ...call('get_project', { project: 'g/p' }), host: 'evil' }, /unknown transport field/],
        [{ ...call('get_project', { project: 'g/p' }), token: 'x' }, /unknown transport field/],
        [{ ...target, operation: 'mr_merge', operationArgs: {} }, /unknown GitLab operation/],
        [
          { ...target, operation: 'get_project', operationArgs: { project: 'https://evil/g/p' } },
          /project/,
        ],
        [
          {
            ...target,
            operation: 'get_project',
            operationArgs: { kind: 'get_issue', project: 'g/p' },
          },
          /mismatch/,
        ],
        [
          {
            ...target,
            operation: 'get_project',
            operationArgs: { project: 'g/p', hostname: 'evil' },
          },
          /unknown argument/,
        ],
        [
          {
            ...target,
            operation: 'create_issue_note',
            operationArgs: { project: 'g/p', issue_iid: 1, body: 'x'.repeat(60_001) },
          },
          /body/,
        ],
        ['not an object', /invalid request/],
        [[target], /invalid request/],
      ];
      for (const [body, pattern] of refusals) {
        const result = await handleGitlab(body, undefined, sandbox);
        expect(result.status, JSON.stringify(body).slice(0, 80)).toBe('not_run');
        expect(result.refused).toMatch(pattern);
      }
      const unavailable = await handleGitlab(
        call('get_project', { project: 'g/p' }),
        undefined,
        path.join(root, 'missing-sandbox'),
      );
      expect(unavailable.refused).toMatch(/sandbox is unavailable/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('delivers the instance token via the env file, bodies via --input, pins the instance host, and redacts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-runtime-'));
    try {
      const binary = path.join(root, 'fake-glab');
      // Echo argv, the token prefix and the request body file (resolved
      // inside the fake sandbox's tmp) as JSON-safe text; fail when a token
      // is in argv or the runtime's process environment leaked in.
      fs.writeFileSync(
        binary,
        [
          '#!/bin/bash',
          'for a in "$@"; do [[ "$a" == *secret-one* || "$a" == *secret-two* ]] && exit 8; done',
          'test -z "$LEAK_CHECK" || exit 9',
          'input=""',
          'prev=""',
          'for a in "$@"; do [ "$prev" = "--input" ] && input="$a"; prev="$a"; done',
          'body=""',
          '[ -n "$input" ] && body=$(cat "$SANDBOX_TMP/${input#/tmp/}")',
          'printf \'{"argv":"%s","token":"%s","prefix":"%s","host":"%s","body":%s}\\n\' "$*" "$GITLAB_TOKEN" "${GITLAB_TOKEN:0:5}" "$GITLAB_HOST" "${body:-null}"',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      const h = harness();
      h.registry.install({
        instance: gitlabInstance(),
        unusable: null,
        gitlab: { credential: 'alpha-secret-one', state: readyState(binary, GITLAB_HOST) },
      });
      h.registry.install({
        instance: gitlabInstance({ id: GITLAB_B_ID, host: 'gitlab.second.invalid' }),
        unusable: null,
        gitlab: {
          credential: 'bravo-secret-two',
          state: readyState(binary, 'gitlab.second.invalid'),
        },
      });
      process.env.LEAK_CHECK = 'process-env-must-not-reach-glab';
      const sandbox = fakeSandbox(root);
      const read = await handleGitlab(
        call('get_project', { project: 'group/sub/app' }),
        undefined,
        sandbox,
      );
      expect(read.status).toBe('completed');
      const readJson = JSON.parse(read.output) as Record<string, unknown>;
      expect(readJson.argv).toBe(
        'api --method GET --hostname gitlab.example.invalid projects/group%2Fsub%2Fapp',
      );
      // The instance's own credential reached glab via the env file (never
      // argv) and is redacted in the runtime before the response.
      expect(readJson.token).toBe('[redacted]');
      expect(readJson.prefix).toBe('alpha');
      expect(readJson.host).toBe(GITLAB_HOST);
      expect(read.output).not.toContain('alpha-secret-one');
      // The second instance binds its own host and credential.
      const other = await handleGitlab(
        call('get_project', { project: 'g/p' }, { instanceId: GITLAB_B_ID }),
        undefined,
        sandbox,
      );
      const otherJson = JSON.parse(other.output) as Record<string, unknown>;
      expect(otherJson).toMatchObject({
        argv: 'api --method GET --hostname gitlab.second.invalid projects/g%2Fp',
        token: '[redacted]',
        prefix: 'bravo',
        host: 'gitlab.second.invalid',
      });
      const write = await handleGitlab(
        call('create_merge_request_note', {
          project: 42,
          merge_request_iid: 7,
          body: 'Reviewed. --method DELETE',
        }),
        undefined,
        sandbox,
      );
      expect(write.status).toBe('completed');
      const writeJson = JSON.parse(write.output) as Record<string, unknown>;
      expect(writeJson.argv).toBe(
        'api --method POST --hostname gitlab.example.invalid --input /tmp/request-body.json --header Content-Type: application/json projects/42/merge_requests/7/notes',
      );
      expect(writeJson.body).toEqual({ body: 'Reviewed. --method DELETE' });
    } finally {
      delete process.env.LEAK_CHECK;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('secrets never occur in the sandbox launcher argv (bwrap capture)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-argv-'));
    try {
      const capture = path.join(root, 'bwrap');
      fs.writeFileSync(capture, '#!/bin/bash\nprintf "%s\\0" "$@"\n', { mode: 0o755 });
      const staging = path.join(root, 'staging');
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(
        path.join(staging, 'env'),
        "export GITLAB_TOKEN='argv-secret-value'\nexport CI=1\n",
        { mode: 0o600 },
      );
      for (const dir of ['checkout', 'reports', 'tmp', 'home'])
        fs.mkdirSync(path.join(staging, dir), { recursive: true });
      const result = spawnSync(
        'bash',
        [
          path.resolve('../../deploy/docker/tool-sandbox.sh'),
          staging,
          '1024',
          '--cwd=/workspace',
          '/usr/local/bin/glab',
          'mr',
          'list',
          'literal argument',
        ],
        {
          env: {
            PATH: `${capture}:${root}:${path.resolve('../../deploy/docker')}:/usr/bin:/bin`,
            CLI_SANDBOX_UID: '1000',
          },
        },
      );
      expect(result.status).toBe(0);
      const args = result.stdout.toString();
      expect(args).toContain('/usr/local/bin/glab');
      expect(args).toContain('tool-sandbox-inner');
      // The secret value never appears in launcher argv (no bwrap --setenv
      // for credential data); it is delivered only through the env file.
      expect(args).not.toContain('argv-secret-value');
      expect(args).not.toContain('GITLAB_TOKEN=');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards the egress proxy triple into the sandbox only when configured', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-proxy-'));
    try {
      const capture = path.join(root, 'bwrap');
      fs.writeFileSync(capture, '#!/bin/bash\nprintf "%s\\0" "$@"\n', { mode: 0o755 });
      const staging = path.join(root, 'staging');
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, 'env'), 'export CI=1\n', { mode: 0o600 });
      const launch = (extra: Record<string, string>): string[] => {
        const result = spawnSync(
          'bash',
          [
            path.resolve('../../deploy/docker/tool-sandbox.sh'),
            staging,
            '1024',
            '/usr/local/bin/glab',
            'api',
          ],
          {
            env: {
              PATH: `${capture}:${root}:${path.resolve('../../deploy/docker')}:/usr/bin:/bin`,
              CLI_SANDBOX_UID: '1000',
              ...extra,
            },
          },
        );
        expect(result.status).toBe(0);
        return result.stdout.toString().split('\0');
      };
      const setenv = (args: string[], name: string): string | undefined => {
        for (let i = 0; i < args.length - 2; i += 1)
          if (args[i] === '--setenv' && args[i + 1] === name) return args[i + 2];
        return undefined;
      };
      const direct = launch({});
      expect(direct.some((arg) => /_proxy$/i.test(arg))).toBe(false);
      // No pinned hosts file any more: the container's own /etc is used.
      expect(direct).not.toContain('/etc/hosts');
      const proxied = launch(sandboxProxyEnv('http://egress:3128'));
      for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'])
        expect(setenv(proxied, name), name).toBe('http://egress:3128');
      expect(setenv(proxied, 'NO_PROXY')).toContain('cli-runtime');
      expect(setenv(proxied, 'no_proxy')).toBe(setenv(proxied, 'NO_PROXY'));
      // --clearenv comes first: nothing else of the launcher env leaks in.
      expect(proxied.indexOf('--clearenv')).toBeLessThan(proxied.indexOf('HTTPS_PROXY'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives the trusted glab probe the proxy triple and nothing of the runtime env', () => {
    try {
      configureOutbound('http://egress:3128');
      const env = trustedSpawnEnv({ GITLAB_HOST: 'gitlab.example.invalid' });
      expect(env.HTTPS_PROXY).toBe('http://egress:3128');
      expect(env.NO_PROXY).toContain('admin');
      expect(env.GITLAB_HOST).toBe('gitlab.example.invalid');
      expect(env.ADMIN_INTERNAL_TOKEN).toBeUndefined();
    } finally {
      configureOutbound(undefined);
    }
    expect(trustedSpawnEnv().HTTPS_PROXY).toBeUndefined();
  });

  it('sources the protected env file inside the namespace and hides it from the unprivileged uid', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-inner-'));
    try {
      const staging = path.join(root, 'staging');
      for (const dir of ['checkout', 'reports', 'tmp', 'home'])
        fs.mkdirSync(path.join(staging, dir), { recursive: true });
      fs.writeFileSync(
        path.join(staging, 'env'),
        "export GITLAB_TOKEN='file-only-secret'\nexport GITLAB_HOST='gitlab.example.invalid'\nexport CI=1\n",
        { mode: 0o600 },
      );
      const binary = path.join(root, 'probe');
      fs.writeFileSync(
        binary,
        `#!/bin/sh\necho "token=$GITLAB_TOKEN host=$GITLAB_HOST"\nnode -e "const fs=require('node:fs'); try { fs.readFileSync(process.env.CLI_SANDBOX_ENV_FILE); console.log('envfile-readable'); } catch (e) { console.log('envfile-' + (e.code === 'EACCES' ? 'denied' : 'missing')); }" 2>/dev/null || echo "envfile-no-node"\n`,
        { mode: 0o755 },
      );
      const stubs = path.join(root, 'stubs');
      fs.mkdirSync(stubs, { recursive: true });
      fs.writeFileSync(
        path.join(stubs, 'setpriv'),
        '#!/bin/bash\nwhile [[ "$1" == -* ]]; do shift; done\nexec "$@"\n',
        { mode: 0o755 },
      );
      const result = spawnSync(
        'bash',
        [
          path.resolve('../../deploy/docker/tool-sandbox-inner.sh'),
          '1000',
          String(Math.floor(2_000_000 / 1024)),
          binary,
          'arg1',
          'literal argument',
        ],
        {
          env: {
            PATH: `${stubs}:/usr/bin:/bin`,
            HOME: root,
            CLI_SANDBOX_ENV_FILE: path.join(staging, 'env'),
          },
          cwd: staging,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toContain('token=file-only-secret');
      expect(result.stdout.toString()).toContain('host=gitlab.example.invalid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves typed Atlassian reads only for the owning workspace under the exact binding', async () => {
    const requests: URL[] = [];
    const provider = new AtlassianRestProvider(
      {
        site: SITE,
        cloudId: CLOUD_ID,
        email: 'test@example.invalid',
        tokens: { jira: 'synthetic-jira-token-value' },
      },
      fakeAtlassian(requests),
    );
    const h = harness();
    h.registry.install({ instance: atlassianInstance(), unusable: null, atlassian: provider });
    h.registry.install({
      instance: atlassianInstance({ id: 'ti_0000000000000005', host: 'other.atlassian.net' }),
      unusable: { state: 'blocked', detail: 'host not admitted' },
    });
    await provider.refresh();
    const state = h.registry.statuses()[0]!.atlassian!;
    expect(state.ready).toBe(true);
    const binding = {
      site: state.site,
      cloudId: state.cloudId,
      adapter: state.adapter,
      contractVersion: state.contractVersion,
      operations: state.operations,
      credentialFingerprints: state.credentialFingerprints,
    };
    const request = (overrides: Record<string, unknown> = {}) =>
      handleAtlassian({
        instanceId: ATLASSIAN_ID,
        teamId: TEAM,
        operation: 'getJiraIssue',
        operationArgs: { kind: 'getJiraIssue', issueKey: 'ABC-1' },
        binding,
        timeoutMs: 5000,
        maxOutputBytes: 10000,
        ...overrides,
      });
    const result = await request();
    expect(result.status).toBe('completed');
    expect(result.output).toContain('Done');
    expect(result.output).not.toContain('synthetic-jira-token-value');
    expect(requests.at(-1)?.pathname).toBe(`/ex/jira/${CLOUD_ID}/rest/api/3/issue/ABC-1`);
    const refusals: Array<[Record<string, unknown>, string | RegExp]> = [
      [{ teamId: OTHER_TEAM }, `tool instance ${ATLASSIAN_ID} belongs to another workspace`],
      [{ instanceId: 'ti_ffffffffffffffff' }, 'unknown atlassian tool instance'],
      [{ instanceId: GITLAB_ID }, 'unknown atlassian tool instance'],
      [{ instanceId: 'ti_0000000000000005' }, /is blocked: host not admitted/],
      [{ binding: { ...binding, site: 'other.atlassian.net' } }, /binding mismatch/],
      [
        { binding: { ...binding, cloudId: '11111111-1111-4111-8111-111111111111' } },
        /binding mismatch/,
      ],
      [
        { binding: { ...binding, credentialFingerprints: { jira: 'ffffffffffffffff' } } },
        /binding mismatch/,
      ],
      [{ binding: { ...binding, contractVersion: 'atlassian-read-v3' } }, /binding mismatch/],
      [{ binding: { ...binding, version: '1.3.36' } }, /binding mismatch/],
      [{ binding: { ...binding, operations: ['getConfluencePage'] } }, /binding mismatch/],
      [{ binding: null }, /binding mismatch/],
      [{ url: 'https://evil.example/' }, 'unknown transport field'],
      [{ site: 'evil.atlassian.net' }, 'unknown transport field'],
      [
        { operationArgs: { issueKey: 'ABC-1', site: 'evil.atlassian.net' } },
        /invalid Atlassian operation/,
      ],
      [
        {
          operation: 'getConfluencePage',
          operationArgs: { kind: 'getConfluencePage', pageId: '1' },
        },
        /operation not ready: confluence unavailable/,
      ],
      [{ timeoutMs: 300001 }, 'invalid execution bounds'],
    ];
    const before = requests.length;
    for (const [overrides, expected] of refusals) {
      const refused = await request(overrides);
      expect(refused.status, JSON.stringify(overrides)).toBe('not_run');
      expect(refused.refused).toMatch(expected);
    }
    expect(requests.length).toBe(before);
  });

  it('classifies bounded probe outcomes into sanitized categories', () => {
    expect(classifyProbeOutput('error: 401 Bad credentials')).toBe('invalid_auth');
    expect(classifyProbeOutput('unauthorized: use auth login')).toBe('invalid_auth');
    expect(classifyProbeOutput('403 Forbidden')).toBe('forbidden');
    expect(classifyProbeOutput('dial tcp: lookup gitlab.invalid: no such host')).toBe(
      'unreachable',
    );
    expect(classifyProbeOutput('something else went wrong')).toBe('error');
    // Redaction covers output regardless of category.
    expect(redactCliOutput('token glpat-abcdefgh123 and Bearer abc.def')).toContain('[redacted]');
  });

  it('probes glab with the credential in the environment only and redacts it from the detail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-probe-test-'));
    try {
      const binary = path.join(root, 'glab');
      fs.writeFileSync(
        binary,
        [
          '#!/bin/bash',
          'for a in "$@"; do [[ "$a" == *probe-secret* ]] && { echo "token in argv" >&2; exit 7; }; done',
          `[ "$*" = "api --hostname ${GITLAB_HOST} user" ] || { echo "unexpected argv $*" >&2; exit 6; }`,
          `[ "$GITLAB_HOST" = "${GITLAB_HOST}" ] || { echo "unexpected host" >&2; exit 5; }`,
          '[ "$GLAB_NO_PROMPT" = "true" ] || exit 4',
          'if [ "$GITLAB_TOKEN" = "probe-secret-good" ]; then echo \'{"id":1,"username":"bot"}\'; exit 0; fi',
          'echo "401 Unauthorized for token $GITLAB_TOKEN" >&2; exit 1',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      expect(await probeGlab(GITLAB_HOST, 'probe-secret-good', binary)).toEqual({
        ok: true,
        status: 'ready',
        detail: 'authenticated against the instance host',
      });
      const bad = await probeGlab(GITLAB_HOST, 'probe-secret-bad', binary);
      expect(bad).toMatchObject({ ok: false, status: 'invalid_auth' });
      expect(bad.detail).toBe('401 Unauthorized for token [redacted]');
      const missing = await probeGlab(GITLAB_HOST, 'probe-secret-good', path.join(root, 'none'));
      expect(missing.ok).toBe(false);
      expect(missing.detail).not.toContain('probe-secret-good');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts every credential the runtime holds, across instances and kinds', () => {
    const h = harness();
    h.registry.install({
      instance: gitlabInstance(),
      unusable: null,
      gitlab: {
        credential: 'gitlab-held-credential',
        state: initialGitlabState(GITLAB_HOST, MISSING_GLAB),
      },
    });
    h.registry.install({
      instance: atlassianInstance(),
      unusable: null,
      atlassian: new AtlassianRestProvider({
        site: SITE,
        cloudId: CLOUD_ID,
        email: 'test@example.invalid',
        tokens: { jira: 'jira-held-token', confluence: 'conf-held-token' },
      }),
    });
    h.registry.install({
      instance: datadogInstance(),
      unusable: null,
      datadog: new DatadogMcpProvider({
        site: 'datadoghq.eu',
        toolsets: 'all',
        token: 'dd-held-token-123456',
      }),
    });
    const secrets = [
      'gitlab-held-credential',
      'jira-held-token',
      Buffer.from('conf-held-token').toString('base64'),
      Buffer.from('test@example.invalid:jira-held-token').toString('base64'),
      'dd-held-token-123456',
    ];
    const leaked = secrets.join(' | ');
    const redacted = redactRuntimeOutput(leaked);
    for (const secret of secrets) expect(redacted).not.toContain(secret);
    expect(redacted.match(/\[redacted\]/g)).toHaveLength(secrets.length);
    expect(redactCliOutput(leaked)).toBe(redacted);
    // A removed instance's credential is no longer on the list (it is no longer held).
    setInstanceRegistry(null);
    expect(redactRuntimeOutput('gitlab-held-credential')).toBe('gitlab-held-credential');
  });

  it('keeps CLI stderr chatter out of the typed-read stdout payload', async () => {
    // Live failure: glab prints release notes / config warnings to stderr;
    // merging both streams failed every typed read with invalid_response.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-stderr-'));
    try {
      const binary = path.join(root, 'fake-glab');
      fs.writeFileSync(
        binary,
        '#!/bin/sh\necho "{\\"id\\":1}"\necho "What\'s new in glab (mock chatter)" >&2\necho "ERROR: config read-only (mock chatter) token=$GITLAB_TOKEN" >&2\n',
        { mode: 0o755 },
      );
      const h = harness();
      h.registry.install({
        instance: gitlabInstance(),
        unusable: null,
        gitlab: { credential: 'runtime-held-secret', state: readyState(binary, GITLAB_HOST) },
      });
      const result = await handleGitlab(
        call('get_project', { project: 'group/project' }),
        undefined,
        fakeSandbox(root),
      );
      expect(result.status).toBe('completed');
      expect(() => JSON.parse(result.output)).not.toThrow();
      expect(result.output).not.toContain('mock chatter');
      expect(result.stderr ?? '').toContain('mock chatter');
      // stderr is redacted like stdout.
      expect(result.stderr ?? '').toContain('token=[redacted]');
      expect(result.stderr ?? '').not.toContain('runtime-held-secret');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['get_project', 'get_job_trace'])(
    'fails %s when an escaped child holds the output pipe',
    async (operation) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-incomplete-'));
      const pidFile = path.join(root, 'escaped.pid');
      const stagingFile = path.join(root, 'staging');
      try {
        const binary = path.join(root, 'fake-glab');
        fs.writeFileSync(
          binary,
          `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync(${JSON.stringify(stagingFile)}, process.cwd());
fs.writeSync(1, 'partial text\\n');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true, stdio:['ignore', 1, 2]});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref();
`,
          { mode: 0o755 },
        );
        const h = harness();
        h.registry.install({
          instance: gitlabInstance(),
          unusable: null,
          gitlab: { credential: 'runtime-held-secret', state: readyState(binary, GITLAB_HOST) },
        });
        const args =
          operation === 'get_job_trace' ? { project: 'g/p', job_id: 7 } : { project: 'g/p' };
        const result = await handleGitlab(call(operation, args), undefined, fakeSandbox(root));
        expect(result.status).toBe('failed');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('partial text');
        expect(result.stderr).toContain('output incomplete');
        expect(result.truncated).toBe(true);
        if (result.status !== 'failed') throw new Error('expected runtime failure');
        const normalized = normalizeGitlabOutput({
          operation: operation as 'get_project' | 'get_job_trace',
          project: 'g/p',
          status: result.status,
          exitCode: result.exitCode ?? null,
          stdout: result.output,
          stderr: result.stderr ?? '',
          ...(result.textMeta === undefined ? {} : { textMeta: result.textMeta }),
        });
        expect(normalized.ok).toBe(false);
        expect(normalized.data).toBeNull();
        expect(normalized.errorCategory).toBe('invalid_response');
        if (operation === 'get_job_trace') {
          expect(result.textMeta).toMatchObject({ cut: true, totalBytes: 13, returnedBytes: 13 });
        }
        expect(fs.existsSync(fs.readFileSync(stagingFile, 'utf8'))).toBe(false);
      } finally {
        if (fs.existsSync(pidFile)) {
          try {
            process.kill(-Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
          } catch {
            /* gone */
          }
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('returns the whole payload when the CLI exits before its output is read (busy event loop)', async () => {
    // the read resolved at the child's `exit`, which
    // can precede the last stdout data; under load a completed get_project
    // returned an empty payload. A busy event loop and concurrent reads make
    // that ordering the common case (old code: 80 of 100 such reads empty).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-drain-'));
    const spin = setInterval(() => {
      const until = Date.now() + 8;
      while (Date.now() < until) {
        /* hold the event loop */
      }
    }, 1);
    try {
      const binary = path.join(root, 'fake-glab');
      fs.writeFileSync(binary, '#!/bin/sh\necho "{\\"id\\":1}"\necho "chatter" >&2\n', {
        mode: 0o755,
      });
      const h = harness();
      h.registry.install({
        instance: gitlabInstance(),
        unusable: null,
        gitlab: { credential: 'runtime-held-secret', state: readyState(binary, GITLAB_HOST) },
      });
      const sandbox = fakeSandbox(root);
      // Batches after the first start while the spinning interval already
      // holds the loop: exit and the pipe data then become ready in the same
      // poll, and the old code saw the exit first every time.
      for (let batch = 0; batch < 3; batch += 1) {
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            handleGitlab(call('get_project', { project: 'group/project' }), undefined, sandbox),
          ),
        );
        for (const result of results) {
          expect(result.status).toBe('completed');
          expect(JSON.parse(result.output)).toEqual({ id: 1 });
          expect(result.stderr).toContain('chatter');
        }
      }
    } finally {
      clearInterval(spin);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('CLI output drain', () => {
  it('waits for the pipes to close, not for the exit, and bounds the wait', async () => {
    // The process exits at once; a descendant writes 300 ms later on the same pipe.
    const late = spawn('sh', ['-c', '(sleep 0.3; echo late) & exit 0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    late.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await new Promise((resolve) => late.once('exit', resolve));
    expect(output).toBe('');
    expect(await stdioDrained(late, 5_000)).toBe(true);
    expect(output).toBe('late\n');
    expect(await stdioDrained(late, 5_000)).toBe(true);

    const held = spawn('sh', ['-c', '(sleep 2) & exit 0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve) => held.once('exit', resolve));
    const started = Date.now();
    expect(await stdioDrained(held, 100)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
    held.stdout.destroy();
    held.stderr.destroy();
  });
});

describe('job trace streaming retention (get_job_trace)', () => {
  const feed = (retainer: ReturnType<typeof createTextRetainer>, body: Buffer, chunk: number) => {
    let verdict: 'continue' | 'cut' = 'continue';
    for (let at = 0; at < body.length && verdict === 'continue'; at += chunk)
      verdict = retainer.push(body.subarray(at, at + chunk));
    return verdict;
  };
  const lines = (count: number) =>
    Buffer.from(
      Array.from({ length: count }, (_, i) => `line ${String(i + 1).padStart(5, '0')}\n`).join(''),
    );

  it('keeps exactly the last N bytes (whole lines) and counts every byte', () => {
    const body = lines(2000); // 11 bytes per line
    for (const chunk of [1, 7, 4096, body.length]) {
      const retainer = createTextRetainer({ bytes: 1100, part: 'tail' });
      expect(feed(retainer, body, chunk)).toBe('continue');
      const { text, meta } = retainer.finish();
      expect(meta).toEqual({ totalBytes: 22_000, returnedBytes: 1100, part: 'tail', cut: false });
      expect(text).toBe(body.subarray(body.length - 1100).toString());
      expect(text.startsWith('line 01901\n')).toBe(true);
    }
    // A cut inside a line drops the partial line at the edge.
    const retainer = createTextRetainer({ bytes: 1105, part: 'tail' });
    feed(retainer, body, 333);
    const { text, meta } = retainer.finish();
    expect(meta.returnedBytes).toBe(1100);
    expect(text.startsWith('line 01901\n')).toBe(true);
  });

  it('keeps the first N bytes in head mode, ending at a whole line', () => {
    const retainer = createTextRetainer({ bytes: 1105, part: 'head' });
    expect(feed(retainer, lines(2000), 500)).toBe('continue');
    const { text, meta } = retainer.finish();
    expect(meta).toEqual({ totalBytes: 22_000, returnedBytes: 1100, part: 'head', cut: false });
    expect(text.endsWith('line 00100\n')).toBe(true);
  });

  it('never splits a UTF-8 sequence when a single line exceeds the bound', () => {
    const body = Buffer.from('€'.repeat(1000)); // 3 bytes each, no newline
    const tail = createTextRetainer({ bytes: 100, part: 'tail' });
    feed(tail, body, 64);
    expect(tail.finish().text).toBe('€'.repeat(33));
    const head = createTextRetainer({ bytes: 100, part: 'head' });
    feed(head, body, 64);
    expect(head.finish()).toMatchObject({ text: '€'.repeat(33), meta: { returnedBytes: 99 } });
  });

  it('reports the hard cut once the count passes it', () => {
    const retainer = createTextRetainer({ bytes: 100, part: 'tail' }, 5_000);
    expect(feed(retainer, lines(1000), 1000)).toBe('cut');
    const { meta } = retainer.finish();
    expect(meta).toMatchObject({ totalBytes: 6_000, cut: true });
  });

  it('redacts credential shapes a job prints itself', () => {
    const pat = randomBytes(14).toString('hex');
    const bearer = randomBytes(16).toString('base64url');
    const redacted = redactTraceOutput(
      [
        `glpat-${pat} in a log`,
        `curl -H "Authorization: Bearer ${bearer}" https://h/api`,
        '> authorization: Basic dXNlcjpwYXNz',
        'PRIVATE-TOKEN: s3cr3t-value',
        'JOB-TOKEN: 64_abcdef',
        'GET https://h/api?private_token=abc123&page=2 and ?access_token=xyz&x=1 and token=plain',
        'clone https://oauth2:pa55word@gitlab.example.test/g/p.git',
        'no secret: tokenizer=fast, https://gitlab.example.test/g/p',
      ].join('\n'),
    );
    for (const secret of [
      pat,
      bearer,
      'dXNlcjpwYXNz',
      's3cr3t-value',
      '64_abcdef',
      'abc123',
      'xyz',
      '=plain',
      'pa55word',
      'oauth2:',
    ])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain('PRIVATE-TOKEN: [redacted]');
    expect(redacted).toContain('private_token=[redacted]&page=2');
    expect(redacted).toContain('https://[redacted]@gitlab.example.test/g/p.git');
    expect(redacted).toContain('no secret: tokenizer=fast, https://gitlab.example.test/g/p');
  });

  it('streams a trace through the sandbox: tail by default, head on request, redacted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-trace-'));
    try {
      const binary = path.join(root, 'fake-glab');
      // 120 000 bytes: a token line at the top, 10-byte numbered lines, a summary.
      fs.writeFileSync(
        binary,
        [
          '#!/bin/bash',
          'case "${@: -1}" in *"/jobs/404/trace") echo \'{"message":"404 Not found"}\'; echo "glab: 404 Not Found (HTTP 404)" >&2; exit 1 ;; esac',
          'echo "token: $GITLAB_TOKEN and glpat-printedByTheJob1234"',
          'for i in $(seq 10000 21999); do echo "f $i ok"; done',
          'echo "Authorization: Bearer leaked.value"',
          'echo "1 flaky: retried spec"',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      const h = harness();
      h.registry.install({
        instance: gitlabInstance(),
        unusable: null,
        gitlab: { credential: 'runtime-held-secret', state: readyState(binary, GITLAB_HOST) },
      });
      const sandbox = fakeSandbox(root);
      const tail = await handleGitlab(
        call('get_job_trace', { project: 'g/p', job_id: 7 }),
        undefined,
        sandbox,
      );
      expect(tail.status).toBe('completed');
      expect(tail.textMeta).toMatchObject({ part: 'tail', cut: false });
      expect(tail.textMeta!.returnedBytes).toBeLessThanOrEqual(48_000);
      expect(tail.textMeta!.totalBytes).toBeGreaterThan(100_000);
      expect(tail.truncated).toBe(true);
      expect(tail.output).toMatch(/^f \d{5} ok\n/);
      expect(tail.output.endsWith('Authorization: [redacted]\n1 flaky: retried spec\n')).toBe(true);
      expect(tail.output).not.toContain('leaked.value');
      const head = await handleGitlab(
        call('get_job_trace', { project: 'g/p', job_id: 7, head: true }),
        undefined,
        sandbox,
      );
      expect(head.textMeta).toMatchObject({ part: 'head', cut: false });
      expect(head.textMeta!.totalBytes).toBe(tail.textMeta!.totalBytes);
      expect(head.output.startsWith('token: [redacted] and [redacted]\nf 10000 ok\n')).toBe(true);
      expect(head.output).not.toContain('runtime-held-secret');
      expect(head.output).not.toContain('printedByTheJob');
      // An HTTP error keeps its JSON body and exit code for classification.
      const missing = await handleGitlab(
        call('get_job_trace', { project: 'g/p', job_id: 404 }),
        undefined,
        sandbox,
      );
      expect(missing).toMatchObject({
        status: 'failed',
        exitCode: 1,
        output: '{"message":"404 Not found"}\n',
        textMeta: { totalBytes: 28, returnedBytes: 28, cut: false },
      });
      expect(missing.stderr).toContain('HTTP 404');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops a runaway trace at the 8 MiB hard cut and kills the child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-trace-cut-'));
    try {
      const binary = path.join(root, 'fake-glab');
      const pidFile = path.join(root, 'glab.pid');
      fs.writeFileSync(
        binary,
        `#!/bin/bash\necho $$ > ${JSON.stringify(pidFile)}\nexec yes "endless filler line of a runaway job log"\n`,
        { mode: 0o755 },
      );
      const h = harness();
      h.registry.install({
        instance: gitlabInstance(),
        unusable: null,
        gitlab: { credential: 'runtime-held-secret', state: readyState(binary, GITLAB_HOST) },
      });
      const started = Date.now();
      const result = await handleGitlab(
        call('get_job_trace', { project: 'g/p', job_id: 7 }, { timeoutMs: 60_000 }),
        undefined,
        fakeSandbox(root),
      );
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(result).toMatchObject({ status: 'completed', exitCode: 0, truncated: true });
      expect(result.textMeta).toMatchObject({ part: 'tail', cut: true });
      expect(result.textMeta!.totalBytes).toBeGreaterThan(8 * 1024 * 1024);
      expect(result.textMeta!.totalBytes).toBeLessThan(8 * 1024 * 1024 + 1024 * 1024);
      expect(result.textMeta!.returnedBytes).toBeLessThanOrEqual(48_000);
      expect(result.output.split('\n')[0]).toBe('endless filler line of a runaway job log');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('get_repository_file on the read path (decoded in the runtime, before redaction)', () => {
  const SECRET = 'runtime-held-secret';
  const FILES: Record<string, Buffer> = {
    'notes.md': Buffer.from(
      `# On call\nPage the owner.\ntoken ${SECRET}\nold glpat-abcdef123456\n`,
    ),
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    'big.txt': Buffer.from('y'.repeat(70_000)),
    'huge.txt': Buffer.from('z'.repeat(160_000)),
  };

  /** A fake glab that answers GitLab's files API: the content base64-encoded. */
  function fileGlab(root: string): string {
    const binary = path.join(root, 'fake-glab');
    const files = Object.fromEntries(
      Object.entries(FILES).map(([name, bytes]) => [name, bytes.toString('base64')]),
    );
    fs.writeFileSync(
      binary,
      `#!${process.execPath}
const files = ${JSON.stringify(files)};
const target = process.argv.slice(2).find((a) => a.includes('/repository/files/'));
const name = decodeURIComponent(target.split('/repository/files/')[1].split('?')[0]);
const content = files[name];
const size = Buffer.from(content, 'base64').length;
process.stdout.write(JSON.stringify({ file_name: name, file_path: name, size, encoding: 'base64', content_sha256: 'x', ref: 'main', blob_id: 'b1', commit_id: 'c1', last_commit_id: 'c0', content }) + '\\n');
`,
      { mode: 0o755 },
    );
    return binary;
  }

  /** The runtime with one ready GitLab instance holding SECRET. */
  function runtime(root: string) {
    const h = harness();
    h.registry.install({
      instance: gitlabInstance(),
      unusable: null,
      gitlab: { credential: SECRET, state: readyState(fileGlab(root), GITLAB_HOST) },
    });
    return h;
  }

  it('decodes text, reports binary and oversize files, and redacts the decoded text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-file-'));
    try {
      runtime(root);
      const sandbox = fakeSandbox(root);
      const read = (file_path: string, maxOutputBytes = 200_000) =>
        handleGitlab(
          call(
            'get_repository_file',
            { project: 'g/p', file_path, ref: 'main' },
            { maxOutputBytes },
          ),
          undefined,
          sandbox,
        );
      const text = await read('notes.md');
      expect(text.status).toBe('completed');
      const decoded = JSON.parse(text.output) as Record<string, unknown>;
      expect(decoded).toMatchObject({
        file_path: 'notes.md',
        encoding: 'text',
        size: FILES['notes.md']!.length,
      });
      // The runtime's redaction saw the decoded text: neither its own
      // credential nor a token shape survives, though both were base64.
      expect(decoded.content).toBe(
        '# On call\nPage the owner.\ntoken [redacted]\nold [redacted]\n',
      );
      expect(text.output).not.toContain(SECRET);
      expect(text.output).not.toContain(FILES['notes.md']!.toString('base64'));

      const binary = JSON.parse((await read('logo.png')).output);
      expect(binary).toMatchObject({ file_path: 'logo.png', content: null, binary: true });
      const big = JSON.parse((await read('big.txt')).output);
      expect(big).toMatchObject({ content: null, content_truncated: true });
      expect(big.content_note).toMatch(/exceeds the 60000-byte bound/);
      const huge = await read('huge.txt');
      expect(huge.truncated).toBe(true);
      expect(JSON.parse(huge.output)).toEqual({
        content: null,
        content_note:
          'file exceeds the 200000-byte capture bound of the tool runtime and is reported without content',
        content_truncated: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("answers the read tool (and Code Mode, which calls it) with the coding path's normalization", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-file-read-'));
    const h = runtime(root);
    const sandbox = fakeSandbox(root);
    const requests: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (req, res) => {
      if (req.url === '/readyz') {
        res.end(
          JSON.stringify({
            service: 'cli-runtime',
            configVersion: 1,
            syncError: null,
            instances: h.registry.statuses(),
          }),
        );
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      res.end(JSON.stringify(await handleGitlab(body, undefined, sandbox)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const document = compileDocument(1, {
        installations: [
          {
            teamId: TEAM,
            teamName: 'Synthetic',
            botUserId: 'UBOT',
            botId: 'BBOT',
            status: 'whitelisted',
            trustedBotSender: null,
          },
        ],
        channels: [{ teamId: TEAM, channelId: 'CCHAN', enabled: true }],
        blockedMembers: [],
        toolInstances: [{ ...gitlabInstance(), status: 'enabled' }],
        toolStatuses: [
          {
            instanceId: GITLAB_ID,
            state: 'ready',
            detail: '',
            toolsCount: null,
            credentialVersion: 1,
            reporter: 'cli-runtime',
            reportedAt: Date.now(),
          },
        ],
        channelTools: [{ teamId: TEAM, channelId: 'CCHAN', kind: 'gitlab', instanceId: GITLAB_ID }],
      } as never);
      const config = deriveCoordinatorConfig(document as never, {
        modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
        admission: { global: 1, perThread: 1 },
        execution: { maxInferenceInvocations: 1 },
      });
      const binding = await nativeReadServices({
        configuration: async () => config,
        cli: {
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          token: 'synthetic-cli',
        },
      })({ teamId: TEAM, channelId: 'CCHAN' } as never, new AbortController().signal);
      const tools = createReadServiceTools({ ...binding, authorize: async () => {} }) as Record<
        string,
        { execute(args: unknown, context: unknown): Promise<unknown> }
      >;
      const read = async (file_path: string) =>
        (await tools.get_repository_file!.execute(
          { project: 'g/p', file_path, ref: 'main' },
          {},
        )) as {
          result: { ok: boolean; output: string; data?: Record<string, unknown> };
          content: Array<{ text: string }>;
        };

      const text = await read('notes.md');
      expect(text.result.ok).toBe(true);
      expect(text.result.data).toEqual({
        file_path: 'notes.md',
        file_name: 'notes.md',
        size: FILES['notes.md']!.length,
        ref: 'main',
        blob_id: 'b1',
        commit_id: 'c1',
        last_commit_id: 'c0',
        encoding: 'text',
        content: '# On call\nPage the owner.\ntoken [redacted]\nold [redacted]\n',
      });
      expect(text.content[0]!.text).toMatch(/^ok \(get_repository_file @ g\/p\):\n/);
      expect(text.content[0]!.text).toContain('Page the owner.');
      expect(JSON.stringify(text)).not.toContain(SECRET);
      // The read path asks for the coding path's capture bound.
      expect(requests.at(-1)).toMatchObject({
        operation: 'get_repository_file',
        maxOutputBytes: 200_000,
      });

      const binary = await read('logo.png');
      expect(binary.result.ok).toBe(true);
      expect(binary.result.data).toMatchObject({
        file_path: 'logo.png',
        content: null,
        binary: true,
        content_note: 'binary file content is not returned as text',
      });
      const big = await read('big.txt');
      expect(big.result.data).toMatchObject({ content: null, content_truncated: true });
      expect(big.result.data!.content_note).toMatch(/exceeds the 60000-byte bound/);
      const huge = await read('huge.txt');
      expect(huge.result.ok).toBe(true);
      expect(huge.result.data).toMatchObject({ content: null, content_truncated: true });
      expect(huge.result.data!.content_note).toMatch(/200000-byte capture bound/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
