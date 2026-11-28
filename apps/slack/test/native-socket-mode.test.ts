import { afterEach, describe, expect, it, vi } from 'vitest';

const receivers = vi.hoisted(() => ({ created: 0 }));
vi.mock('../src/receiver.js', async (original) => ({
  ...(await original<typeof import('../src/receiver.js')>()),
  createSocketModeReceiver: () => {
    receivers.created++;
    return { start: async () => {}, stop: async () => {} };
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

async function readiness(env: NodeJS.ProcessEnv) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true })),
  );
  adapter = await startNativeAdapter(env);
  const response = await realFetch(`http://127.0.0.1:${adapter.port}/readyz`, {
    headers: { authorization: `Bearer ${base.SERVICE_TOKEN}` },
  });
  return response.status;
}

describe('Slack Socket Mode switch', () => {
  it('serves without a Socket Mode receiver when Socket Mode is off', async () => {
    expect(await readiness({ ...base, SLACK_SOCKET_MODE: 'off' })).toBe(200);
    expect(receivers.created).toBe(0);
  });

  it('opens Socket Mode by default and is not ready before it connects', async () => {
    expect(await readiness({ ...base, SLACK_APP_TOKEN: 'synthetic-app' })).toBe(503);
    expect(receivers.created).toBe(1);
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
