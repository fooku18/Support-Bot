import { testSelection } from '../model-fixture.js';
/**
 * Isolated tool runtime: admin-managed GitLab/Atlassian/Datadog instances,
 * per-instance credentials and readiness, workspace binding, credential
 * scoping, GitLab REST transport.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  assertCliRuntimeEnvClean,
  CliInstanceRegistry,
  handleAtlassian,
  handleGitlab,
  initialGitlabState,
  PROBE_ATTEMPTS,
  PROBE_RETRY_MS,
  probeGitlab,
  redactRuntimeOutput,
  redactTraceOutput,
  setInstanceRegistry,
  type CliInstanceRegistryDeps,
  type ProbeResult,
  type ProviderState,
} from '../../../tool-runtime/src/main.js';
import {
  createTextRetainer,
  normalizeGitlabOutput,
  type GitlabFetch,
} from '../../src/integrations/gitlab/gitlab-rest-adapter.js';
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

function readyState(host: string = GITLAB_HOST): ProviderState {
  return { ...initialGitlabState(host), ready: true, status: 'ready', detail: 'test-qualified' };
}

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Synthetic GitLab: records each request and answers with `respond`. */
function fakeGitlab(respond: (seen: SeenRequest) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  const fetchImpl: GitlabFetch = async (url, init) => {
    init.signal?.throwIfAborted();
    const request: SeenRequest = {
      url: url.href,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: (init.body as string | undefined) ?? null,
    };
    expect(init.redirect).toBe('manual');
    seen.push(request);
    return respond(request);
  };
  return { seen, fetchImpl };
}

const jsonAnswer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

