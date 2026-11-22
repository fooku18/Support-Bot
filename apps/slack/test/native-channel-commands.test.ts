import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReceiverDeps } from '../src/receiver.js';
import { handleEnvelope } from '../src/receiver.js';
import { testInstallation } from './helpers/installations.js';
import { CONFIGURE_ACTION, CONFIGURE_CALLBACK } from '../src/channel-commands.js';
import { classifyChannelCommand } from '../src/generated/channel-commands.js';
import type { MentionEvent } from '../src/intake.js';

const receiver = vi.hoisted(() => ({ deps: undefined as ReceiverDeps | undefined }));
const fixtures = vi.hoisted(() => ({ installation: undefined as unknown }));
vi.mock('../src/receiver.js', async (original) => ({
  ...(await original<typeof import('../src/receiver.js')>()),
  createSocketModeReceiver: (deps: ReceiverDeps) => {
    receiver.deps = deps;
    return { start: async () => {}, stop: async () => {} };
  },
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

async function setup() {
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const open = vi.fn().mockResolvedValue({ ok: true });
  const installation = testInstallation(
    { teamId: 'T1', installationId: 'UBOT', botUserId: 'UBOT', botId: 'B1' },
    { chat: { postEphemeral }, views: { open }, reactions: { add: vi.fn(), remove: vi.fn() } },
  );
  fixtures.installation = installation;
  const calls: Array<{ path: string; body: unknown }> = [];
  const responses = new Map<string, () => Response | Promise<Response>>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = responses.get(path);
      if (respond) return respond();
      return Response.json(
        path.endsWith('/execute')
          ? classifyChannelCommand(JSON.parse(String(init?.body)).text, 'UBOT')?.kind ===
            'configure'
            ? { kind: 'configure', grant: 'grant' }
            : { kind: 'receipt' }
          : path.endsWith('/open')
            ? { session: 'session', model: null, prompt: null, autoReplies: true, keys: ['sonnet'] }
            : path.endsWith('/claim-receipt')
              ? null
              : { runId: 'synthetic-run', owner: 'U1' },
      );
    }),
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
  const ack = vi.fn();
  const send = (text: string, changes: Partial<MentionEvent> = {}) =>
    handleEnvelope(
      {
        type: 'events_api',
        ack,
        body: {
          type: 'event_callback',
          team_id: 'T1',
          event_id: 'Ev1',
          event: {
            type: 'app_mention',
            user: 'U1',
            channel: 'C1',
            ts: '1792940000.123456',
            text,
            ...changes,
          },
        },
      },
      receiver.deps!,
    );
  const interact = (body: unknown, interactionAck = vi.fn()) =>
    handleEnvelope({ type: 'interactive', body, ack: interactionAck }, receiver.deps!);
  return { send, calls, postEphemeral, ack, interact, open, responses, installation };
}

describe('native startup command routing at the Socket Mode call site', () => {
  it('routes !config to the retained admin grant and private button without agent admission', async () => {
    const { send, calls, postEphemeral, ack } = await setup();
    await send('<@UBOT> !config');
    expect(calls.filter((c) => c.path.endsWith('/execute'))).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith('/agents/'))).toEqual([]);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        user: 'U1',
        blocks: expect.any(Array),
      }),
    );
    expect(ack).toHaveBeenCalledOnce();
  });

  it.each([
    '<@UBOT>!CONFIG',
    '<@UBOT> !config please',
    '<@UBOT> !unknown',
    '<@UBOT> !',
    '<@UBOT> !memory delete all',
    '<@UBOT> !help',
  ])('reserves %j before native agent admission', async (text) => {
    const { send, calls } = await setup();
    await send(text);
    expect(calls.filter((c) => c.path.endsWith('/execute'))).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith('/agents/'))).toEqual([]);
  });

  it('retains command-service failure for Slack redelivery without inference or acknowledgement', async () => {
    const { send, calls, ack, responses } = await setup();
    responses.set('/internal/channel-commands/execute', () =>
      Response.json({ error: 'unavailable' }, { status: 503 }),
    );
    await expect(send('<@UBOT> !config')).rejects.toThrow('unavailable');
    expect(ack).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path.startsWith('/agents/'))).toEqual([]);
  });

  it('keeps an admin policy denial private without admitting a run', async () => {
    const { send, calls, ack, responses, postEphemeral } = await setup();
    responses.set('/internal/channel-commands/execute', () =>
      Response.json({ error: 'Access revoked' }, { status: 403 }),
    );
    await send('<@UBOT> !config');
    expect(ack).toHaveBeenCalledOnce();
    expect(postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ text: 'Access revoked' }));
    expect(calls.filter((c) => c.path.startsWith('/agents/'))).toEqual([]);
  });

  it('wires Configure open and save before acknowledgement, leaving unrelated interactions acknowledged', async () => {
    const { interact, calls, open, responses } = await setup();
    await interact({
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      channel: { id: 'C1' },
      container: { is_ephemeral: true, channel_id: 'C1' },
      trigger_id: 'trigger',
      actions: [{ action_id: CONFIGURE_ACTION, value: 'grant' }],
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_id: 'trigger',
        view: expect.objectContaining({ private_metadata: 'session' }),
      }),
    );
    const ack = vi.fn();
    responses.set('/internal/channel-commands/save', () => {
      expect(ack).not.toHaveBeenCalled();
      return Response.json({ changed: false });
    });
    await interact(
      {
        type: 'view_submission',
        team: { id: 'T1' },
        user: { id: 'U1' },
        view: {
          callback_id: CONFIGURE_CALLBACK,
          private_metadata: 'session',
          state: {
            values: {
              model: { value: { selected_option: { value: 'inherit' } } },
              replies: { value: { selected_options: [{ value: 'on' }] } },
            },
          },
        },
      },
      ack,
    );
    expect(ack).toHaveBeenCalledWith();
    expect(calls.find((c) => c.path.endsWith('/save'))?.body).toMatchObject({
      session: 'session',
      model: null,
      part1: '',
      part2: '',
      autoReplies: true,
    });
    const unrelated = vi.fn();
    await interact(
      { team: { id: 'T1' }, type: 'block_actions', actions: [{ action_id: 'unrelated' }] },
      unrelated,
    );
    expect(unrelated).toHaveBeenCalledOnce();
    expect(calls.filter((c) => c.path.startsWith('/agents/'))).toEqual([]);
  });

  it('checks current Slack membership before a command and before opening the editor', async () => {
    const { send, interact, installation, calls, open } = await setup();
    installation.slack.webClient.conversations.members = vi
      .fn()
      .mockResolvedValue({ ok: true, members: [] });
    await send('<@UBOT> !config');
    await interact({
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      channel: { id: 'C1' },
      container: { is_ephemeral: true, channel_id: 'C1' },
      trigger_id: 'trigger',
      actions: [{ action_id: CONFIGURE_ACTION, value: 'grant' }],
    });
    expect(calls.filter((c) => /\/execute$|\/open$|\/agents\//.test(c.path))).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    '<@UBOT> ordinary question',
    '<@UBOT> explain !config',
    '> <@UBOT> !config',
    '<@OTHER> !config',
  ])('preserves ordinary mention handling for %j', async (text) => {
    const { send, calls } = await setup();
    await send(text);
    expect(calls.filter((c) => c.path.endsWith('/execute'))).toEqual([]);
    expect(calls.filter((c) => c.path === '/agents/start')).toHaveLength(1);
  });

  it('preserves normal follow-ups but keeps unmentioned reserved commands out of inference', async () => {
    const { send, calls } = await setup();
    for (const text of ['!config', ' !unknown', '<@UBOT> !config'])
      await send(text, { type: 'message', thread_ts: '1792940000.000001' });
    expect(calls.filter((c) => c.path.startsWith('/agents/'))).toEqual([]);
    await send('Please explain more', { type: 'message', thread_ts: '1792940000.000001' });
    expect(calls.filter((c) => c.path === '/agents/followup')).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith('/execute'))).toEqual([]);
  });

  it('silently acknowledges automatic replies disabled by current service config while mentions and controls keep their routes', async () => {
    const { send, calls, responses, postEphemeral, ack } = await setup();
    responses.set('/agents/followup', () =>
      Response.json({ error: 'automatic_replies_disabled' }, { status: 409 }),
    );
    await send('Ordinary follow-up', { type: 'message', thread_ts: '1792940000.000001' });
    expect(ack).toHaveBeenCalledOnce();
    expect(postEphemeral).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path === '/agents/present')).toEqual([]);
    await send('<@UBOT> Explicit request');
    expect(calls.filter((c) => c.path === '/agents/start')).toHaveLength(1);
    await send('cancel', { type: 'message', thread_ts: '1792940000.000001' });
    expect(calls.filter((c) => c.path === '/agents/cancel')).toHaveLength(1);
    await send('status', { type: 'message', thread_ts: '1792940000.000001' });
    expect(calls.filter((c) => c.path === '/agents/thread').length).toBeGreaterThanOrEqual(3);
    await send('<@UBOT> !config');
    expect(calls.filter((c) => c.path.endsWith('/execute'))).toHaveLength(1);
  });

  it('starts and drains the retained durable receipt worker with adapter lifecycle', async () => {
    const { calls } = await setup();
    expect(calls.some((c) => c.path.endsWith('/claim-receipt'))).toBe(true);
    await adapter!.close();
    const count = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(calls).toHaveLength(count);
  });
});

