import { afterEach, expect, it, vi } from 'vitest';
import { createNativeAgentAdapter, nativeThreadReply } from '../src/native-agents.js';
import type { SlackDeps } from '../src/slackclient.js';
const identity = { teamId: 'TTEST', installationId: 'UBOT', botUserId: 'UBOT', botId: 'BBOT' };
const slack = {} as SlackDeps;
const adapter = () =>
  createNativeAgentAdapter({
    baseUrl: 'http://native.internal',
    token: 'service-only',
    identity,
    slack,
  });
afterEach(() => vi.restoreAllMocks());
it('native ingress strips action tokens and uses the authenticated event identity', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ runId: 'run', owner: 'owner' }));
  await adapter().mention(
    {
      type: 'app_mention',
      channel: 'CTEST',
      user: 'UACTOR',
      ts: '1794740000.1',
      text: 'Question',
      action_token: 'scoped-never-retain',
    },
    'EV1',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(String(url)).toBe('http://native.internal/agents/start');
  const body = JSON.parse(String(init?.body));
  expect(body.userId).toBe('UACTOR');
  expect(body.teamId).toBe('TTEST');
  expect(body.actionToken).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('scoped-never-retain');
});
it('rejects bot impersonation before any native service call', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(
    adapter().mention(
      {
        type: 'app_mention',
        channel: 'CTEST',
        user: 'UACTOR',
        bot_id: 'BOTHER',
        ts: '1794740000.1',
      },
      'EV2',
    ),
  ).rejects.toThrow('identity');
  expect(fetch).not.toHaveBeenCalled();
});
it('makes unsupported attachments explicitly unavailable instead of silently losing input', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const event = {
    type: 'app_mention',
    channel: 'CTEST',
    user: 'UACTOR',
    ts: '1794740000.1',
    files: [{ id: 'FFILE', mimetype: 'application/pdf' }],
  };
  await expect(adapter().mention(event, 'EV3')).rejects.toThrow('unsupported_format');
  expect(fetch).not.toHaveBeenCalled();
});
it('forwards bounded public descriptors, never event download URLs or tokens', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ runId: 'r', owner: 'o' }));
  await adapter().mention(
    {
      type: 'app_mention',
      channel: 'CTEST',
      user: 'UACTOR',
      ts: '1794740000.1',
      files: [
        {
          id: 'FFILE',
          name: 'report.csv',
          mimetype: 'text/csv',
          size: 12,
          mode: 'snippet',
          is_external: false,
          updated: 1,
          user: 'UACTOR',
          url_private_download: 'https://files.slack.com/never-forward',
        },
      ],
    },
    'EV4',
  );
  const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
  expect(body.files).toHaveLength(1);
  expect(body.files[0]).toMatchObject({
    id: 'FFILE',
    sourceTs: '1794740000.1',
    mime: 'text/csv',
    bytes: 12,
    hosted: true,
  });
  expect(body.files[0].revision).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(body)).not.toContain('never-forward');
});
it('refuses count, size and non-hosted inputs before service admission', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const file = {
    id: 'FFILE',
    name: 'report.csv',
    mimetype: 'text/csv',
    size: 12,
    mode: 'snippet',
    is_external: false,
    updated: 1,
  };
  const event = { type: 'app_mention', channel: 'CTEST', user: 'UACTOR', ts: '1794740000.1' };
  for (const files of [
    Array.from({ length: 5 }, (_, i) => ({ ...file, id: `FFILE${i}` })),
    [{ ...file, size: 200 * 1024 + 1 }],
    [{ ...file, is_external: true }],
    Array.from({ length: 4 }, (_, i) => ({
      ...file,
      id: `FIMAGE${i}`,
      mimetype: 'image/png',
      mode: 'hosted',
      size: 2 * 1024 ** 2,
    })),
  ])
    await expect(adapter().mention({ ...event, files }, 'EV5')).rejects.toThrow('native_input_');
  expect(fetch).not.toHaveBeenCalled();
});
it('fails closed on denied resume without falling back to a coordinator route', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 409 }));
  await expect(
    adapter().resume({
      runId: 'run',
      actor: 'UACTOR',
      owner: 'stale',
      toolCallId: 'ask',
      answer: 'choice',
    }),
  ).rejects.toThrow('409');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]![0])).toContain('/agents/resume');
});

it('routes only eligible unmentioned thread messages through the existing sender policy', async () => {
  const { nativeThreadReply } = await import('../src/native-agents.js');
  const message = {
    type: 'message',
    channel: 'CTEST',
    user: 'UACTOR',
    ts: '1794740001.1',
    thread_ts: '1794740000.1',
    text: 'What about the earlier answer?',
  };
  expect(nativeThreadReply(message, identity)?.type).toBe('app_mention');
  for (const changed of [
    { thread_ts: undefined },
    { thread_ts: message.ts },
    { user: 'UBOT' },
    { bot_id: 'BOTHER' },
    { subtype: 'message_changed' },
    { subtype: 'message_deleted' },
    { text: '<@UBOT> explicitly mentioned' },
    { type: 'app_mention' },
  ])
    expect(nativeThreadReply({ ...message, ...changed }, identity)).toBeNull();
  const trusted = {
    ...identity,
    trustedBotSender: { teamId: 'TTEST', userId: 'UACTOR', botId: 'BTRUSTED', channelId: 'CTEST' },
  };
  expect(
    nativeThreadReply({ ...message, bot_id: 'BTRUSTED', subtype: 'bot_message' }, trusted),
  ).not.toBeNull();
});

const threadReply = {
  type: 'message',
  channel: 'CTEST',
  user: 'UACTOR',
  ts: '1794740001.1',
  thread_ts: '1794740000.1',
};
const longLog = Array.from({ length: 600 }, (_, i) => `2026-11-27T10:00:${i} ERROR boom`).join(
  '\n',
);

it('treats an unmentioned thread reply that is also sent to the channel as a follow-up', () => {
  const reply = {
    ...threadReply,
    subtype: 'thread_broadcast',
    text: 'And how do I do the same for Poland?',
  };
  expect(nativeThreadReply(reply, identity)?.type).toBe('app_mention');
});

it('ignores the message copy of a mention beyond the flattened content cap', () => {
  const copy = { ...threadReply, text: `${longLog}\n<@UBOT> what does this log mean?` };
  expect(Buffer.byteLength(copy.text)).toBeGreaterThan(16 * 1024);
  expect(nativeThreadReply(copy, identity)).toBeNull();
});

it('ignores the message copy of a rich-text mention beyond the flattened content cap', () => {
  const blocks = (userId: string) => [
    {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: `${longLog}\n` },
            { type: 'user', user_id: userId },
            { type: 'text', text: ' please check' },
          ],
        },
      ],
    },
  ];
  expect(nativeThreadReply({ ...threadReply, blocks: blocks('UBOT') }, identity)).toBeNull();
  expect(nativeThreadReply({ ...threadReply, blocks: blocks('UOTHER') }, identity)).not.toBeNull();
});

it('ignores the message copy of a mention made in a section block or an attachment', () => {
  const section = [{ type: 'section', text: { type: 'mrkdwn', text: '<@UBOT> alert fired' } }];
  expect(nativeThreadReply({ ...threadReply, blocks: section }, identity)).toBeNull();
  expect(
    nativeThreadReply({ ...threadReply, attachments: [{ text: '<@UBOT> alert fired' }] }, identity),
  ).toBeNull();
  expect(
    nativeThreadReply(
      { ...threadReply, text: longLog, attachments: [{ text: '<@UBOT> alert fired' }] },
      identity,
    ),
  ).toBeNull();
});
