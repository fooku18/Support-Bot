import { afterEach, describe, expect, it, vi } from 'vitest';
import { testInstallation } from './helpers/installations.js';
import { buildTaskKey } from '../src/taskkey.js';
import { createRunStatuses } from '../src/run-status.js';

const fixtures = vi.hoisted(() => ({ installation: undefined as unknown }));
vi.mock('../src/receiver.js', async (original) => ({
  ...(await original<typeof import('../src/receiver.js')>()),
  createSocketModeReceiver: () => ({ start: async () => {}, stop: async () => {} }),
}));
vi.mock('../src/installations.js', () => ({
  InstallationRegistry: class {
    synced = true;
    get() {
      return fixtures.installation;
    }
    async syncOnce() {}
    async settled() {}
    start() {}
    stop() {}
  },
}));
import { startNativeAdapter } from '../src/native-application.js';

const realFetch = globalThis.fetch;
let adapter: Awaited<ReturnType<typeof startNativeAdapter>> | undefined;
afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
  vi.unstubAllGlobals();
});

const rootTs = '1792940000.100001';

function slackChat(failPost = false) {
  return {
    postMessage: vi.fn(async (_args: Record<string, unknown>) => {
      if (failPost) throw new Error('ratelimited');
      return { ok: true, ts: '1792940000.300001' };
    }),
    update: vi.fn(async (_args: Record<string, unknown>) => ({ ok: true })),
    delete: vi.fn(async (_args: Record<string, unknown>) => ({ ok: true })),
  };
}

async function setup(chat = slackChat()) {
  fixtures.installation = testInstallation(
    { teamId: 'T1', installationId: 'UBOT', botUserId: 'UBOT', botId: 'B1' },
    {
      conversations: {
        members: async () => ({ ok: true, members: ['U1'], response_metadata: {} }),
        info: async () => ({
          ok: true,
          channel: { is_ext_shared: false, is_pending_ext_shared: false, is_org_shared: false },
        }),
        replies: async () => ({
          ok: true,
          messages: [{ ts: rootTs, user: 'U1' }],
          response_metadata: {},
        }),
      },
      chat,
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true })),
  );
  adapter = await startNativeAdapter({
    SERVICE_TOKEN: 'synthetic-service',
    NATIVE_APPLICATION_URL: 'http://application',
    ADMIN_URL: 'http://admin',
    ADMIN_INTERNAL_TOKEN: 'synthetic-admin',
    SLACK_APP_TOKEN: 'synthetic-app',
    NATIVE_ADAPTER_PORT: '0',
    NATIVE_BIND_HOST: '127.0.0.1',
  });
  const identity = { installationId: 'UBOT', teamId: 'T1', channelId: 'C1', rootTs };
  const status = (text: string, changes: Record<string, unknown> = {}) =>
    realFetch(`http://127.0.0.1:${adapter!.port}/native-status`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-service', 'content-type': 'application/json' },
      body: JSON.stringify({
        taskKey: buildTaskKey(identity),
        channel: 'C1',
        rootTs,
        requesterUserId: 'U1',
        runId: 'run-1',
        text,
        ...changes,
      }),
    });
  return { chat, status };
}

describe('run status in the Slack adapter', () => {
  it('posts one status message in the thread and edits it for later lines', async () => {
    const { chat, status } = await setup();
    expect((await status('Thinking…')).status).toBe(200);
    expect((await status('Checking Datadog…')).status).toBe(200);
    expect(chat.postMessage).toHaveBeenCalledTimes(1);
    expect(chat.postMessage.mock.calls[0]![0]).toMatchObject({
      channel: 'C1',
      thread_ts: rootTs,
      text: 'Thinking…',
    });
    expect(chat.update).toHaveBeenCalledTimes(1);
    expect(chat.update.mock.calls[0]![0]).toMatchObject({
      channel: 'C1',
      ts: '1792940000.300001',
      text: 'Checking Datadog…',
    });
  });

  it('refuses a status for another thread or an overlong line', async () => {
    const { chat, status } = await setup();
    expect((await status('x', { rootTs: '1792940000.999999' })).status).toBe(503);
    expect((await status('x'.repeat(121))).status).toBe(503);
    expect(chat.postMessage).not.toHaveBeenCalled();
  });

  it('carries on when Slack refuses the status post', async () => {
    const { chat, status } = await setup(slackChat(true));
    expect((await status('Thinking…')).status).toBe(200);
    expect(chat.update).not.toHaveBeenCalled();
  });
});

describe('run statuses', () => {
  it('deletes the shown message on clear and posts afresh for the next segment', async () => {
    const chat = slackChat();
    const slack = { webClient: { chat } } as never;
    const statuses = createRunStatuses();
    await statuses.show('run-1', slack, 'C1', rootTs, 'Thinking…');
    await statuses.clear('run-1');
    expect(chat.delete).toHaveBeenCalledWith({ channel: 'C1', ts: '1792940000.300001' });
    expect(statuses.has('run-1')).toBe(false);
    await statuses.clear('run-1');
    expect(chat.delete).toHaveBeenCalledTimes(1);
    await statuses.show('run-1', slack, 'C1', rootTs, 'Thinking…');
    expect(chat.postMessage).toHaveBeenCalledTimes(2);
  });
});
