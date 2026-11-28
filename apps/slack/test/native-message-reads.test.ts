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
    originPages?: Array<Array<Record<string, unknown>>>;
    originChannel?: Channel;
    originMembers?: string[];
    replies?: () => Promise<unknown>;
  } = {},
) {
  const reads: string[] = [];
  const originReads: object[] = [];
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
        replies: async (args: { channel: string }) => {
          const { channel } = args;
          if (channel === 'C1') {
            originReads.push(args);
            if (options.originPages) {
              const page = Number((args as { cursor?: string }).cursor ?? 0);
              const next = page + 1 < options.originPages.length ? String(page + 1) : '';
              return {
                ok: true,
                messages: options.originPages[page],
                response_metadata: { next_cursor: next },
              };
            }
            return {
              ok: true,
              messages: options.origin ?? [
                { ...alert, ts: rootTs },
                { ts: mentionTs, user: 'U1' },
              ],
              response_metadata: {},
            };
          }
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
  const thread = (after: string | null = null, changes: object = {}) =>
    post('/native-messages/thread', { identity: { ...identity, ...changes }, after });
  return { linked, thread, post, identity, reads, originReads };
}

describe('linked message reads', () => {
  it('includes a root screenshot from another author in the initial origin context', async () => {
    const { thread } = await setup({
      origin: [
        {
          ts: rootTs,
          user: 'U2',
          files: [
            {
              id: 'F123',
              user: 'U2',
              name: 'bug.png',
              mimetype: 'image/png',
              size: 100,
              mode: 'hosted',
              is_external: false,
            },
          ],
        },
        { ts: mentionTs, user: 'U1' },
      ],
    });
    expect(await (await thread()).json()).toMatchObject({
      rootImages: { userId: 'U2', files: [{ id: 'F123', sourceTs: rootTs }] },
    });
  });
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
    const { linked, thread, reads } = await setup({ originMembers: [] });
    expect((await linked()).status).toBe(503);
    expect((await thread()).status).toBe(503);
    expect(reads).toEqual([]);
  });
});

type Ctx = { messages: Array<{ ts: string; text: string }>; omitted: number };

describe('thread context reads', () => {
  const ownAnswer = {
    ts: '1792940000.300001',
    bot_id: 'B1',
    text: 'preview',
    blocks: [
      { type: 'markdown', text: 'Restarting fixed it last time.' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Done · Model: claude' }] },
    ],
  };
  const conversation = [
    { ...alert, ts: rootTs },
    { ts: '1792940000.200001', user: 'U2', text: 'tried a restart, still failing' },
    ownAnswer,
    { ts: '1792940000.400001', user: 'U3', text: 'error says &lt;timeout&gt;' },
    { ts: mentionTs, user: 'U1', text: '<@UBOT> any idea?' },
    { ts: '1792940002.100001', user: 'U2', text: 'later' },
  ];

  it('returns the thread before the request for a new conversation', async () => {
    const { thread, originReads } = await setup({ origin: conversation });
    expect(await (await thread()).json()).toEqual({
      messages: [
        {
          ts: rootTs,
          date: '2026-10-25T14:53:20.100Z',
          userId: null,
          botName: 'Opsgenie',
          text: 'P2 checkout errors\nHTTP 500 rate above 5%',
        },
        expect.objectContaining({ userId: 'U2', text: 'tried a restart, still failing' }),
        expect.objectContaining({
          botName: 'B1',
          own: true,
          text: 'Restarting fixed it last time.',
        }),
        expect.objectContaining({ userId: 'U3', text: 'error says <timeout>' }),
      ],
      omitted: 0,
      truncated: false,
    });
    expect(originReads.at(-1)).toMatchObject({ ts: rootTs, latest: mentionTs });
    expect(originReads.at(-1)).not.toHaveProperty('oldest');
  });

  it('returns only what others posted since the seen point', async () => {
    const { thread, originReads } = await setup({ origin: conversation });
    const body = (await (await thread('1792940000.200001')).json()) as Ctx;
    expect(body.messages.map((m) => m.ts)).toEqual(['1792940000.400001']);
    expect(originReads.at(-1)).toMatchObject({ oldest: '1792940000.200001', latest: mentionTs });
  });

  it('keeps the first and the newest messages within the bounds, in thread order', async () => {
    const replies = Array.from({ length: SLACK_READ_MESSAGES + 10 }, (_, i) => ({
      ts: `1792940000.${String(200001 + i)}`,
      user: 'U2',
      text: `reply ${i}`,
    }));
    const { thread } = await setup({
      origin: [{ ...alert, ts: rootTs }, ...replies, { ts: mentionTs, user: 'U1' }],
    });
    const body = (await (await thread()).json()) as Ctx;
    expect(body.messages).toHaveLength(SLACK_READ_MESSAGES);
    expect(body.messages[0]!.ts).toBe(rootTs);
    expect(body.messages[1]!.text).toBe('reply 11');
    expect(body.messages.at(-1)!.text).toBe(`reply ${SLACK_READ_MESSAGES + 9}`);
    expect(body.omitted).toBe(11);
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(SLACK_READ_BYTES + 200);
  });

  it('reads the newest end of a long thread once per message and skips empty posts', async () => {
    const root = { ...alert, ts: rootTs };
    const pages = Array.from({ length: 8 }, (_, page) => [
      root,
      ...Array.from({ length: 100 }, (_, i) => ({
        ts: `1792940000.${String(200001 + page * 100 + i)}`,
        user: 'U2',
        ...(page === 7 && i === 99 ? {} : { text: `reply ${page * 100 + i}` }),
      })),
    ]);
    pages.at(-1)!.push({ ts: mentionTs, user: 'U1' });
    const { thread } = await setup({ originPages: pages });
    const body = (await (await thread()).json()) as Ctx;
    expect(body.messages.filter((m) => m.ts === rootTs)).toHaveLength(1);
    expect(body.messages).toHaveLength(SLACK_READ_MESSAGES);
    expect(body.messages.at(-1)!.text).toBe('reply 798');
    expect(body.omitted).toBe(800 - SLACK_READ_MESSAGES);
  });

  it('returns nothing for a thread the request starts and refuses a bad seen point', async () => {
    const own = await setup({ origin: [{ ts: rootTs, user: 'U1', text: '<@UBOT> help' }] });
    expect(await (await own.thread(null, { messageTs: rootTs })).json()).toEqual({
      messages: [],
      omitted: 0,
      truncated: false,
    });
    expect(own.originReads).toHaveLength(1);
    await adapter!.close();
    const { thread } = await setup({ origin: conversation });
    expect((await thread(mentionTs)).status).toBe(503);
    expect((await thread('yesterday')).status).toBe(503);
  });

  it('refuses a deleted root and an externally shared origin', async () => {
    const deleted = await setup({
      origin: [
        { ts: rootTs, user: 'USLACKBOT', subtype: 'tombstone' },
        { ts: mentionTs, user: 'U1' },
      ],
    });
    expect((await deleted.thread()).status).toBe(503);
    await adapter!.close();
    const shared = await setup({ originChannel: { ...open, is_ext_shared: true } });
    expect((await shared.thread()).status).toBe(503);
  });
});
