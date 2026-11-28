import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveGitlab, EffectiveTool } from '../../src/integrations/tools/tool-profile.js';
import {
  fetchCliRuntimeReadiness,
  fetchDatadogCatalog,
  verifyAtlassianInstance,
  verifyDatadogInstance,
  verifyGitlabInstance,
  type RuntimeInstanceReadiness,
} from '../../src/integrations/tools/tool-runtime-readiness.js';
import { datadogCatalogHash } from '../../src/integrations/datadog/datadog-mcp-adapter.js';

const RUNTIME = { url: 'http://cli-runtime:9877', token: 'runtime-token' };
const TEAM = 'T0TEAM1';
const GITLAB_ID = 'ti_0000000000000001';
const ATLASSIAN_ID = 'ti_0000000000000003';
const DATADOG_ID = 'ti_0000000000000004';

const GITLAB: EffectiveGitlab = {
  instanceId: GITLAB_ID,
  label: 'GitLab (test)',
  host: 'gitlab.test.example',
  credentialVersion: 3,
};

function atlassianTool(operations: string[]): EffectiveTool {
  return {
    name: 'atlassian',
    instanceId: ATLASSIAN_ID,
    label: 'Jira (test)',
    credentialVersion: 2,
    adapter: 'atlassian-rest-v1',
    contractVersion: 'atlassian-read-v4',
    operations,
  };
}

function gitlabStatus(
  overrides: Partial<RuntimeInstanceReadiness> = {},
  gitlab: Record<string, unknown> = {},
): RuntimeInstanceReadiness {
  return {
    instanceId: GITLAB_ID,
    teamId: TEAM,
    kind: 'gitlab',
    label: 'GitLab (test)',
    credentialVersion: 3,
    state: 'ready',
    detail: 'authenticated against the instance host',
    gitlab: {
      ready: true,
      status: 'ready',
      detail: 'authenticated against the instance host',
      host: 'gitlab.test.example',
      contractVersion: 6,
      ...gitlab,
    } as RuntimeInstanceReadiness['gitlab'],
    ...overrides,
  };
}

function atlassianStatus(
  operations: string[],
  overrides: Record<string, unknown> = {},
  instance: Partial<RuntimeInstanceReadiness> = {},
): RuntimeInstanceReadiness {
  return {
    instanceId: ATLASSIAN_ID,
    teamId: TEAM,
    kind: 'atlassian',
    label: 'Jira (test)',
    credentialVersion: 2,
    state: 'ready',
    detail: 'scoped read-only REST reads available',
    atlassian: {
      tool: 'atlassian',
      enabled: true,
      ready: true,
      status: 'ready',
      detail: `qualified ${operations.length} operations`,
      site: 'example.atlassian.net',
      cloudId: '00000000-0000-4000-8000-000000000000',
      products: { jira: 'ready', confluence: 'ready' },
      credentialFingerprints: { jira: '0123456789abcdef', confluence: 'fedcba9876543210' },
      checkedAt: '2026-09-25T10:00:00.000Z',
      adapter: 'atlassian-rest-v1',
      contractVersion: 'atlassian-read-v4',
      operations,
      ...overrides,
    } as RuntimeInstanceReadiness['atlassian'],
    ...instance,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tool runtime readiness report', () => {
  it('reads the per-instance report with the runner token', async () => {
    const instances = [gitlabStatus(), atlassianStatus(['getJiraIssue'])];
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) =>
      Response.json({ service: 'cli-runtime', configVersion: 41, syncError: null, instances }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const parsed = await fetchCliRuntimeReadiness(RUNTIME.url, RUNTIME.token);
    expect(parsed).toEqual({
      service: 'cli-runtime',
      configVersion: 41,
      syncError: null,
      instances,
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://cli-runtime:9877/readyz');
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer runtime-token',
    );
    // A report before the first sync is still a valid (empty) report.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ instances: [], syncError: 'admin unreachable: TypeError' }),
      ),
    );
    expect(await fetchCliRuntimeReadiness(RUNTIME.url, RUNTIME.token)).toEqual({
      service: 'cli-runtime',
      configVersion: null,
      syncError: 'admin unreachable: TypeError',
      instances: [],
    });
  });

  it('retries network errors and 5xx a bounded number of times and fails visibly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    for (const [answer, pattern, calls] of [
      [() => new Response('no', { status: 401 }), /CLI_RUNTIME_TOKEN mismatch/, 1],
      [() => new Response('no', { status: 403 }), /CLI_RUNTIME_TOKEN mismatch/, 1],
      [() => new Response('no', { status: 404 }), /returned HTTP 404/, 1],
      [() => new Response('no', { status: 503 }), /returned HTTP 503/, 3],
      [() => new Response('<html>', { status: 200 }), /JSON/, 3],
      [
        () => {
          throw new TypeError('fetch failed');
        },
        /fetch failed/,
        3,
      ],
      // The pre-instance report shape (global gitlab/atlassian) is refused.
      [() => Response.json({ gitlab: null, atlassian: null }), /invalid readiness report/, 1],
    ] as const) {
      const fetchMock = vi.fn(async () => answer());
      vi.stubGlobal('fetch', fetchMock);
      const failure = expect(fetchCliRuntimeReadiness(RUNTIME.url, RUNTIME.token)).rejects.toThrow(
        pattern,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await failure;
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
  });
});

