/** Admin-managed tool instances as the runtimes see them: listing sync, secret reads, status reports. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchToolSecret,
  hostAllowlist,
  parseSyncedInstance,
  probeIntervalMs,
  sanitizeStatusDetail,
  ToolInstanceError,
  ToolInstanceSync,
  type SyncedToolInstance,
} from '../../src/integrations/tools/tool-instances.js';

const ADMIN = 'http://admin:9883/';
const ADMIN_TOKEN = 'admin-internal-token';
const CLOUD = '11111111-1111-4111-8111-111111111111';

const GITLAB = {
  id: 'ti_0123456789abcdef',
  teamId: 'T0TEAM1',
  kind: 'gitlab',
  label: 'GitLab (test)',
  host: 'gitlab.example.com',
  settings: {},
  credentialVersion: 3,
  hasCredential: true,
};
const ATLASSIAN = {
  id: 'ti_1111111111111111',
  teamId: 'T0TEAM1',
  kind: 'atlassian',
  label: 'Jira (test)',
  host: 'example.atlassian.net',
  settings: { cloudId: CLOUD, email: 'bot@example.com', operations: null },
  credentialVersion: 1,
  hasCredential: true,
};
const WEB_SEARCH = {
  id: 'ti_2222222222222222',
  teamId: 'T0TEAM2',
  kind: 'webSearch',
  label: 'Search',
  host: null,
  settings: {},
  credentialVersion: 0,
  hasCredential: false,
};

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** Fake admin service behind an injected fetch; answers are queued per call. */
function fakeAdmin(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    seen.push(entry);
    return answer(entry);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const listing = (instances: unknown[], etag: string, configVersion = 7): Response =>
  Response.json({ configVersion, instances }, { headers: { etag } });

afterEach(() => {
  vi.useRealTimers();
});

describe('parseSyncedInstance', () => {
  it('accepts a well-formed instance and normalizes it with the shared kinds module', () => {
    const parsed = parseSyncedInstance({ ...ATLASSIAN, host: 'Example.Atlassian.NET' });
    expect(parsed).toEqual({
      ...ATLASSIAN,
      host: 'example.atlassian.net',
      settings: { cloudId: CLOUD, email: 'bot@example.com', operations: null },
    });
    // hasCredential is true only for an explicit true.
    expect(parseSyncedInstance({ ...GITLAB, hasCredential: 'yes' })?.hasCredential).toBe(false);
  });

  it('drops malformed instances instead of trusting them', () => {
    const malformed: unknown[] = [
      null,
      'ti_0123456789abcdef',
      [GITLAB],
      { ...GITLAB, id: 'ti_UPPER' },
      { ...GITLAB, id: '../secret' },
      { ...GITLAB, teamId: 'not-a-team' },
      { ...GITLAB, credentialVersion: -1 },
      { ...GITLAB, credentialVersion: 1.5 },
      { ...GITLAB, kind: 'shell' },
      { ...GITLAB, host: 'https://gitlab.example.com' },
      { ...GITLAB, host: 'evil.example/path' },
      { ...GITLAB, settings: { token: 'smuggled' } },
      { ...GITLAB, label: '' },
      { ...ATLASSIAN, host: 'evil.example.com' },
      { ...ATLASSIAN, settings: { ...ATLASSIAN.settings, operations: ['deleteJiraIssue'] } },
      // Web search is credential-free and settings-free (the retired provider shape).
      { ...WEB_SEARCH, settings: { endpoint: 'https://search.example/v1' } },
      { ...WEB_SEARCH, host: 'search.example' },
      { ...GITLAB, kind: 'datadog', host: 'ddog-gov.com', settings: {} },
    ];
    for (const raw of malformed) expect(parseSyncedInstance(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('ToolInstanceSync', () => {
  it('keeps only its kinds, drops malformed entries and revalidates with the ETag', async () => {
    const answers: Response[] = [
      listing([GITLAB, ATLASSIAN, WEB_SEARCH, { ...GITLAB, id: 'bad' }], '"v1"'),
      new Response(null, { status: 304 }),
      // Same content under a new ETag: no change notification.
      listing([GITLAB, ATLASSIAN, WEB_SEARCH], '"v2"', 8),
      listing([{ ...GITLAB, credentialVersion: 4 }, WEB_SEARCH], '"v3"', 9),
    ];
    const admin = fakeAdmin(() => answers.shift()!);
    const changes: Array<ReadonlyMap<string, SyncedToolInstance>> = [];
    const logs: string[] = [];
    const sync = new ToolInstanceSync({
      adminUrl: ADMIN,
      adminToken: ADMIN_TOKEN,
      caller: 'cli-runtime',
      kinds: ['gitlab', 'atlassian', 'datadog'],
      fetchImpl: admin.fetchImpl,
      onChange: (instances) => changes.push(instances),
      log: (line) => logs.push(line),
    });

    await sync.syncOnce();
    expect([...sync.current().keys()]).toEqual([GITLAB.id, ATLASSIAN.id]);
    expect(sync.configVersion).toBe(7);
    expect(sync.lastError).toBeNull();
    expect(changes).toHaveLength(1);
    expect(logs).toEqual(['tool instance sync: dropped a malformed instance']);
    expect(admin.seen[0]).toMatchObject({
      url: 'http://admin:9883/internal/tool-instances',
      method: 'GET',
    });
    expect(admin.seen[0]!.headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(admin.seen[0]!.headers.get('x-support-agent-caller')).toBe('cli-runtime');
    expect(admin.seen[0]!.headers.get('if-none-match')).toBeNull();

    await sync.syncOnce();
    expect(admin.seen[1]!.headers.get('if-none-match')).toBe('"v1"');
    expect(changes).toHaveLength(1);
    expect(sync.current().size).toBe(2);

    await sync.syncOnce();
    expect(changes).toHaveLength(1);
    expect(sync.configVersion).toBe(8);

    await sync.syncOnce();
    expect(admin.seen[3]!.headers.get('if-none-match')).toBe('"v2"');
    expect(changes).toHaveLength(2);
    expect([...changes[1]!.keys()]).toEqual([GITLAB.id]);
    expect(changes[1]!.get(GITLAB.id)?.credentialVersion).toBe(4);
  });

  it('never throws and keeps the last listing on admin failures', async () => {
    const answers: Array<Response | Error> = [
      listing([GITLAB], '"v1"'),
      new Response('boom', { status: 500 }),
      new TypeError('connect ECONNREFUSED admin secret-detail'),
      new Response('not json', { status: 200 }),
    ];
    const admin = fakeAdmin(() => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const sync = new ToolInstanceSync({
      adminUrl: ADMIN,
      adminToken: ADMIN_TOKEN,
      caller: 'runner',
      kinds: ['gitlab'],
      fetchImpl: admin.fetchImpl,
    });
    await sync.syncOnce();
    await sync.syncOnce();
    expect(sync.lastError).toBe('admin answered HTTP 500');
    await sync.syncOnce();
    expect(sync.lastError).toBe('admin unreachable: TypeError');
    await sync.syncOnce();
    expect(sync.lastError).toBe('admin returned invalid JSON');
    expect([...sync.current().keys()]).toEqual([GITLAB.id]);
  });

  it('keeps the last listing and ETag when a 2xx answer is not a listing', async () => {
    const answers: Response[] = [
      listing([GITLAB], '"v1"'),
      new Response('null', { status: 200, headers: { etag: '"v2"' } }),
      Response.json({ configVersion: 8 }, { headers: { etag: '"v3"' } }),
      Response.json({ configVersion: 8, instances: {} }, { headers: { etag: '"v4"' } }),
      new Response(null, { status: 304 }),
    ];
    const admin = fakeAdmin(() => answers.shift()!);
    const changes: Array<ReadonlyMap<string, unknown>> = [];
    const sync = new ToolInstanceSync({
      adminUrl: ADMIN,
      adminToken: ADMIN_TOKEN,
      caller: 'runner',
      kinds: ['gitlab'],
      fetchImpl: admin.fetchImpl,
      onChange: (next) => changes.push(next),
    });
    await sync.syncOnce();
    for (let round = 0; round < 3; round += 1) {
      await expect(sync.syncOnce()).resolves.toBeUndefined();
      expect(sync.lastError).toBe('admin returned an invalid tool instance listing');
      expect([...sync.current().keys()]).toEqual([GITLAB.id]);
    }
    await sync.syncOnce();
    expect(admin.seen.at(-1)!.headers.get('if-none-match')).toBe('"v1"');
    expect(changes).toHaveLength(1);
  });

  it('shares one request between concurrent callers and stays idle when unconfigured', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admin = fakeAdmin(async () => {
      await gate;
      return listing([GITLAB], '"v1"');
    });
    const sync = new ToolInstanceSync({
      adminUrl: ADMIN,
      adminToken: ADMIN_TOKEN,
      caller: 'cli-runtime',
      kinds: ['gitlab'],
      fetchImpl: admin.fetchImpl,
    });
    const both = Promise.all([sync.syncOnce(), sync.syncOnce()]);
    release();
    await both;
    expect(admin.seen).toHaveLength(1);

    const idle = fakeAdmin(() => listing([], '"x"'));
    const unconfigured = new ToolInstanceSync({
      adminUrl: ' ',
      adminToken: ADMIN_TOKEN,
      caller: 'web-runtime',
      kinds: ['webFetch'],
      fetchImpl: idle.fetchImpl,
    });
    expect(unconfigured.configured).toBe(false);
    await unconfigured.syncOnce();
    expect(unconfigured.lastError).toMatch(/ADMIN_URL and ADMIN_INTERNAL_TOKEN are required/);
    await unconfigured.report([
      { instanceId: GITLAB.id, state: 'ready', detail: 'x', credentialVersion: 1 },
    ]);
    expect(idle.seen).toHaveLength(0);
  });

  it('polls on start and stops polling on stop', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const admin = fakeAdmin(() => listing([GITLAB], '"v1"'));
    const sync = new ToolInstanceSync({
      adminUrl: ADMIN,
      adminToken: ADMIN_TOKEN,
      caller: 'cli-runtime',
      kinds: ['gitlab'],
      pollMs: 1_000,
      fetchImpl: admin.fetchImpl,
    });
    sync.start();
    sync.start();
    await vi.waitFor(() => expect(admin.seen).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(admin.seen).toHaveLength(2);
    sync.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(admin.seen).toHaveLength(2);
  });

  it('reports sanitized, bounded statuses and never throws on report failures', async () => {
    const answers: Array<Response | Error> = [
      new Response(null, { status: 204 }),
      new Response('no', { status: 400 }),
      new Error('network down'),
    ];
    const admin = fakeAdmin(() => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const logs: string[] = [];
    const sync = new ToolInstanceSync({
      adminUrl: ADMIN,
      adminToken: ADMIN_TOKEN,
      caller: 'cli-runtime',
      kinds: ['gitlab'],
      fetchImpl: admin.fetchImpl,
      log: (line) => logs.push(line),
    });
    const statuses = Array.from({ length: 300 }, (_, i) => ({
      instanceId: GITLAB.id,
      state: 'error' as const,
      detail: `line one\n\u0000line\ttwo ${'x'.repeat(400)} ${i}`,
      credentialVersion: 2,
      toolsCount: null,
    }));
    await sync.report(statuses);
    expect(admin.seen[0]).toMatchObject({
      url: 'http://admin:9883/internal/tool-instances/status',
      method: 'POST',
    });
    expect(admin.seen[0]!.headers.get('x-support-agent-caller')).toBe('cli-runtime');
    expect(admin.seen[0]!.headers.get('content-type')).toBe('application/json');
    const body = admin.seen[0]!.body as {
      reporter: string;
      statuses: Array<Record<string, unknown>>;
    };
    expect(body.reporter).toBe('cli-runtime');
    expect(body.statuses).toHaveLength(256);
    const detail = String(body.statuses[0]!.detail);
    expect(detail.startsWith('line one line two xxx')).toBe(true);
    expect(detail).toHaveLength(200);
    // eslint-disable-next-line no-control-regex
    expect(detail).not.toMatch(/[\u0000-\u001f]/);
    expect(body.statuses[0]).toMatchObject({
      instanceId: GITLAB.id,
      state: 'error',
      credentialVersion: 2,
    });
    await sync.report(statuses.slice(0, 1));
    await sync.report(statuses.slice(0, 1));
    expect(logs).toEqual([
      'tool status report answered HTTP 400',
      'tool status report failed: Error',
    ]);
    await sync.report([]);
    expect(admin.seen).toHaveLength(3);
  });
});

describe('fetchToolSecret', () => {
  const endpoint = (fetchImpl: typeof fetch) => ({
    adminUrl: 'http://admin:9883///',
    adminToken: ADMIN_TOKEN,
    caller: 'runner' as const,
    fetchImpl,
  });

  it('reads one credential with the caller header and validates the answer', async () => {
    const admin = fakeAdmin(() =>
      Response.json({
        id: GITLAB.id,
        credential: 'glpat-synthetic-secret',
        credentialVersion: 3,
        teamId: 'T0TEAM1',
        kind: 'gitlab',
      }),
    );
    expect(await fetchToolSecret(endpoint(admin.fetchImpl), GITLAB.id)).toEqual({
      credential: 'glpat-synthetic-secret',
      credentialVersion: 3,
      teamId: 'T0TEAM1',
      kind: 'gitlab',
    });
    expect(admin.seen[0]!.url).toBe(
      `http://admin:9883/internal/tool-instances/${GITLAB.id}/secret`,
    );
    expect(admin.seen[0]!.headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(admin.seen[0]!.headers.get('x-support-agent-caller')).toBe('runner');
  });

  it('refuses an invalid instance ID before any request', async () => {
    const admin = fakeAdmin(() => Response.json({}));
    for (const id of ['../status', 'ti_0123', `${GITLAB.id}/../x`, ''])
      await expect(fetchToolSecret(endpoint(admin.fetchImpl), id)).rejects.toThrow(
        /invalid tool instance ID/,
      );
    expect(admin.seen).toHaveLength(0);
  });

  it('names a disabled or credential-less instance on 404 and other failures without detail', async () => {
    const cases: Array<[Response | Error, RegExp]> = [
      [
        new Response('{}', { status: 404 }),
        /tool instance ti_0123456789abcdef has no usable credential/,
      ],
      [
        new Response('{}', { status: 500 }),
        /admin service answered HTTP 500 for ti_0123456789abcdef/,
      ],
      [new TypeError('fetch failed secret-upstream'), /admin service unreachable .*: TypeError$/],
    ];
    for (const [answer, pattern] of cases) {
      const admin = fakeAdmin(() => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const failure = fetchToolSecret(endpoint(admin.fetchImpl), GITLAB.id);
      await expect(failure).rejects.toThrow(pattern);
      await expect(failure).rejects.toBeInstanceOf(ToolInstanceError);
      await expect(failure).rejects.not.toThrow(/secret-upstream/);
    }
  });

  it('refuses a malformed or mismatched credential answer', async () => {
    const good = {
      id: GITLAB.id,
      credential: 'glpat-synthetic-secret',
      credentialVersion: 3,
      teamId: 'T0TEAM1',
      kind: 'gitlab',
    };
    for (const body of [
      { ...good, id: ATLASSIAN.id },
      { ...good, credential: '' },
      { ...good, credential: 42 },
      { ...good, credentialVersion: '3' },
      { ...good, credentialVersion: 1.5 },
      { ...good, teamId: null },
      { ...good, kind: 'shell' },
    ]) {
      const admin = fakeAdmin(() => Response.json(body));
      const failure = fetchToolSecret(endpoint(admin.fetchImpl), GITLAB.id);
      await expect(failure).rejects.toThrow(/returned an invalid credential/);
      await expect(failure).rejects.not.toThrow(/glpat-synthetic-secret/);
    }
  });

  it('is what ToolInstanceSync.secret uses', async () => {
    const admin = fakeAdmin(() =>
      Response.json({
        id: ATLASSIAN.id,
        credential: 'atlassian-secret',
        credentialVersion: 1,
        teamId: ATLASSIAN.teamId,
        kind: 'atlassian',
      }),
    );
    const sync = new ToolInstanceSync({
      adminUrl: ADMIN,
      adminToken: ADMIN_TOKEN,
      caller: 'cli-runtime',
      kinds: ['atlassian'],
      fetchImpl: admin.fetchImpl,
    });
    expect((await sync.secret(ATLASSIAN.id)).credential).toBe('atlassian-secret');
    expect(admin.seen[0]!.headers.get('x-support-agent-caller')).toBe('cli-runtime');
  });
});

describe('tool instance helpers', () => {
  it('sanitizes status details to one bounded line', () => {
    expect(sanitizeStatusDetail('  a\r\n\tb\u0007c  ')).toBe('a b c');
    expect(sanitizeStatusDetail('y'.repeat(500))).toHaveLength(200);
  });

  it('parses host allowlists case-insensitively and ignores blanks', () => {
    expect([...hostAllowlist(' GitLab.Example.com, ,gitlab.two.example ')]).toEqual([
      'gitlab.example.com',
      'gitlab.two.example',
    ]);
    expect(hostAllowlist(undefined).size).toBe(0);
    expect(hostAllowlist('').size).toBe(0);
  });

  it('bounds the probe interval', () => {
    expect(probeIntervalMs({})).toBe(300_000);
    expect(probeIntervalMs({ TOOL_INSTANCE_PROBE_MS: 'soon' })).toBe(300_000);
    expect(probeIntervalMs({ TOOL_INSTANCE_PROBE_MS: '1' })).toBe(10_000);
    expect(probeIntervalMs({ TOOL_INSTANCE_PROBE_MS: '60000' })).toBe(60_000);
    expect(probeIntervalMs({ TOOL_INSTANCE_PROBE_MS: '99999999' })).toBe(3_600_000);
  });
});