// Ported from the retained thread-root-deletion-coding live scenario: the live
// driver may not delete Slack messages, so the deleted-root branch is proven here.
describe('native source authority', () => {
  it('refuses a thread whose root is gone and admits it while the root and source exist', async () => {
    const { installation } = await setup();
    const rootTs = '1792940000.100001',
      sourceTs = '1792940000.100002';
    let messages: Array<Record<string, unknown>> = [
      { ts: rootTs, user: 'U1' },
      { ts: sourceTs, user: 'U1' },
    ];
    Object.assign(installation.slack.webClient.conversations, {
      info: async () => ({
        ok: true,
        channel: { is_ext_shared: false, is_pending_ext_shared: false, is_org_shared: false },
      }),
      replies: async () => ({ ok: true, messages, response_metadata: {} }),
    });
    const check = (body: Record<string, unknown>) =>
      realFetch(`http://127.0.0.1:${adapter!.port}/native-authority/check`, {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-service', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const identity = {
      installationId: 'UBOT',
      teamId: 'T1',
      channelId: 'C1',
      rootTs,
      userId: 'U1',
      messageTs: sourceTs,
      authorBotId: null,
    };
    expect((await check(identity)).status).toBe(200);
    // Slack keeps replies but drops a deleted root from conversations.replies.
    messages = [{ ts: sourceTs, user: 'U1' }];
    expect((await check(identity)).ok).toBe(false);
    // A source message by someone else is refused as well.
    messages = [
      { ts: rootTs, user: 'U1' },
      { ts: sourceTs, user: 'U2' },
    ];
    expect((await check(identity)).ok).toBe(false);
  });
});
