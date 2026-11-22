import { testSelection } from '../../apps/agent/test/model-fixture.js';
import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { nativeCoding } from '../../apps/agent/src/application/bindings/coding.js';
import { deriveCoordinatorConfig } from '../../apps/agent/src/application/configuration/config.js';
import { compileDocument } from '../../apps/admin/src/compile.js';
import { GITLAB_CONTRACT_VERSION } from '../../apps/agent/src/integrations/gitlab/gitlab-operations.js';

const id = 'ti_1150000000000001';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});
async function fixture() {
  const state = {
    assigned: true,
    version: 1,
    runtimeVersion: 1,
    secretVersion: 1,
    secretTeam: 'TTEST',
    syncError: null as string | null,
    revoked: false,
    truncated: false,
    requests: [] as Record<string, unknown>[],
    secretReads: 0,
  };
  const configuration = async () =>
    deriveCoordinatorConfig(
      compileDocument(state.version, {
        installations: [
          {
            teamId: 'TTEST',
            teamName: 'Test',
            botUserId: 'UBOT',
            botId: 'BBOT',
            status: 'whitelisted',
            trustedBotSender: null,
          },
        ],
        channels: [{ teamId: 'TTEST', channelId: 'CTEST', enabled: true }],
        blockedMembers: [],
        toolInstances: [
          {
            id,
            teamId: 'TTEST',
            kind: 'gitlab',
            label: 'Test',
            status: 'enabled',
            credentialVersion: state.version,
            host: 'gitlab.example.test',
            settings: {},
            hasCredential: true,
          },
        ],
        toolStatuses: [
          {
            instanceId: id,
            state: 'ready',
            detail: 'synthetic',
            credentialVersion: state.version,
            reporter: 'cli-runtime',
            toolsCount: 24,
            reportedAt: 1,
          },
        ],
        channelTools: state.assigned
          ? [{ teamId: 'TTEST', channelId: 'CTEST', kind: 'gitlab', instanceId: id }]
          : [],
      }),
      {
        modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
        admission: { global: 8, perThread: 1 },
        execution: { maxInferenceInvocations: 1 },
      },
    );
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (req.url === '/readyz') {
      expect(req.headers.authorization).toBe('Bearer transport');
      send({
        syncError: state.syncError,
        instances: [
          {
            instanceId: id,
            kind: 'gitlab',
            teamId: 'TTEST',
            credentialVersion: state.runtimeVersion,
            state: 'ready',
            detail: 'synthetic',
            gitlab: {
              ready: true,
              host: 'gitlab.example.test',
              contractVersion: GITLAB_CONTRACT_VERSION,
              version: 'synthetic',
            },
          },
        ],
      });
    } else if (req.url === `/internal/tool-instances/${id}/secret`) {
      expect(req.headers.authorization).toBe('Bearer admin');
      expect(req.headers['x-support-agent-caller']).toBe('runner');
      state.secretReads++;
      send({
        id,
        kind: 'gitlab',
        teamId: state.secretTeam,
        credentialVersion: state.secretVersion,
        credential: 'synthetic-private-credential',
      });
    } else if (req.url === '/gitlab') {
      expect(req.headers.authorization).toBe('Bearer transport');
      let body = '';
      for await (const chunk of req) body += chunk;
      state.requests.push(JSON.parse(body));
      send({
        status: 'completed',
        exitCode: 0,
        output: JSON.stringify({
          id: 115,
          path_with_namespace: 'fixture/project',
          default_branch: 'main',
        }),
        truncated: state.truncated,
      });
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closes.push(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  const url = `http://127.0.0.1:${address.port}`;
  const binding = nativeCoding({
    configuration,
    storageDir: '/retained/native-coding',
    adminUrl: url,
    adminToken: 'admin',
    url,
    token: 'transport',
  });
  const controller = new AbortController();
  const prepare = () =>
    binding.prepare({
      identity: {
        installationId: 'UBOT',
        teamId: 'TTEST',
        channelId: 'CTEST',
        rootTs: '1000000000.000001',
        messageTs: '1000000000.000001',
        userId: 'UOWNER',
        canonicalText: 'code',
        eventId: 'synthetic-event',
        text: 'code',
        authorBotId: null,
      },
      taskKey: 'test',
      workspaceId: 'a'.repeat(64),
      runId: 'test',
      signal: controller.signal,
      authorize: async () => {
        if (state.revoked) throw new Error('revoked');
      },
    });
  return { state, prepare, controller };
}

it('binds the assigned credential and sends typed calls without transporting that credential', async () => {
  const f = await fixture();
  const coding = (await f.prepare())!;
  expect(coding.gitlabToken).toBe('synthetic-private-credential');
  expect(coding.redact('synthetic-private-credential')).toBe('[redacted]');
  const result = await coding.gitlab({ kind: 'get_project', project: 'fixture/project' });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ id: 115 });
  expect(f.state.requests).toHaveLength(1);
  expect(f.state.requests[0]).toMatchObject({
    instanceId: id,
    teamId: 'TTEST',
    credentialVersion: 1,
    operation: 'get_project',
  });
  expect(JSON.stringify(f.state.requests)).not.toContain('synthetic-private-credential');
});

it.each(['assignment', 'runtime', 'secret', 'workspace', 'outage'])(
  'refuses a mismatched %s before GitLab dispatch',
  async (kind) => {
    const f = await fixture();
    if (kind === 'assignment') f.state.assigned = false;
    if (kind === 'runtime') f.state.runtimeVersion = 2;
    if (kind === 'secret') f.state.secretVersion = 2;
    if (kind === 'workspace') f.state.secretTeam = 'TOTHER';
    if (kind === 'outage') f.state.syncError = 'unavailable';
    await expect(f.prepare()).resolves.toBeUndefined();
    expect(f.state.requests).toHaveLength(0);
    if (['assignment', 'runtime', 'outage'].includes(kind)) expect(f.state.secretReads).toBe(0);
  },
);

it.each(['revocation', 'rotation', 'abort'])(
  'refuses %s of an already prepared binding',
  async (kind) => {
    const f = await fixture();
    const coding = (await f.prepare())!;
    if (kind === 'revocation') f.state.revoked = true;
    if (kind === 'rotation') f.state.version++;
    if (kind === 'abort') f.controller.abort();
    await expect(
      coding.gitlab({ kind: 'get_project', project: 'fixture/project' }),
    ).rejects.toThrow();
    expect(f.state.requests).toHaveLength(0);
  },
);

it('refuses incomplete publication authority from the tool runtime', async () => {
  const f = await fixture();
  const coding = (await f.prepare())!;
  f.state.truncated = true;
  await expect(coding.gitlab({ kind: 'get_project', project: 'fixture/project' })).rejects.toThrow(
    'incomplete',
  );
});
