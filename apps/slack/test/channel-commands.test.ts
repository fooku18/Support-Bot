import { createServer } from 'node:http';
import { createSlackClient } from '../src/slackclient.js';
import { describe, expect, it, vi } from 'vitest';
import {
  ChannelCommandHandler,
  CommandClient,
  configureModal,
  CONFIGURE_CALLBACK,
  CONFIGURE_ACTION,
  splitPrompt,
  receiptBlocks,
} from '../src/channel-commands.js';
import type { Installation } from '../src/installations.js';
import { handleEnvelope } from '../src/receiver.js';
function setup() {
  const webClient = {
    chat: {
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      postMessage: vi.fn().mockResolvedValue({ ts: '1792940000.999999' }),
    },
    views: { open: vi.fn().mockResolvedValue({ ok: true }) },
    conversations: {
      members: vi.fn(async () => ({ ok: true, members: ['U1'], response_metadata: {} })),
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
  };
  const installation = {
    identity: { teamId: 'T1', installationId: 'UBOT', botUserId: 'UBOT', botId: 'B1' },
    slack: { webClient, receiptWebClient: webClient },
  } as unknown as Installation;
  const client = new CommandClient('http://unused', 'synthetic');
  const request = vi.spyOn(client, 'request');
  const handler = new ChannelCommandHandler(client, { get: () => installation }, vi.fn());
  const event = {
    type: 'app_mention',
    channel: 'C1',
    user: 'U1',
    ts: '1792940000.123456',
    text: '<@UBOT> !config',
  };
  return { handler, request, installation, event, webClient };
}
const draft = {
  session: 'session-id',
  model: null,
  prompt: null,
  autoReplies: true,
  keys: ['sonnet', 'opus'],
  workspaceModel: 'opus',
  workspacePrompt: 'default',
};
describe('private Configure and deterministic routing', () => {
  it('offers prompt text without a separate mode and explains empty inheritance', () => {
    const modal = configureModal(draft) as {
      blocks: Array<{
        block_id?: string;
        text?: { text: string };
        element?: { initial_value?: string };
      }>;
    };
    expect(modal.blocks.filter((b) => b.block_id).map((b) => b.block_id)).toEqual([
      'replies',
      'model',
      'part1',
      'part2',
    ]);
    expect(modal.blocks[0]?.text?.text).toContain('Leave both prompt fields empty to inherit');
    expect(
      modal.blocks.find((b) => b.block_id === 'part1')?.element?.initial_value,
    ).toBeUndefined();
  });

  it('shows "Automatic thread replies" checked by default and unchecked when saved off', () => {
    type Modal = {
      blocks: Array<{
        block_id?: string;
        label?: { text: string };
        element?: {
          type?: string;
          options?: Array<{ value: string; description?: { text: string } }>;
          initial_options?: Array<{ value: string }>;
        };
      }>;
    };
    const on = (configureModal(draft) as Modal).blocks.find((b) => b.block_id === 'replies')!;
    expect(on.label?.text).toBe('Automatic thread replies');
    expect(on.element?.type).toBe('checkboxes');
    expect(on.element?.initial_options?.map((o) => o.value)).toEqual(['on']);
    expect(on.element?.options?.[0]?.description?.text).toContain('Never at channel top level');
    const off = (configureModal({ ...draft, autoReplies: false }) as Modal).blocks.find(
      (b) => b.block_id === 'replies',
    )!;
    expect(off.element?.initial_options).toBeUndefined();
  });

  it('regression: stays within Slack view limits (views.open refuses the whole modal otherwise)', () => {
    // Found live 2026-10-28: a 239-character option description made every
    // "Configure channel" click fail with "Could not open configuration in time".
    const texts: Array<{ where: string; text: string; max: number }> = [];
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${where}/${i}`));
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        const path = `${where}/${key}`;
        const text = (value as { text?: unknown } | null)?.text;
        if (typeof text === 'string') {
          // Slack Block Kit limits (plain_text objects).
          const max =
            key === 'description'
              ? 150
              : key === 'label'
                ? 2000
                : key === 'title' || key === 'submit' || key === 'close'
                  ? 24
                  : path.includes('/options/') && key === 'text'
                    ? 75
                    : 3000;
          texts.push({ where: path, text, max });
        }
        walk(value, path);
      }
    };
    for (const autoReplies of [true, false])
      walk(
        configureModal({
          ...draft,
          autoReplies,
          prompt: 'p'.repeat(4000),
          keys: ['sonnet', 'opus'],
        }),
        '',
      );
    const over = texts
      .filter((t) => t.text.length > t.max)
      .map((t) => `${t.where} ${t.text.length}>${t.max}`);
    expect(over).toEqual([]);
    expect(texts.some((t) => t.where.endsWith('/description'))).toBe(true);
  });

  it('acknowledges only after the durable grant, then posts only to its requester without a top-level thread_ts', async () => {
    const { handler, request, installation, event, webClient } = setup();
    const ack = vi.fn();
    request.mockImplementation(async () => {
      expect(ack).not.toHaveBeenCalled();
      return { kind: 'configure', grant: 'grant-id' };
    });
    await handler.mention(event, 'Ev1', installation, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(webClient.chat.postMessage).not.toHaveBeenCalled();
    expect(webClient.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', user: 'U1' }),
    );
    expect(webClient.chat.postEphemeral.mock.calls[0]?.[0]?.thread_ts).toBeUndefined();
  });
  it('does not acknowledge or admit a task during a command service outage', async () => {
    const { handler, request, installation, event } = setup();
    request.mockRejectedValue(new Error('offline'));
    const ack = vi.fn(),
      intake = vi.fn();
    await expect(
      handleEnvelope(
        {
          type: 'events_api',
          ack,
          body: { type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event },
        },
        {
          appToken: 'fake',
          installations: { get: () => installation },
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          intake,
          command: (e, id, i, a) => handler.mention(e, id, i, a),
        },
      ),
    ).rejects.toThrow('offline');
    expect(ack).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });
  it('retains bot filtering before command routing', async () => {
    const { installation, event } = setup();
    const command = vi.fn();
    for (const bot_id of ['B1', 'BOTHER'])
      await handleEnvelope(
        {
          type: 'events_api',
          ack: vi.fn(),
          body: { type: 'event_callback', team_id: 'T1', event: { ...event, bot_id } },
        },
        {
          appToken: 'fake',
          installations: { get: () => installation },
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          intake: vi.fn(),
          command,
        },
      );
    expect(command).not.toHaveBeenCalled();
  });
  it('opens only from ephemeral containers and stores only the opaque session in metadata', async () => {
    const { handler, request, installation, webClient } = setup();
    request.mockResolvedValue(draft);
    const ack = vi.fn();
    const body = {
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      channel: { id: 'C1' },
      container: { is_ephemeral: true, channel_id: 'C1' },
      trigger_id: 'trigger',
      actions: [{ action_id: CONFIGURE_ACTION, value: 'grant' }],
    };
    await handler.interaction({ type: 'interactive', ack, body }, installation);
    expect(request).toHaveBeenCalledWith(
      'open',
      { teamId: 'T1', channelId: 'C1', userId: 'U1', grant: 'grant' },
      1500,
    );
    expect(webClient.views.open.mock.calls[0]?.[0]?.view.private_metadata).toBe('session-id');
    request.mockClear();
    await handler.interaction(
      {
        type: 'interactive',
        ack,
        body: { ...body, container: { is_ephemeral: false, channel_id: 'C1' } },
      },
      installation,
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('regression: a Slack refusal of the form is reported truthfully and logged by code', async () => {
    const { request, installation, webClient } = setup();
    const warn = vi.fn();
    const handler = new ChannelCommandHandler(
      new CommandClient('http://unused', 'synthetic'),
      { get: () => installation },
      warn,
    );
    vi.spyOn((handler as unknown as { client: CommandClient }).client, 'request').mockResolvedValue(
      draft,
    );
    void request;
    webClient.views.open.mockRejectedValue(
      Object.assign(new Error('An API error occurred: invalid_arguments'), {
        code: 'slack_webapi_platform_error',
        data: { ok: false, error: 'invalid_arguments' },
      }),
    );
    const ack = vi.fn();
    await handler.interaction(
      {
        type: 'interactive',
        ack,
        body: {
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'C1' },
          container: { is_ephemeral: true, channel_id: 'C1' },
          trigger_id: 'trigger',
          actions: [{ action_id: CONFIGURE_ACTION, value: 'grant' }],
        },
      },
      installation,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(webClient.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Slack refused the configuration form. Nothing was changed; please report this to the operator.',
      }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('views.open failed (definite'));
  });
  it('joins prompt parts exactly, waits for save, and reports unknown outcomes inline', async () => {
    const { handler, request, installation } = setup();
    const ack = vi.fn();
    const body = {
      type: 'view_submission',
      team: { id: 'T1' },
      user: { id: 'U1' },
      view: {
        callback_id: CONFIGURE_CALLBACK,
        private_metadata: 'session',
        state: {
          values: {
            model: { value: { selected_option: { value: 'inherit' } } },
            part1: { value: { value: 'first ' } },
            part2: { value: { value: '\nsecond' } },
          },
        },
      },
    };
    request.mockImplementation(async () => {
      expect(ack).not.toHaveBeenCalled();
      return { changed: true };
    });
    await handler.interaction({ type: 'interactive', ack, body }, installation);
    expect(ack).toHaveBeenCalledWith();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      model: null,
      part1: 'first ',
      part2: '\nsecond',
      // No checkbox selected: the setting is saved off.
      autoReplies: false,
    });
    request.mockRejectedValue(new Error('timeout'));
    ack.mockClear();
    await handler.interaction({ type: 'interactive', ack, body }, installation);
    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: { part1: expect.stringContaining('Save outcome unknown') },
    });
  });
  it('leaves submissions of other views unhandled', async () => {
    const { handler, request, installation } = setup();
    expect(
      await handler.interaction(
        {
          type: 'interactive',
          ack: vi.fn(),
          body: { type: 'view_submission', view: { callback_id: 'other' } },
        },
        installation,
      ),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it('round-trips the full prompt including a surrogate pair at the split', () => {
    for (const text of [
      'a'.repeat(3001),
      'a'.repeat(4000),
      'a'.repeat(2999) + '😀' + '\n ' + 'b'.repeat(998),
    ]) {
      const [a, b] = splitPrompt(text);
      expect(a.length).toBeLessThanOrEqual(3000);
      expect(b.length).toBeLessThanOrEqual(3000);
      expect(a + b).toBe(text);
      expect(a.endsWith('\ud83d')).toBe(false);
      const modal = configureModal({ ...draft, prompt: text }) as {
        blocks: Array<{ block_id?: string; element?: { initial_value?: string } }>;
      };
      expect(
        (modal.blocks.find((b) => b.block_id === 'part1')?.element?.initial_value ?? '') +
          (modal.blocks.find((b) => b.block_id === 'part2')?.element?.initial_value ?? ''),
      ).toBe(text);
    }
  });
});
describe('receipt reconciliation', () => {
  it('waits for the in-flight receipt attempt when stopping the adapter worker', async () => {
    const { handler, request } = setup();
    let release!: (value: null) => void;
    request.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    handler.start();
    let stopped = false;
    const closing = handler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(null);
    await closing;
    expect(stopped).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });
  it('reconciles a possibly posted receipt before any repost', async () => {
    const { handler, request, webClient } = setup();
    request
      .mockResolvedValueOnce({
        id: 'op:0',
        teamId: 'T1',
        channelId: 'C1',
        threadTs: '1792940000.123456',
        body: 'text',
        reconcile: true,
        lease: 'lease',
      })
      .mockResolvedValue({ ok: true });
    webClient.conversations.replies.mockResolvedValue({
      messages: [
        {
          ts: '1792940000.999999',
          user: 'UBOT',
          metadata: {
            event_type: 'support_agent_command_receipt',
            event_payload: { receiptId: 'op:0' },
          },
        },
      ],
    });
    await handler.deliverOne();
    expect(webClient.chat.postMessage).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith('report-receipt', {
      id: 'op:0',
      lease: 'lease',
      state: 'delivered',
      ts: '1792940000.999999',
    });
  });
  it('never reposts after an incomplete history search', async () => {
    const { handler, request, webClient } = setup();
    request
      .mockResolvedValueOnce({
        id: 'op:0',
        teamId: 'T1',
        channelId: 'C1',
        threadTs: '1792940000.123456',
        body: 'text',
        reconcile: true,
        lease: 'lease',
      })
      .mockResolvedValue({ ok: true });
    webClient.conversations.replies.mockResolvedValue({ messages: [], is_limited: true });
    await handler.deliverOne();
    expect(webClient.chat.postMessage).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith(
      'report-receipt',
      expect.objectContaining({ state: 'uncertain' }),
    );
  });
  it('renders literal notes as plain text and marks receipts as non-answer metadata', async () => {
    const { handler, request, webClient } = setup();
    request
      .mockResolvedValueOnce({
        id: 'op:0',
        teamId: 'T1',
        channelId: 'C1',
        threadTs: '1792940000.123456',
        body: '<!channel> <@U1>',
        reconcile: false,
        lease: 'lease',
      })
      .mockResolvedValue({ ok: true });
    await handler.deliverOne();
    expect(webClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Channel command receipt.',
        parse: 'none',
        unfurl_links: false,
        blocks: [
          { type: 'section', text: { type: 'plain_text', emoji: false, text: '<!channel> <@U1>' } },
        ],
        metadata: {
          event_type: 'support_agent_command_receipt',
          event_payload: { receiptId: 'op:0' },
        },
      }),
    );
  });
});

it('does not retry an accepted receipt whose HTTP response was lost; reconciles it next time', async () => {
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith('chat.postMessage')) {
      posts++;
      req.resume();
      req.on('end', () => req.socket.destroy());
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: true,
          messages: [
            {
              ts: '1792940000.999999',
              user: 'UBOT',
              metadata: {
                event_type: 'support_agent_command_receipt',
                event_payload: { receiptId: 'op:0' },
              },
            },
          ],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const { handler, request, installation } = setup();
    installation.slack.receiptWebClient = createSlackClient('synthetic', {
      slackApiUrl: `http://127.0.0.1:${address.port}/`,
      receiptTransport: true,
    });
    let reconcile = false;
    request.mockImplementation(async (route) =>
      route === 'claim-receipt'
        ? {
            id: 'op:0',
            teamId: 'T1',
            channelId: 'C1',
            threadTs: '1792940000.123456',
            body: 'text',
            reconcile,
            lease: 'lease',
          }
        : { ok: true },
    );
    await handler.deliverOne();
    expect(posts).toBe(1);
    expect(request).toHaveBeenLastCalledWith(
      'report-receipt',
      expect.objectContaining({ state: 'uncertain' }),
    );
    reconcile = true;
    await handler.deliverOne();
    expect(posts).toBe(1);
    expect(request).toHaveBeenLastCalledWith(
      'report-receipt',
      expect.objectContaining({ state: 'delivered' }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('holds a receipt when authorization is revoked during reconciliation', async () => {
  const { handler, request, webClient } = setup();
  request
    .mockResolvedValueOnce({
      id: 'op:0',
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '1792940000.123456',
      body: 'text',
      reconcile: true,
      lease: 'lease',
    })
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: false });
  await handler.deliverOne();
  expect(webClient.conversations.replies).toHaveBeenCalledOnce();
  expect(webClient.chat.postMessage).not.toHaveBeenCalled();
});

it('honors history reconciliation rate-limit delays beyond the default receipt backoff', async () => {
  const { handler, request, webClient } = setup();
  request
    .mockResolvedValueOnce({
      id: 'op:0',
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '1792940000.123456',
      body: 'text',
      reconcile: true,
      lease: 'lease',
    })
    .mockResolvedValue({ ok: true });
  webClient.conversations.replies.mockRejectedValue({
    code: 'slack_webapi_rate_limited_error',
    retryAfter: 120,
  });
  await handler.deliverOne();
  expect(webClient.chat.postMessage).not.toHaveBeenCalled();
  expect(request).toHaveBeenLastCalledWith(
    'report-receipt',
    expect.objectContaining({ state: 'uncertain', retryAfterMs: 120000 }),
  );
});

it('renders memory lists as wrapped native tables with literal cells', () => {
  const blocks = receiptBlocks({
    body: 'Channel memory · revision 1 · page 1/1',
    table: { rows: [['#1', '<!channel> *literal*\nsecond line', '2026-10-25 20:58 UTC\nAlex']] },
  });
  expect(blocks[1]).toEqual({
    type: 'table',
    column_settings: [{ is_wrapped: false }, { is_wrapped: true }, { is_wrapped: true }],
    rows: [
      ['ID', 'Note', 'Last confirmed'].map((text) => ({ type: 'raw_text', text })),
      ['#1', '<!channel> *literal*\nsecond line', '2026-10-25 20:58 UTC\nAlex'].map((text) => ({
        type: 'raw_text',
        text,
      })),
    ],
  });
  expect(receiptBlocks({ body: 'No saved notes.', table: { rows: [] } })).toHaveLength(1);
});