describe('tool runtime Atlassian readiness', () => {
  it('accepts the scope-limited Atlassian readiness subset of its instance', () => {
    const operations = ['getConfluencePage', 'getJiraIssue'];
    const binding = verifyAtlassianInstance(
      atlassianStatus(operations),
      atlassianTool(operations),
      TEAM,
    );
    // The binding excludes volatile readiness fields (checkedAt, products).
    expect(binding).toEqual({
      site: 'example.atlassian.net',
      cloudId: '00000000-0000-4000-8000-000000000000',
      adapter: 'atlassian-rest-v1',
      contractVersion: 'atlassian-read-v4',
      operations,
      credentialFingerprints: { jira: '0123456789abcdef', confluence: 'fedcba9876543210' },
    });
  });

  it('refuses an instance the runtime does not serve, serves for another workspace, or reports unready', () => {
    const tool = atlassianTool(['getJiraIssue']);
    const cases: Array<[RuntimeInstanceReadiness | undefined, string, RegExp]> = [
      [undefined, TEAM, /does not serve this instance yet/],
      [atlassianStatus(['getJiraIssue']), 'T0OTHER', /another kind or workspace/],
      [atlassianStatus(['getJiraIssue'], {}, { kind: 'gitlab' }), TEAM, /another kind/],
      [
        atlassianStatus(['getJiraIssue'], {}, { state: 'blocked', detail: 'host not admitted' }),
        TEAM,
        /reports it blocked: host not admitted/,
      ],
      [
        atlassianStatus(['getJiraIssue'], {}, { state: 'pending', detail: 'not yet' }),
        TEAM,
        /reports it pending/,
      ],
      [atlassianStatus(['getJiraIssue'], { ready: false }), TEAM, /Atlassian readiness is missing/],
      [
        atlassianStatus(['getJiraIssue'], {}, { atlassian: undefined }),
        TEAM,
        /Atlassian readiness is missing/,
      ],
      [
        atlassianStatus(['getJiraIssue'], {}, { credentialVersion: 1 }),
        TEAM,
        /another credential version/,
      ],
      [
        atlassianStatus(['getJiraIssue'], { contractVersion: 'atlassian-read-v3' }),
        TEAM,
        /contract atlassian-read-v3 is not supported/,
      ],
    ];
    for (const [status, teamId, pattern] of cases)
      expect(() => verifyAtlassianInstance(status, tool, teamId)).toThrow(pattern);
  });

  it('rejects a readiness answer without a site/cloud-ID/credential binding', () => {
    for (const overrides of [
      { site: null },
      { site: '' },
      { cloudId: null },
      { cloudId: 'not-a-uuid' },
      { credentialFingerprints: {} },
      { credentialFingerprints: { jira: 'not-hex' } },
      { credentialFingerprints: { bitbucket: '0123456789abcdef' } },
      { adapter: 'atlassian-acli-v1' },
    ]) {
      expect(() =>
        verifyAtlassianInstance(
          atlassianStatus(['getJiraIssue'], overrides),
          atlassianTool(['getJiraIssue']),
          TEAM,
        ),
      ).toThrow(/binding/);
    }
  });

  it('takes the site binding solely from the runtime (no tool-configuration pin)', () => {
    const binding = verifyAtlassianInstance(
      atlassianStatus(['getJiraIssue'], { site: 'test.atlassian.net' }),
      atlassianTool(['getJiraIssue']),
      TEAM,
    );
    expect(binding.site).toBe('test.atlassian.net');
  });

  it('keeps assigned Jira reads usable when Confluence lacks scope', () => {
    const status = atlassianStatus(['getJiraIssue', 'listJiraProjects'], {
      products: { jira: 'ready', confluence: 'insufficient_scope' },
    });
    expect(
      verifyAtlassianInstance(status, atlassianTool(['getJiraIssue', 'getConfluencePage']), TEAM)
        .operations,
    ).toEqual(['getJiraIssue']);
    expect(
      verifyAtlassianInstance(status, atlassianTool(['getConfluencePage']), TEAM).operations,
    ).toEqual([]);
  });

  it('rejects a configured operation whose product is not ready', () => {
    expect(() =>
      verifyAtlassianInstance(
        atlassianStatus(['getConfluencePage', 'getJiraIssue']),
        atlassianTool(['getConfluencePage', 'getJiraIssue', 'searchJiraIssuesUsingJql']),
        TEAM,
      ),
    ).toThrow(/searchJiraIssuesUsingJql is not ready/);
    expect(() =>
      verifyAtlassianInstance(
        atlassianStatus(['getJiraIssue']),
        atlassianTool(['getJiraIssue', 'deleteJiraIssue']),
        TEAM,
      ),
    ).toThrow(/unknown Atlassian operation deleteJiraIssue/);
  });
});