/** A 200 body that sends `text`, then fails like a dropped connection. */
const droppedAnswer = (text: string) =>
  new Response(
    new ReadableStream({
      pull(controller) {
        if (text) {
          controller.enqueue(Buffer.from(text));
          text = '';
        } else controller.error(new Error('synthetic upstream detail'));
      },
    }),
  );

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
  const probeCalls: Array<{ host: string; credential: string }> = [];
  const secrets = new Map<string, { credential: string; credentialVersion: number }>();
  let probeAnswers: ProbeResult[] = [];
  const registry = new CliInstanceRegistry({
    admitted: {
      gitlab: new Set([GITLAB_HOST]),
      atlassian: new Set([SITE]),
      datadog: new Set(['datadoghq.eu']),
      cloudflare: new Set(['api.cloudflare.com']),
    },
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
    probeGitlab: async (host, credential) => {
      probeCalls.push({ host, credential });
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

/** The runtime with one ready GitLab instance that reaches `fetchImpl`. */
function gitlabRuntime(fetchImpl: GitlabFetch, credential = 'runtime-held-secret') {
  const h = harness();
  h.registry.install({
    instance: gitlabInstance(),
    unusable: null,
    gitlab: { credential, state: readyState(), fetchImpl },
  });
  return h;
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
  it('refuses controller credentials and requires its token', () => {
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
    expect(() => assertCliRuntimeEnvClean({ ...base, NATIVE_WEB_FETCH_API_KEY: 'x' })).toThrow(
      /controller credentials \(NATIVE_WEB_FETCH_API_KEY\)/,
    );
    expect(() => assertCliRuntimeEnvClean({ ...base, SLACK_BOT_TOKEN: 'xoxb-1' })).toThrow(
      /controller credentials/,
    );
    expect(() => assertCliRuntimeEnvClean({})).toThrow(/CLI_RUNTIME_TOKEN is required/);
    expect(() => assertCliRuntimeEnvClean({ CLI_RUNTIME_TOKEN: '  ' })).toThrow(
      /CLI_RUNTIME_TOKEN is required/,
    );
  });

  it('derives the pre-probe GitLab state', () => {
    expect(initialGitlabState(GITLAB_HOST)).toEqual({
      tool: 'gitlab',
      ready: false,
      status: 'pending',
      detail: 'readiness has not been established yet',
      host: GITLAB_HOST,
      contractVersion: 6,
    });
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
    expect(h.probeCalls).toEqual([{ host: GITLAB_HOST, credential: 'glpat-runtime-held-secret' }]);
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
        state: initialGitlabState(GITLAB_HOST),
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
    h.answerProbes([{ ok: false, status: 'unreachable', detail: 'GitLab could not be reached' }]);
    const recovering = h.registry.probe(GITLAB_ID);
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS);
    await recovering;
    expect(h.probeCalls).toHaveLength(PROBE_ATTEMPTS + 2);
    expect(h.reports.at(-1)).toMatchObject({ state: 'ready', credentialVersion: 7 });
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

describe('isolated tool runtime (GitLab REST; scoped Atlassian REST)', () => {
  it('refuses unknown, foreign, other-kind and unready GitLab instances', async () => {
    const gitlab = fakeGitlab(() => jsonAnswer({}));
    const h = gitlabRuntime(gitlab.fetchImpl);
    h.registry.install({
      instance: gitlabInstance({ id: GITLAB_B_ID }),
      unusable: null,
      gitlab: {
        credential: 'runtime-held-secret',
        state: initialGitlabState(GITLAB_HOST),
        fetchImpl: gitlab.fetchImpl,
      },
    });
    h.registry.install({
      instance: atlassianInstance(),
      unusable: { state: 'error', detail: 'no credential' },
    });
    const cases: Array<[Record<string, unknown>, string | RegExp]> = [
      [{ instanceId: undefined }, 'unknown gitlab tool instance'],
      [{ instanceId: 'ti_ffffffffffffffff' }, 'unknown gitlab tool instance'],
      [{ instanceId: ATLASSIAN_ID }, 'unknown gitlab tool instance'],
      [{ teamId: OTHER_TEAM }, `tool instance ${GITLAB_ID} belongs to another workspace`],
      [{ teamId: undefined }, `tool instance ${GITLAB_ID} belongs to another workspace`],
      [{ instanceId: GITLAB_B_ID }, /GitLab instance is not ready \(status pending\)/],
    ];
    for (const [overrides, expected] of cases) {
      const result = await handleGitlab(call('get_project', { project: 'g/p' }, overrides));
      expect(result.status, JSON.stringify(overrides)).toBe('not_run');
      expect(result.refused).toMatch(expected);
    }
    expect(gitlab.seen).toEqual([]);
    expect((await handleGitlab(call('get_project', { project: 'g/p' }))).status).toBe('completed');
  });

  it('re-validates every request and refuses raw access, unknown fields, and hostile projects', async () => {
    const gitlab = fakeGitlab(() => jsonAnswer({}));
    gitlabRuntime(gitlab.fetchImpl);
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
      [{ ...call('get_project', { project: 'g/p' }), repository: 'x' }, /unknown transport field/],
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
        { ...target, operation: 'create_issue_note', operationArgs: { project: 'g/p' } },
        /operation/,
      ],
      ['not an object', /invalid request/],
      [[target], /invalid request/],
    ];
    for (const [body, pattern] of refusals) {
      const result = await handleGitlab(body);
      expect(result.status, JSON.stringify(body).slice(0, 80)).toBe('not_run');
      expect(result.refused).toMatch(pattern);
    }
    expect(gitlab.seen).toEqual([]);
  });

  it('binds host and token to the instance and redacts', async () => {
    const gitlab = fakeGitlab((seen) =>
      jsonAnswer({ echo: `token ${seen.headers['private-token']} glpat-abcdef123456` }),
    );
    const h = gitlabRuntime(gitlab.fetchImpl, 'alpha-secret-one');
    h.registry.install({
      instance: gitlabInstance({ id: GITLAB_B_ID, host: 'gitlab.second.invalid' }),
      unusable: null,
      gitlab: {
        credential: 'bravo-secret-two',
        state: readyState('gitlab.second.invalid'),
        fetchImpl: gitlab.fetchImpl,
      },
    });
    const read = await handleGitlab(call('get_project', { project: 'group/sub/app' }));
    expect(read).toEqual({
      status: 'completed',
      httpStatus: 200,
      output: '{"echo":"token [redacted] [redacted]"}',
      truncated: false,
    });
    expect(gitlab.seen[0]).toEqual({
      url: `https://${GITLAB_HOST}/api/v4/projects/group%2Fsub%2Fapp`,
      method: 'GET',
      headers: { accept: 'application/json', 'private-token': 'alpha-secret-one' },
      body: null,
    });
    // The second instance binds its own host and credential.
    await handleGitlab(call('get_project', { project: 'g/p' }, { instanceId: GITLAB_B_ID }));
    expect(gitlab.seen[1]).toMatchObject({
      url: 'https://gitlab.second.invalid/api/v4/projects/g%2Fp',
      headers: { 'private-token': 'bravo-secret-two' },
    });
  });

  it('follows a read redirect only within the same host and API', async () => {
    const moved = (location: string | null, status = 302) =>
      new Response(null, { status, headers: location === null ? {} : { location } });
    const run = async (location: string | null, operation = 'get_project', args: object = {}) => {
      const gitlab = fakeGitlab((seen) =>
        seen.url.endsWith('/projects/77') ? jsonAnswer({ id: 77 }) : moved(location),
      );
      gitlabRuntime(gitlab.fetchImpl);
      const result = await handleGitlab(call(operation, { project: 'g/old', ...args }));
      return { result, urls: gitlab.seen.map((seen) => seen.url) };
    };
    for (const location of ['/api/v4/projects/77', `https://${GITLAB_HOST}/api/v4/projects/77`]) {
      const { result, urls } = await run(location);
      expect(result).toMatchObject({ status: 'completed', output: '{"id":77}' });
      expect(urls).toHaveLength(2);
    }
    for (const location of [
      'https://evil.example/api/v4/projects/77',
      `http://${GITLAB_HOST}/api/v4/projects/77`,
      `https://${GITLAB_HOST}:8443/api/v4/projects/77`,
      `https://user@${GITLAB_HOST}/api/v4/projects/77`,
      '//evil.example/api/v4/projects/77',
      '/users/sign_in',
      '/api/v4/../../admin',
      'https://',
      null,
    ]) {
      const { result, urls } = await run(location);
      expect(result, String(location)).toMatchObject({ status: 'failed', httpStatus: 302 });
      expect(result.error).toMatch(/redirect that is not followed/);
      // The token never left for another target.
      expect(urls).toEqual([`https://${GITLAB_HOST}/api/v4/projects/g%2Fold`]);
    }
    // A loop ends.
    const loop = await run('/api/v4/projects/g%2Fold');
    expect(loop.result.status).toBe('failed');
    expect(loop.urls).toHaveLength(4);
  });

  it('reports HTTP errors, unreachable hosts, timeouts and dropped answers without upstream detail', async () => {
    const run = async (
      respond: Parameters<typeof fakeGitlab>[0],
      extra: Record<string, unknown> = {},
      signal?: AbortSignal,
    ) => {
      gitlabRuntime(fakeGitlab(respond).fetchImpl);
      return handleGitlab(call('get_project', { project: 'g/p' }, extra), signal);
    };
    expect(await run(() => jsonAnswer({ message: '404 for runtime-held-secret' }, 404))).toEqual({
      status: 'failed',
      httpStatus: 404,
      output: '{"message":"404 for [redacted]"}',
      truncated: false,
    });
    const big = await run(() => new Response('e'.repeat(100_000), { status: 500 }));
    expect(big).toMatchObject({ status: 'failed', httpStatus: 500, truncated: true });
    expect(big.output.length).toBeLessThan(17_000);
    const refused = await run(() => {
      throw new Error('ECONNREFUSED runtime-held-secret');
    });
    expect(refused).toEqual({
      status: 'failed',
      httpStatus: null,
      output: '',
      truncated: false,
      error: 'GitLab could not be reached',
    });
    const hang: GitlabFetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error)),
      );
    gitlabRuntime(hang);
    expect(
      await handleGitlab(call('get_project', { project: 'g/p' }, { timeoutMs: 20 })),
    ).toMatchObject({ status: 'timed_out', httpStatus: null });
    const aborted = new AbortController();
    aborted.abort();
    expect(await run(() => jsonAnswer({}), {}, aborted.signal)).toMatchObject({
      status: 'timed_out',
    });
    // A cut-off 2xx answer is a failure, never data.
    const dropped = await run(() => droppedAnswer('{"id":1}'));
    expect(dropped).toMatchObject({ status: 'failed', httpStatus: 200, truncated: true });
    expect(JSON.stringify(dropped)).not.toContain('synthetic upstream detail');
    expect(
      normalizeGitlabOutput({
        operation: 'get_project',
        project: 'g/p',
        status: 'failed',
        httpStatus: dropped.httpStatus,
        output: dropped.output,
        error: dropped.error,
      }),
    ).toMatchObject({ ok: false, data: null, errorCategory: 'invalid_response' });
    // The capture bound holds exactly and is reported.
    const bounded = await run(() => jsonAnswer('x'.repeat(500)), { maxOutputBytes: 100 });
    expect(bounded).toMatchObject({ status: 'completed', truncated: true });
    expect(bounded.output).toBe(`"${'x'.repeat(99)}\n[output truncated]`);
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

  it('probes GET /user with the token and reports fixed, sanitized details', async () => {
    const probe = async (respond: Parameters<typeof fakeGitlab>[0]) => {
      const gitlab = fakeGitlab(respond);
      const result = await probeGitlab(GITLAB_HOST, 'probe-secret', gitlab.fetchImpl);
      expect(gitlab.seen[0]).toMatchObject({
        url: `https://${GITLAB_HOST}/api/v4/user`,
        method: 'GET',
        headers: { 'private-token': 'probe-secret' },
      });
      expect(JSON.stringify(result)).not.toContain('probe-secret');
      return result;
    };
    expect(await probe(() => jsonAnswer({ id: 1, username: 'bot' }))).toEqual({
      ok: true,
      status: 'ready',
      detail: 'authenticated against the instance host',
    });
    const echo = { message: 'denied probe-secret' };
    expect(await probe(() => jsonAnswer(echo, 401))).toMatchObject({
      ok: false,
      status: 'invalid_auth',
    });
    expect(await probe(() => jsonAnswer(echo, 403))).toMatchObject({ status: 'forbidden' });
    expect(await probe(() => jsonAnswer(echo, 503))).toMatchObject({ status: 'error' });
    expect(
      await probe(() => {
        throw new Error('connect probe-secret');
      }),
    ).toMatchObject({ status: 'unreachable' });
    // A sign-in page or a redirect to one is not an authenticated API.
    for (const answer of [
      () => new Response('<html>Sign in</html>'),
      () => jsonAnswer(null),
      () => jsonAnswer({ message: 'ok' }),
      () => new Response(null, { status: 302, headers: { location: '/users/sign_in' } }),
    ])
      expect(await probe(answer)).toMatchObject({ ok: false, status: 'error' });
    const invalid = fakeGitlab(() => jsonAnswer({ id: 1 }));
    expect(await probeGitlab('user@evil.example', 'probe-secret', invalid.fetchImpl)).toMatchObject(
      { ok: false, status: 'error' },
    );
    expect(invalid.seen).toEqual([]);
  });

  it('redacts every credential the runtime holds, across instances and kinds', () => {
    const h = harness();
    h.registry.install({
      instance: gitlabInstance(),
      unusable: null,
      gitlab: {
        credential: 'gitlab-held-credential',
        state: initialGitlabState(GITLAB_HOST),
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
    // A removed instance's credential is no longer on the list (it is no longer held).
    setInstanceRegistry(null);
    expect(redactRuntimeOutput('gitlab-held-credential')).toBe('gitlab-held-credential');
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

  it('redacts a whole base64 Basic or Bearer credential and keeps the scheme', () => {
    expect(redactRuntimeOutput('sent Basic dXNl+cjpw/YXNz== to h')).toBe(
      'sent Basic [redacted] to h',
    );
    expect(redactRuntimeOutput('sent bearer ab+cd/ef= to h')).toBe('sent bearer [redacted] to h');
  });

  it('streams a trace: tail by default, head on request, redacted', async () => {
    // About 120 000 bytes: a token line at the top, numbered lines, a summary.
    const trace = [
      'token: runtime-held-secret and glpat-printedByTheJob1234',
      ...Array.from({ length: 12_000 }, (_, i) => `f ${10_000 + i} ok`),
      'Authorization: Bearer leaked.value',
      '1 flaky: retried spec',
      '',
    ].join('\n');
    const gitlab = fakeGitlab((seen) =>
      seen.url.endsWith('/jobs/404/trace')
        ? jsonAnswer({ message: '404 Not found' }, 404)
        : new Response(trace),
    );
    gitlabRuntime(gitlab.fetchImpl);
    const tail = await handleGitlab(call('get_job_trace', { project: 'g/p', job_id: 7 }));
    expect(gitlab.seen[0]).toMatchObject({
      url: `https://${GITLAB_HOST}/api/v4/projects/g%2Fp/jobs/7/trace`,
      headers: { accept: 'text/plain' },
    });
    expect(tail.status).toBe('completed');
    expect(tail.textMeta).toMatchObject({ part: 'tail', cut: false });
    expect(tail.textMeta!.returnedBytes).toBeLessThanOrEqual(48_000);
    expect(tail.textMeta!.totalBytes).toBe(Buffer.byteLength(trace));
    expect(tail.truncated).toBe(true);
    expect(tail.output).toMatch(/^f \d{5} ok\n/);
    expect(tail.output.endsWith('Authorization: [redacted]\n1 flaky: retried spec\n')).toBe(true);
    expect(tail.output).not.toContain('leaked.value');
    const head = await handleGitlab(
      call('get_job_trace', { project: 'g/p', job_id: 7, head: true }),
    );
    expect(head.textMeta).toMatchObject({ part: 'head', cut: false });
    expect(head.textMeta!.totalBytes).toBe(tail.textMeta!.totalBytes);
    expect(head.output.startsWith('token: [redacted] and [redacted]\nf 10000 ok\n')).toBe(true);
    expect(head.output).not.toContain('runtime-held-secret');
    expect(head.output).not.toContain('printedByTheJob');
    // An HTTP error keeps its status and JSON body and is no trace.
    expect(await handleGitlab(call('get_job_trace', { project: 'g/p', job_id: 404 }))).toEqual({
      status: 'failed',
      httpStatus: 404,
      output: '{"message":"404 Not found"}',
      truncated: false,
    });
  });

  it('fails a trace whose connection drops, with the retained part marked cut', async () => {
    gitlabRuntime(fakeGitlab(() => droppedAnswer('partial text\n')).fetchImpl);
    const result = await handleGitlab(call('get_job_trace', { project: 'g/p', job_id: 7 }));
    expect(result).toMatchObject({
      status: 'failed',
      httpStatus: 200,
      truncated: true,
      textMeta: { cut: true, totalBytes: 13, returnedBytes: 13 },
    });
    expect(
      normalizeGitlabOutput({
        operation: 'get_job_trace',
        project: 'g/p',
        status: 'failed',
        httpStatus: result.httpStatus,
        output: result.output,
        textMeta: result.textMeta,
      }),
    ).toMatchObject({ ok: false, data: null, errorCategory: 'invalid_response' });
  });

  it('stops reading a runaway trace at the 8 MiB hard cut', async () => {
    const chunk = Buffer.from('endless filler line of a runaway job log\n'.repeat(1600));
    let cancelled = false;
    gitlabRuntime(
      fakeGitlab(
        () =>
          new Response(
            new ReadableStream({
              pull: (controller) => controller.enqueue(chunk),
              cancel: () => {
                cancelled = true;
              },
            }),
          ),
      ).fetchImpl,
    );
    const result = await handleGitlab(call('get_job_trace', { project: 'g/p', job_id: 7 }));
    expect(result).toMatchObject({ status: 'completed', httpStatus: 200, truncated: true });
    expect(result.textMeta).toMatchObject({ part: 'tail', cut: true });
    expect(result.textMeta!.totalBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(result.textMeta!.totalBytes).toBeLessThan(8 * 1024 * 1024 + 1024 * 1024);
    expect(result.textMeta!.returnedBytes).toBeLessThanOrEqual(48_000);
    expect(result.output.split('\n')[0]).toBe('endless filler line of a runaway job log');
    expect(cancelled).toBe(true);
  });
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

  /** The runtime over GitLab's files API: the content base64-encoded. */
  function runtime() {
    const { fetchImpl } = fakeGitlab((seen) => {
      const name = decodeURIComponent(new URL(seen.url).pathname.split('/repository/files/')[1]!);
      const bytes = FILES[name]!;
      return jsonAnswer({
        file_name: name,
        file_path: name,
        size: bytes.length,
        encoding: 'base64',
        content_sha256: 'x',
        ref: 'main',
        blob_id: 'b1',
        commit_id: 'c1',
        last_commit_id: 'c0',
        content: bytes.toString('base64'),
      });
    });
    return gitlabRuntime(fetchImpl, SECRET);
  }

  it('decodes text, reports binary and oversize files, and redacts the decoded text', async () => {
    runtime();
    const read = (file_path: string, maxOutputBytes = 200_000) =>
      handleGitlab(
        call('get_repository_file', { project: 'g/p', file_path, ref: 'main' }, { maxOutputBytes }),
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
    expect(decoded.content).toBe('# On call\nPage the owner.\ntoken [redacted]\nold [redacted]\n');
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
  });

  /** The native read tools over an HTTP stand-in for the tool runtime's /gitlab route. */
  async function readTools(h: ReturnType<typeof gitlabRuntime>) {
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
      res.end(JSON.stringify(await handleGitlab(body)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const close = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
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
      return { tools, requests, close };
    } catch (err) {
      await close();
      throw err;
    }
  }

  it("answers the read tool (and Code Mode, which calls it) with the coding path's normalization", async () => {
    const { tools, requests, close } = await readTools(runtime());
    try {
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
      await close();
    }
  }, 30_000);

  it('names the full paths of reachable projects when GitLab does not find the project', async () => {
    const { seen, fetchImpl } = fakeGitlab((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v4/projects')
        return jsonAnswer([
          { id: 1, path_with_namespace: 'apps/app-shell' },
          { id: 2, path_with_namespace: 'top/frontend/app' },
        ]);
      return jsonAnswer({ message: '404 Project Not Found' }, 404);
    });
    const { tools, close } = await readTools(gitlabRuntime(fetchImpl));
    try {
      const missing = (await tools.get_repository_file!.execute(
        { project: 'frontend/app', file_path: 'package.json', ref: 'main' },
        {},
      )) as { result: { ok: boolean }; content: Array<{ text: string }> };
      expect(missing.result.ok).toBe(false);
      expect(missing.content[0]!.text).toBe(
        'failed (get_repository_file @ frontend/app): [not_found] GitLab project was not found (or is not visible to this token). Projects named "app" this token can reach: top/frontend/app. Use the full path, starting at the top-level group.',
      );
      expect(seen.map((request) => request.method)).toEqual(['GET', 'GET']);
      expect(new URL(seen[1]!.url).search).toBe(
        '?membership=true&simple=true&order_by=last_activity_at&sort=desc&search=app&page=1&per_page=100',
      );
    } finally {
      await close();
    }
  }, 30_000);
});
