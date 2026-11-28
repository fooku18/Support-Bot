import { afterEach, describe, expect, it, vi } from 'vitest';

const receivers = vi.hoisted(() => ({
  created: 0,
  started: 0,
  connect: undefined as undefined | (() => void),
}));
vi.mock('../src/receiver.js', async (original) => ({
  ...(await original<typeof import('../src/receiver.js')>()),
  createSocketModeReceiver: (deps: { connection: { transitioned: (state: string) => void } }) => {
    receivers.created++;
    receivers.connect = () => deps.connection.transitioned('connected');
    return {
      start: async () => {
        receivers.started++;
      },
      stop: async () => {},
    };
  },
}));
vi.mock('../src/installations.js', () => ({
  InstallationRegistry: class {
    synced = true;
    size = 0;
    get() {
      return undefined;
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
  receivers.created = 0;
  receivers.started = 0;
  receivers.connect = undefined;
  vi.unstubAllGlobals();
});

const base = {
  SERVICE_TOKEN: 'synthetic-service',
  NATIVE_APPLICATION_URL: 'http://application',
  ADMIN_URL: 'http://admin',
  ADMIN_INTERNAL_TOKEN: 'synthetic-admin',
  NATIVE_ADAPTER_PORT: '0',
  NATIVE_BIND_HOST: '127.0.0.1',
};

async function readiness() {
  const response = await realFetch(`http://127.0.0.1:${adapter!.port}/readyz`, {
    headers: { authorization: `Bearer ${base.SERVICE_TOKEN}` },
  });
  return response.status;
}

async function start(env: NodeJS.ProcessEnv) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true })),
  );
  adapter = await startNativeAdapter(env);
}

describe('Slack Socket Mode switch', () => {
  it('serves without a Socket Mode receiver when Socket Mode is off', async () => {
    await start({ ...base, SLACK_SOCKET_MODE: 'off' });
    expect(await readiness()).toBe(200);
    expect(receivers.created).toBe(0);
  });

  it('opens Socket Mode by default and is ready once it connects', async () => {
    await start({ ...base, SLACK_APP_TOKEN: 'synthetic-app' });
    expect(receivers).toMatchObject({ created: 1, started: 1 });
    expect(await readiness()).toBe(503);
    receivers.connect!();
    expect(await readiness()).toBe(200);
  });

  it('refuses an app token with Socket Mode off, unknown modes and a missing token', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    for (const env of [
      { ...base, SLACK_SOCKET_MODE: 'off', SLACK_APP_TOKEN: 'synthetic-app' },
      { ...base, SLACK_SOCKET_MODE: 'disabled' },
      { ...base, SLACK_SOCKET_MODE: 'on' },
      base,
    ])
      await expect(startNativeAdapter(env)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(receivers.created).toBe(0);
  });
});
