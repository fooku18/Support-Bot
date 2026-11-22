import { afterEach, describe, expect, it, vi } from 'vitest';
import { testInstallation } from './helpers/installations.js';
import {
  longAnswerNotice,
  SLACK_MARKDOWN_CHARS,
  splitLongAnswer,
} from '../src/generated/long-answer.js';
import { buildTaskKey } from '../src/taskkey.js';

const fixtures = vi.hoisted(() => ({ installation: undefined as unknown, transfers: 0 }));
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
vi.mock('../src/file-upload.js', async (original) => ({
  ...(await original<typeof import('../src/file-upload.js')>()),
  transferSlackFile: async () => {
    fixtures.transfers++;
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
const long = Array.from(
  { length: 450 },
  (_, i) => `Line ${String(i + 1).padStart(5, '0')} of the long answer.`,
).join('\n');

async function setup(
  options: {
    complete?: () => Promise<unknown>;
    authority?: () => Response;
    thread?: Array<Record<string, unknown>>;
  } = {},
) {
  fixtures.transfers = 0;
  const order: string[] = [];
  const split = splitLongAnswer(long)!;
  const postMessage = vi.fn(async () => {
    order.push('post');
    return { ok: true, message: { ts: '1792940000.200001' } };
  });
  const installation = testInstallation(
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
          messages: options.thread ?? [{ ts: rootTs, user: 'U1' }],
          response_metadata: {},
        }),
      },
      chat: { postMessage },
      files: {
        getUploadURLExternal: async () => {
          order.push('allocate');
          return { ok: true, file_id: 'F0ANSWER', upload_url: 'https://files.slack.com/u/1' };
        },
        completeUploadExternal:
          options.complete ??
          (async () => {
            order.push('complete');
            return { ok: true, files: [{ id: 'F0ANSWER' }] };
          }),
        info: async () => ({
          ok: true,
          file: {
            id: 'F0ANSWER',
            user: 'UBOT',
            size: split.file.bytes,
            permalink: 'https://slack.com/files/F0ANSWER',
            shares: { private: { C1: [{ ts: '1792940000.150001', thread_ts: rootTs }] } },
          },
        }),
      },
    },
  );
  fixtures.installation = installation;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === '/agents/delivery-authority' && options.authority) return options.authority();
      return Response.json({ ok: true });
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
  const identity = { installationId: 'UBOT', teamId: 'T1', channelId: 'C1', rootTs };
  const deliver = (changes: Record<string, unknown> = {}) =>
    realFetch(`http://127.0.0.1:${adapter!.port}/native-delivery`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-service', 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: '00000000-0000-4000-8000-000000000203',
        taskKey: buildTaskKey(identity),
        channel: 'C1',
        rootTs,
        requesterUserId: 'U1',
        text: split.preview,
        footer: '✅ Done · Model: *fixture*',
        answerFile: split.file,
        authority: { runId: 'run-1', actor: 'U1', owner: 'owner-1' },
        ...changes,
      }),
    });
  const check = (messageTs: string) =>
    realFetch(`http://127.0.0.1:${adapter!.port}/native-authority/check`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-service', 'content-type': 'application/json' },
      body: JSON.stringify({ ...identity, userId: 'U1', messageTs, authorBotId: null }),
    });
  return { deliver, postMessage, order, calls, split, check };
}

describe('long answer delivery in the Slack adapter', () => {
  it('uploads the full answer to the thread first, then posts the notice and preview', async () => {
    const { deliver, postMessage, order, calls, split } = await setup();
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ts: '1792940000.200001',
      answerFile: {
        attached: true,
        fileId: 'F0ANSWER',
        permalink: 'https://slack.com/files/F0ANSWER',
        sha256: split.file.sha256,
        bytes: split.file.bytes,
      },
    });
    expect(order).toEqual(['allocate', 'complete', 'post']);
    expect(fixtures.transfers).toBe(1);
    // Current delivery authority before each external call of the upload and the post.
    expect(calls.filter((p) => p === '/agents/delivery-authority').length).toBeGreaterThan(4);
    const args = (postMessage.mock.calls[0] as unknown as [Record<string, never>])[0];
    const text = `${longAnswerNotice(true)}\n\n${split.preview}`;
    expect(args.blocks[0]).toEqual({ type: 'markdown', text });
    expect((args.blocks[0] as { text: string }).text.length).toBeLessThan(SLACK_MARKDOWN_CHARS);
    expect(args.metadata).toEqual({
      event_type: 'support_agent_delivery',
      event_payload: {
        operation_id: '00000000-0000-4000-8000-000000000203',
        revision: 1,
        answer: true,
        result_files: [{ id: 'F0ANSWER', sha256: split.file.sha256 }],
      },
    });
  });

  it('posts the preview with a failure notice when the upload fails, without a retry', async () => {
    let completions = 0;
    const { deliver, postMessage, order } = await setup({
      complete: async () => {
        completions++;
        throw new Error('socket hang up');
      },
    });
    const response = await deliver();
    expect(response.status).toBe(200);
    expect((await response.json()).answerFile).toEqual({ attached: false });
    expect(completions).toBe(1);
    expect(order).toEqual(['allocate', 'post']);
    const args = (postMessage.mock.calls[0] as unknown as [Record<string, never>])[0];
    expect((args.blocks[0] as { text: string }).text).toContain(longAnswerNotice(false));
    expect(args.metadata).not.toHaveProperty('event_payload.result_files');
  });

  it('sends nothing more once current delivery authority is refused', async () => {
    let checks = 0;
    const { deliver, postMessage, order } = await setup({
      authority: () => (++checks > 2 ? new Response('{}', { status: 409 }) : Response.json({})),
    });
    const response = await deliver();
    expect(response.status).toBe(503);
    expect(postMessage).not.toHaveBeenCalled();
    expect(order).not.toContain('post');
  });

  it('refuses an over-limit text without a file and a mismatched file before any Slack write', async () => {
    const { deliver, postMessage, order, split } = await setup();
    expect((await deliver({ text: long, answerFile: undefined })).status).toBe(503);
    expect((await deliver({ answerFile: { ...split.file, sha256: '0'.repeat(64) } })).status).toBe(
      503,
    );
    expect(postMessage).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('refuses a thread whose deleted root remains as a tombstone', async () => {
    const reply = '1792940000.100002';
    const live = await setup({
      thread: [
        { ts: rootTs, user: 'U1' },
        { ts: reply, user: 'U1' },
      ],
    });
    expect((await live.check(reply)).status).toBe(200);
    await adapter?.close();
    const deleted = await setup({
      thread: [
        { ts: rootTs, user: 'USLACKBOT', subtype: 'tombstone', text: 'This message was deleted.' },
        { ts: reply, user: 'U1' },
      ],
    });
    expect((await deleted.check(reply)).ok).toBe(false);
  });
});
