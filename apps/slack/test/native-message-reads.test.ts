import { afterEach, describe, expect, it, vi } from 'vitest';
import { testInstallation } from './helpers/installations.js';
import { SLACK_READ_BYTES, SLACK_READ_MESSAGES } from '../src/generated/slack-messages.js';

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
const mentionTs = '1792940001.100001';
const alertTs = '1792930000.100001';
const replyTs = '1792930001.100001';
type Channel = Record<string, unknown>;
const open: Channel = {
  is_private: false,
  is_member: true,
  is_ext_shared: false,
  is_pending_ext_shared: false,
  is_org_shared: false,
};
const alert = {
  ts: alertTs,
  bot_id: 'BOPS',
  bot_profile: { name: 'Opsgenie' },
  text: '',
  attachments: [{ title: 'P2 checkout errors', text: 'HTTP 500 rate above 5%' }],
};

async function setup(
  options: {
    target?: Channel | (() => Channel);
    targetMembers?: string[];
    thread?: Array<Record<string, unknown>>;
    origin?: Array<Record<string, unknown>>;
    originChannel?: Channel;
    originMembers?: string[];
    replies?: () => Promise<unknown>;
  } = {},
) {
  const reads: string[] = [];
  fixtures.installation = testInstallation(
    { teamId: 'T1', installationId: 'UBOT', botUserId: 'UBOT', botId: 'B1' },
    {
      conversations: {
        members: async ({ channel }: { channel: string }) => ({
          ok: true,
          members:
            channel === 'C1'
              ? (options.originMembers ?? ['U1'])
              : (options.targetMembers ?? ['U1']),
          response_metadata: {},
        }),
        info: async ({ channel }: { channel: string }) => {
          if (channel === 'C1') return { ok: true, channel: options.originChannel ?? open };
          if (channel === 'CMISSING')
            throw Object.assign(new Error('missing'), { data: { error: 'channel_not_found' } });
          const target = options.target ?? open;
          return { ok: true, channel: typeof target === 'function' ? target() : target };
        },
        replies: async ({ channel }: { channel: string }) => {
          if (channel === 'C1')
            return {
              ok: true,
              messages: options.origin ?? [
                { ...alert, ts: rootTs },
                { ts: mentionTs, user: 'U1' },
              ],
              response_metadata: {},
            };
          reads.push(channel);
          if (options.replies) return options.replies();
          return { ok: true, messages: options.thread ?? [alert], response_metadata: {} };
        },
      },
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
  const identity = {
    installationId: 'UBOT',
    teamId: 'T1',
    channelId: 'C1',
    rootTs,
    messageTs: mentionTs,
    userId: 'U1',
    authorBotId: null,
  };
  const post = (path: string, body: object, token = 'synthetic-service') =>
    realFetch(`http://127.0.0.1:${adapter!.port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const linked = (link: object = {}, changes: object = {}) =>
    post('/native-messages/linked', {
      identity: { ...identity, ...changes },
      link: { channelId: 'C2', messageTs: alertTs, threadTs: null, ...link },
    });
  const root = (changes: object = {}) =>
    post('/native-messages/root', { identity: { ...identity, ...changes } });
  return { linked, root, post, identity, reads };
}

describe('linked message reads', () => {
  it('returns an alert built from attachments with its thread, the linked message marked', async () => {
    const { linked } = await setup({
      thread: [alert, { ts: replyTs, user: 'U2', text: 'Looking into it' }],
    });
    const response = await linked();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channelId: 'C2',
      threadTs: alertTs,
      messages: [
        {
          ts: alertTs,
          date: '2026-10-25T12:06:40.100Z',
          userId: null,
          botName: 'Opsgenie',
          linked: true,
          text: 'P2 checkout errors\nHTTP 500 rate above 5%',
        },
        {
          ts: replyTs,
          date: '2026-10-25T12:06:41.100Z',
          userId: 'U2',
          botName: null,
          text: 'Looking into it',
        },
      ],
      omitted: 0,
      truncated: false,
    });
  });

  it('marks a linked reply inside its thread', async () => {
    const { linked } = await setup({ thread: [alert, { ts: replyTs, user: 'U2', text: 'Reply' }] });
    const body = (await (await linked({ messageTs: replyTs, threadTs: alertTs })).json()) as {
      messages: Array<{ ts: string; linked?: true }>;
    };
    expect(body.messages.filter((m) => m.linked).map((m) => m.ts)).toEqual([replyTs]);
  });

  it.each([
    ['a private channel elsewhere', { ...open, is_private: true }, 'channel_unavailable'],
    ['unknown privacy', { ...open, is_private: undefined }, 'channel_unavailable'],
    ['a group direct message', { ...open, is_mpim: true }, 'channel_unavailable'],
    ['a direct message', { ...open, is_im: true }, 'channel_unavailable'],
    ['an externally shared channel', { ...open, is_ext_shared: true }, 'shared_channel'],
    ['a pending share', { ...open, is_pending_ext_shared: true }, 'shared_channel'],
    ['an organization-shared channel', { ...open, is_org_shared: true }, 'shared_channel'],
    ['unknown sharing', { ...open, is_ext_shared: undefined }, 'shared_channel'],
    ['a channel without the bot', { ...open, is_member: false }, 'bot_not_member'],
    ['unknown bot membership', { ...open, is_member: undefined }, 'bot_not_member'],
  ])('refuses %s without reading it', async (_name, target, refused) => {
    const { linked, reads } = await setup({ target });
    expect(await (await linked()).json()).toEqual({ refused });
    expect(reads).toEqual([]);
  });

  it('reports only channel_unavailable for a private channel, whatever else applies', async () => {
    const { linked } = await setup({
      target: { ...open, is_private: true, is_member: false, is_ext_shared: true },
      targetMembers: [],
    });
    expect(await (await linked()).json()).toEqual({ refused: 'channel_unavailable' });
  });

  it('refuses a requester who is not in the linked channel, and an invisible channel', async () => {
    const { linked, reads } = await setup({ targetMembers: ['U2'] });
    expect(await (await linked()).json()).toEqual({ refused: 'requester_not_member' });
    expect(await (await linked({ channelId: 'CMISSING' })).json()).toEqual({
      refused: 'channel_unavailable',
    });
    expect(reads).toEqual([]);
  });

  it('reads a private channel for a request from that same channel', async () => {
    const { linked } = await setup({ originChannel: { ...open, is_private: true } });
    const body = await (await linked({ channelId: 'C1', messageTs: rootTs })).json();
    expect(body).toMatchObject({ channelId: 'C1', messages: [{ ts: rootTs, linked: true }, {}] });
  });

  it('discards a read when access is withdrawn while it runs', async () => {
    let calls = 0;
    const { linked, reads } = await setup({
      target: () => ({ ...open, is_private: ++calls > 1 }),
    });
    expect(await (await linked()).json()).toEqual({ refused: 'channel_unavailable' });
    expect(reads).toEqual(['C2']);
  });

  it('reports a missing message for deleted, mismatched and unknown links', async () => {
    const gone = await setup({ thread: [{ ...alert, subtype: 'tombstone' }] });
    expect(await (await gone.linked()).json()).toEqual({ refused: 'message_not_found' });
    expect(await (await gone.linked({ messageTs: replyTs, threadTs: alertTs })).json()).toEqual({
      refused: 'message_not_found',
    });
    await adapter!.close();
    const unknown = await setup({
      replies: async () => {
        throw Object.assign(new Error('An API error occurred: thread_not_found'), {
          data: { error: 'thread_not_found' },
        });
      },
    });
    expect(await (await unknown.linked()).json()).toEqual({ refused: 'message_not_found' });
  });

  it('keeps the linked message within the bounds of a long thread', async () => {
    const thread = Array.from({ length: 90 }, (_, i) => ({
      ts: `1792930000.${String(100001 + i)}`,
      user: 'U2',
      text: `${i} ${'é'.repeat(6000)}`,
    }));
    const { linked } = await setup({ thread });
    const last = thread.at(-1)!.ts;
    const body = (await (await linked({ messageTs: last, threadTs: alertTs })).json()) as {
      messages: Array<{ ts: string; linked?: true }>;
      omitted: number;
      truncated: boolean;
    };
    expect(body.messages.map((m) => m.ts)).toContain(last);
    expect(body.messages[0]!.ts).toBe(alertTs);
    expect(body.messages.length).toBeLessThanOrEqual(SLACK_READ_MESSAGES);
    expect(body.omitted).toBe(90 - body.messages.length);
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body.messages))).toBeLessThan(SLACK_READ_BYTES + 100);
  });

  it('fails closed for an unauthenticated call, a lost origin and a malformed link', async () => {
    const { linked, post, identity, reads } = await setup();
    const link = { channelId: 'C2', messageTs: alertTs, threadTs: null };
    expect((await post('/native-messages/linked', { identity, link }, 'wrong')).status).toBe(401);
    // Another author, an absent mention, a missing source and a bad link.
    expect((await linked({}, { userId: 'U2' })).status).toBe(503);
    expect((await linked({}, { messageTs: '1792940009.100001' })).status).toBe(503);
    expect((await linked({}, { messageTs: undefined })).status).toBe(503);
    expect((await linked({ channelId: 'D2' })).status).toBe(503);
    expect((await linked({ messageTs: '1' })).status).toBe(503);
    expect((await post('/native-messages/linked', { identity })).status).toBe(503);
    expect(reads).toEqual([]);
  });

  it('refuses a requester who left the origin channel', async () => {
    const { linked, root, reads } = await setup({ originMembers: [] });
    expect((await linked()).status).toBe(503);
    expect((await root()).status).toBe(503);
    expect(reads).toEqual([]);
  });
});

describe('thread root reads', () => {
  it('returns the first message of the origin thread', async () => {
    const { root } = await setup();
    expect(await (await root()).json()).toEqual({
      message: {
        ts: rootTs,
        date: '2026-10-25T14:53:20.100Z',
        userId: null,
        botName: 'Opsgenie',
        text: 'P2 checkout errors\nHTTP 500 rate above 5%',
      },
    });
  });

  it('returns nothing for a root without text', async () => {
    const { root } = await setup({
      origin: [
        { ts: rootTs, user: 'U2' },
        { ts: mentionTs, user: 'U1' },
      ],
    });
    expect(await (await root()).json()).toEqual({ message: null });
  });

  it('refuses a deleted root and an externally shared origin', async () => {
    const deleted = await setup({
      origin: [
        { ts: rootTs, user: 'USLACKBOT', subtype: 'tombstone' },
        { ts: mentionTs, user: 'U1' },
      ],
    });
    expect((await deleted.root()).status).toBe(503);
    await adapter!.close();
    const shared = await setup({ originChannel: { ...open, is_ext_shared: true } });
    expect((await shared.root()).status).toBe(503);
  });
});