describe('tool runtime GitLab readiness', () => {
  it('qualifies the instance for its host and contract', () => {
    const binding = { instanceId: GITLAB_ID, host: 'gitlab.test.example', contractVersion: 6 };
    expect(verifyGitlabInstance(gitlabStatus(), GITLAB, TEAM)).toEqual(binding);
    // Host case is normalized.
    expect(
      verifyGitlabInstance(gitlabStatus({}, { host: 'GitLab.Test.Example' }), GITLAB, TEAM),
    ).toEqual(binding);
  });

  it('fails visibly when the instance is unserved, foreign, unready, on another host, or another contract', () => {
    const cases: Array<[RuntimeInstanceReadiness | undefined, string, RegExp]> = [
      [undefined, TEAM, /does not serve this instance yet/],
      [gitlabStatus(), 'T0OTHER', /another kind or workspace/],
      [
        gitlabStatus({ state: 'error', detail: '401 Unauthorized' }),
        TEAM,
        /reports it error: 401 Unauthorized/,
      ],
      [
        gitlabStatus({
          state: 'blocked',
          detail: 'host not admitted: gitlab.test.example is not in GITLAB_HOSTS',
        }),
        TEAM,
        /reports it blocked: host not admitted/,
      ],
      [gitlabStatus({ gitlab: undefined }), TEAM, /GitLab readiness is missing/],
      [gitlabStatus({}, { ready: false }), TEAM, /GitLab readiness is missing/],
      [gitlabStatus({}, { host: 'gitlab.other.example' }), TEAM, /different host/],
      // A runtime still on v5 (partially rebuilt pair) must not become ready.
      [
        gitlabStatus({}, { contractVersion: 5 }),
        TEAM,
        /contract v5 .* does not match this runner \(v6\)/,
      ],
      [gitlabStatus({ credentialVersion: 2 }), TEAM, /another credential version; retry shortly/],
    ];
    for (const [status, teamId, pattern] of cases)
      expect(() => verifyGitlabInstance(status, GITLAB, teamId)).toThrow(pattern);
  });
});

