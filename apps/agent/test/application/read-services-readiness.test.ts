import { testSelection } from '../model-fixture.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { compileDocument } from '../../../admin/src/compile.js';
import { deriveCoordinatorConfig } from '../../src/application/configuration/config.js';
import { nativeReadServices } from '../../src/application/bindings/read-services.js';
import { GITLAB_CONTRACT_VERSION } from '../../src/integrations/gitlab/gitlab-operations.js';

const TEAM = 'T0TEAM1';
const GITLAB_ID = 'ti_0000000000000001';
const SLACK_ID = 'ti_0000000000000002';
const HOST = 'gitlab.example.test';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function cliRuntime(readyz: (res: http.ServerResponse) => void) {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    readyz(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
  };
}

const report = (body: { instances: unknown[] }) => (res: http.ServerResponse) =>
  res
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ service: 'cli-runtime', configVersion: 1, syncError: null, ...body }));

const gitlabReady = () => ({
  instanceId: GITLAB_ID,
  teamId: TEAM,
  kind: 'gitlab',
  label: 'GitLab (test)',
  credentialVersion: 1,
  state: 'ready',
  detail: 'authenticated against the instance host',
  gitlab: {
    ready: true,
    status: 'ready',
    detail: 'authenticated against the instance host',
    host: HOST,
    contractVersion: GITLAB_CONTRACT_VERSION,
  },
});

const instance = (id: string, kind: 'gitlab' | 'slack') => ({
  id,
  teamId: TEAM,
  kind,
  label: `${kind} (test)`,
  host: kind === 'gitlab' ? HOST : null,
  settings: {},
  credentialVersion: 1,
  hasCredential: true,
  status: 'enabled',
});

function config(kinds: Array<'gitlab' | 'slack'>) {
  const ids = { gitlab: GITLAB_ID, slack: SLACK_ID };
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
    toolInstances: kinds.map((kind) => instance(ids[kind], kind)),
    toolStatuses: kinds.map((kind) => ({
      instanceId: ids[kind],
      state: 'ready',
      detail: '',
      toolsCount: null,
      credentialVersion: 1,
      reporter: 'cli-runtime',
      reportedAt: Date.now(),
    })),
    channelTools: kinds.map((kind) => ({
      teamId: TEAM,
      channelId: 'CCHAN',
      kind,
      instanceId: ids[kind],
    })),
  } as never);
  return deriveCoordinatorConfig(document as never, {
    modelPolicy: { defaultKey: 'test', models: [testSelection('test', 'synthetic')] },
    admission: { global: 1, perThread: 1 },
    execution: { maxInferenceInvocations: 1 },
  });
}

async function bind(kinds: Array<'gitlab' | 'slack'>, url: string) {
  const cfg = config(kinds);
  return nativeReadServices({
    configuration: async () => cfg,
    cli: { url, token: 'synthetic-cli' },
  })({ teamId: TEAM, channelId: 'CCHAN' } as never, new AbortController().signal);
}

describe('native read binding under tool runtime readiness', () => {
  it('binds a channel without tools without asking the tool runtime', async () => {
    const runtime = await cliRuntime((res) => res.writeHead(503).end());
    const binding = await bind([], runtime.url);
    expect(binding.enabled).toEqual(new Set());
    expect(binding.catalog.gitlab).toBe(false);
    expect(runtime.calls()).toBe(0);
  });

  it('still refuses a channel with a runtime tool while the tool runtime is unavailable', async () => {
    const runtime = await cliRuntime((res) => res.writeHead(503).end());
    await expect(bind(['gitlab', 'slack'], runtime.url)).rejects.toThrow(/503/);
  }, 20_000);

  it('still refuses a channel whose tool the runtime has not qualified', async () => {
    const runtime = await cliRuntime(report({ instances: [gitlabReady()] }));
    await expect(bind(['gitlab', 'slack'], runtime.url)).rejects.toThrow(/does not serve/);
  });
});