describe('tool runtime Datadog readiness', () => {
  const fingerprint = randomBytes(8).toString('hex');
  const tools = [
    {
      name: 'search_datadog_logs',
      description: 'Search logs.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
    {
      name: 'search_datadog_monitors',
      description: 'Search monitors.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  const excludedTools = ['create_datadog_monitor'];
  const hash = datadogCatalogHash({ tools, excludedTools });
  const tool: EffectiveTool = {
    name: 'datadog',
    instanceId: DATADOG_ID,
    label: 'Datadog (test)',
    credentialVersion: 4,
    adapter: 'datadog-mcp-v1',
    contractVersion: 'datadog-read-v1',
    denyTools: ['search_datadog_monitors'],
  };
  const status = (overrides: Partial<RuntimeInstanceReadiness> = {}): RuntimeInstanceReadiness => ({
    instanceId: DATADOG_ID,
    teamId: TEAM,
    kind: 'datadog',
    label: 'Datadog (test)',
    credentialVersion: 4,
    state: 'ready',
    detail: 'read-only MCP tools available',
    datadog: {
      tool: 'datadog',
      enabled: true,
      ready: true,
      status: 'ready',
      detail: 'read-only MCP tools available',
      site: 'datadoghq.eu',
      endpoint: 'https://mcp.datadoghq.eu/v1/mcp',
      adapter: 'datadog-mcp-v1',
      contractVersion: 'datadog-read-v1',
      protocolVersion: '2025-06-18',
      serverName: 'datadog-mcp',
      serverVersion: '1.2.3',
      toolsets: 'all',
      toolCatalogHash: hash,
      tools: tools.map((entry) => entry.name),
      excludedTools,
      credentialFingerprint: fingerprint,
      checkedAt: '2026-09-25T10:00:00.000Z',
    },
    ...overrides,
  });

  it('repeated qualification is stable and a real upstream schema change changes the binding', async () => {
    const qualify = async (catalogTools: typeof tools) => {
      const toolCatalogHash = datadogCatalogHash({ tools: catalogTools, excludedTools });
      const ready = status();
      ready.datadog!.toolCatalogHash = toolCatalogHash;
      return verifyDatadogInstance(ready, tool, TEAM, RUNTIME, async () => ({
        tools: catalogTools,
        excludedTools,
        toolCatalogHash,
      }));
    };
    const first = await qualify(tools);
    expect(await qualify(structuredClone(tools))).toEqual(first);
    const changed = structuredClone(tools);
    changed[0]!.description = 'Changed upstream capability description.';
    const next = await qualify(changed);
    expect(next.binding.toolCatalogHash).not.toBe(first.binding.toolCatalogHash);
  });

  it('fetches the instance catalog for the run workspace and applies the deny list', async () => {
    const requested: Array<{ instanceId: string; teamId: string }> = [];
    const catalogFetch: typeof fetchDatadogCatalog = async (_runtime, instance) => {
      requested.push(instance);
      return { tools, excludedTools, toolCatalogHash: hash };
    };
    const qualified = await verifyDatadogInstance(status(), tool, TEAM, RUNTIME, catalogFetch);
    expect(requested).toEqual([{ instanceId: DATADOG_ID, teamId: TEAM }]);
    expect(qualified.binding).toEqual({
      site: 'datadoghq.eu',
      endpoint: 'https://mcp.datadoghq.eu/v1/mcp',
      adapter: 'datadog-mcp-v1',
      contractVersion: 'datadog-read-v1',
      toolCatalogHash: hash,
      credentialFingerprint: fingerprint,
    });
    expect(qualified.tools.map((entry) => entry.name)).toEqual(['search_datadog_logs']);
    expect(qualified.excludedTools).toEqual(['create_datadog_monitor', 'search_datadog_monitors']);
  });

  it('refuses a foreign or unready instance before fetching its catalog, and a changed catalog', async () => {
    const catalogFetch = vi.fn(async () => ({ tools, excludedTools, toolCatalogHash: hash }));
    await expect(
      verifyDatadogInstance(status(), tool, 'T0OTHER', RUNTIME, catalogFetch),
    ).rejects.toThrow(/another kind or workspace/);
    await expect(
      verifyDatadogInstance(status({ credentialVersion: 3 }), tool, TEAM, RUNTIME, catalogFetch),
    ).rejects.toThrow(/another credential version/);
    await expect(
      verifyDatadogInstance(
        status({ state: 'error', detail: 'invalid_auth' }),
        tool,
        TEAM,
        RUNTIME,
        catalogFetch,
      ),
    ).rejects.toThrow(/reports it error: invalid_auth/);
    expect(catalogFetch).not.toHaveBeenCalled();
    await expect(
      verifyDatadogInstance(status(), tool, TEAM, RUNTIME, async () => ({
        tools: tools.slice(0, 1),
        excludedTools,
        toolCatalogHash: hash,
      })),
    ).rejects.toThrow(/catalog changed during qualification/);
  });

  it('requests the catalog with instance, workspace and token, and surfaces a runtime refusal', async () => {
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) =>
      Response.json({
        tools: [],
        excludedTools: [],
        toolCatalogHash: null,
        refused: 'unknown datadog tool instance',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchDatadogCatalog(RUNTIME, { instanceId: DATADOG_ID, teamId: TEAM }),
    ).rejects.toThrow('unknown datadog tool instance');
    const url = fetchMock.mock.calls[0]![0];
    expect(url.pathname).toBe('/datadog/catalog');
    expect(url.searchParams.get('instanceId')).toBe(DATADOG_ID);
    expect(url.searchParams.get('teamId')).toBe(TEAM);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer runtime-token',
    );
  });
});
