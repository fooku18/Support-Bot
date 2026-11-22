import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  createSlackClient,
  postMessage,
  addReaction,
  previewText,
  replyBlocks,
  MAX_FOOTER_CHARS,
  SLACK_TEXT_CHARS,
  SlackPostError,
} from '../src/slackclient.js';
import { flattenOwnAnswer } from '../src/generated/slack-message-content.js';

describe('Slack reply payload', () => {
  it('sends standard Markdown through a native block, the fallback, and invisible delivery metadata', async () => {
    const text = [
      'Booking reference: **CF-731**. Timeout: *45 minutes*.',
      '- [Documentation](https://example.com)',
      '`literal **asterisks**`',
      '```js\nconst value = "**unchanged**";\n```',
    ].join('\n');
    let payload: Record<string, string> | undefined;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      payload = Object.fromEntries(new URLSearchParams(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: { ts: '1.000001', text } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing server port');
      const webClient = createSlackClient('local-test-token', {
        slackApiUrl: `http://127.0.0.1:${address.port}/`,
      });
      const result = await postMessage(
        { webClient, botUserId: 'UBOT' },
        {
          channel: 'CTEST',
          thread_ts: '1.000000',
          text,
          delivery: { operationId: 'out-1-format', revision: 3, answer: true },
        },
      );
      expect(result.ts).toBe('1.000001');
      expect(payload).toMatchObject({ channel: 'CTEST', thread_ts: '1.000000', text });
      expect(JSON.parse(payload?.blocks ?? 'null')).toEqual([{ type: 'markdown', text }]);
      expect(payload?.markdown_text).toBeUndefined();
      expect(JSON.parse(payload?.metadata ?? 'null')).toEqual({
        event_type: 'support_agent_delivery',
        event_payload: { operation_id: 'out-1-format', revision: 3, answer: true },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe('long answers', () => {
  const items = Array.from(
    { length: 110 },
    (_, index) =>
      `${index + 1}. Item ${index + 1}: ${'a sentence about a tree species. '.repeat(3).trim()}`,
  );
  const answer = items.join('\n');

  it('keeps a text within the bound unchanged', () => {
    expect(previewText('short answer')).toBe('short answer');
    const exact = 'x'.repeat(SLACK_TEXT_CHARS);
    expect(previewText(exact)).toBe(exact);
  });

  it('previews a longer text up to the last line break before the bound', () => {
    expect(answer.length).toBeGreaterThan(10_000);
    const preview = previewText(answer);
    expect(preview.length).toBeLessThanOrEqual(SLACK_TEXT_CHARS);
    expect(preview.endsWith(' …')).toBe(true);
    const head = preview.slice(0, -2);
    expect(answer.startsWith(head)).toBe(true);
    expect(answer[head.length]).toBe('\n');
  });

  it('cuts hard without a late line break and never splits a surrogate pair', () => {
    const flat = previewText('y'.repeat(SLACK_TEXT_CHARS + 50));
    expect(flat).toBe(`${'y'.repeat(SLACK_TEXT_CHARS - 2)} …`);
    const emoji = previewText(`${'z'.repeat(SLACK_TEXT_CHARS - 3)}${'😀'.repeat(20)}`);
    expect(emoji.length).toBeLessThanOrEqual(SLACK_TEXT_CHARS);
    expect(emoji).toBe(`${'z'.repeat(SLACK_TEXT_CHARS - 3)} …`);
  });

  it('posts the whole answer in the markdown block and a bounded preview text', async () => {
    const post = vi.fn(async () => ({ ok: true, message: { ts: '1.000002' } }));
    const webClient = { chat: { postMessage: post } } as unknown as WebClient;
    await postMessage(
      { webClient, botUserId: 'UBOT' },
      {
        channel: 'CTEST',
        thread_ts: '1.000002',
        text: answer,
        delivery: { operationId: 'out-1-long', revision: 2, answer: true },
      },
    );
    const args = (post.mock.calls[0] as unknown as [{ text: string; blocks: unknown[] }])[0];
    expect(args.text).toBe(previewText(answer));
    expect(args.text.length).toBeLessThanOrEqual(SLACK_TEXT_CHARS);
    expect(args.blocks[0]).toEqual({ type: 'markdown', text: answer });
    // Read back on a fresh session, the preview is dropped as contained.
    expect(flattenOwnAnswer({ text: args.text, blocks: args.blocks })).toBe(answer);
  });
});

describe('answer footer', () => {
  it('renders the footer as a context line below the answer, outside text and context', async () => {
    const post = vi.fn(async () => ({ ok: true, message: { ts: '1.000003' } }));
    const webClient = { chat: { postMessage: post } } as unknown as WebClient;
    await postMessage(
      { webClient, botUserId: 'UBOT' },
      {
        channel: 'CTEST',
        thread_ts: '1.000003',
        text: 'The answer.',
        footer: '✅ Done · Model: *opus*',
        delivery: { operationId: 'out-1-footer', revision: 1, answer: true },
      },
    );
    const args = (post.mock.calls[0] as unknown as [{ text: string; blocks: unknown[] }])[0];
    expect(args.text).toBe('The answer.');
    expect(args.blocks).toEqual([
      { type: 'markdown', text: 'The answer.' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '✅ Done · Model: *opus*' }] },
    ]);
    expect(flattenOwnAnswer({ text: args.text, blocks: args.blocks })).toBe('The answer.');
  });

  it('omits an empty footer and bounds a long one', () => {
    expect(replyBlocks('a', '  ')).toEqual([{ type: 'markdown', text: 'a' }]);
    expect(replyBlocks('a')).toEqual([{ type: 'markdown', text: 'a' }]);
    const [, context] = replyBlocks('a', 'f'.repeat(MAX_FOOTER_CHARS + 10)) as [
      unknown,
      { elements: [{ text: string }] },
    ];
    expect(context.elements[0].text).toHaveLength(MAX_FOOTER_CHARS);
  });
});

describe('addReaction (intake acknowledgment hint)', () => {
  it('sends channel, timestamp, and emoji name to reactions.add', async () => {
    let payload: Record<string, string> | undefined;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      payload = Object.fromEntries(new URLSearchParams(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing server port');
      const webClient = createSlackClient('local-test-token', {
        slackApiUrl: `http://127.0.0.1:${address.port}/`,
      });
      await addReaction(
        { webClient, botUserId: 'UBOT' },
        {
          channel: 'CTEST',
          timestamp: '1716234567.111111',
          name: 'eyes',
        },
      );
      expect(payload).toMatchObject({
        channel: 'CTEST',
        timestamp: '1716234567.111111',
        name: 'eyes',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('treats already_reacted as success for duplicate redeliveries', async () => {
    const webClient = {
      reactions: {
        add: vi.fn(async () => {
          throw Object.assign(new Error('reactions.add failed'), {
            data: { error: 'already_reacted' },
          });
        }),
      },
    } as unknown as WebClient;
    await expect(
      addReaction(
        { webClient, botUserId: 'UBOT' },
        { channel: 'C1', timestamp: '1.0', name: 'eyes' },
      ),
    ).resolves.toBeUndefined();
    expect(webClient.reactions.add).toHaveBeenCalledOnce();
  });

  it('classifies other failures like posts (rate limited, definite, ambiguous)', async () => {
    const rateLimited = {
      reactions: {
        add: vi.fn(async () => {
          throw Object.assign(new Error('rate limited'), {
            code: 'slack_webapi_rate_limited_error',
            retryAfter: 7,
          });
        }),
      },
    } as unknown as WebClient;
    const rateErr = await addReaction(
      { webClient: rateLimited, botUserId: undefined },
      { channel: 'C1', timestamp: '1.0', name: 'eyes' },
    ).catch((err) => err);
    expect(rateErr).toBeInstanceOf(SlackPostError);
    expect((rateErr as SlackPostError).failure.kind).toBe('rate_limited');

    const definite = {
      reactions: {
        add: vi.fn(async () => {
          throw Object.assign(new Error('not in channel'), { data: { error: 'not_in_channel' } });
        }),
      },
    } as unknown as WebClient;
    const definiteErr = await addReaction(
      { webClient: definite, botUserId: undefined },
      { channel: 'C1', timestamp: '1.0', name: 'eyes' },
    ).catch((err) => err);
    expect(definiteErr).toBeInstanceOf(SlackPostError);
    expect((definiteErr as SlackPostError).failure.kind).toBe('definite');
  });
});

describe('native read-only rate limits', () => {
  it('honors a definite read Retry-After, but never retries writes, long waits or unknown failures', async () => {
    const calls = new Map<string, number>();
    const server = createServer((req, res) => {
      const method = req.url!;
      calls.set(method, (calls.get(method) ?? 0) + 1);
      if (method === '/files.info') {
        res.writeHead(500).end();
      } else if (method === '/conversations.members' && calls.get(method) === 2) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, members: [] }));
      } else {
        res.writeHead(429, { 'retry-after': method === '/conversations.info' ? '25' : '1' }).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('port unavailable');
      const client = createSlackClient('synthetic', {
        slackApiUrl: `http://127.0.0.1:${address.port}/`,
        boundedReadRetries: true,
      });
      const start = Date.now();
      expect((await client.conversations.members({ channel: 'CTEST' })).members).toEqual([]);
      expect(Date.now() - start).toBeGreaterThanOrEqual(950);
      await expect(
        client.chat.postMessage({ channel: 'CTEST', text: 'never replay' }),
      ).rejects.toBeDefined();
      await expect(client.conversations.info({ channel: 'CTEST' })).rejects.toBeDefined();
      await expect(client.files.info({ file: 'FTEST' })).rejects.toBeDefined();
      // Repeated429s on the current-source authority read exhaust the bounded
      // retries; callers receive a refusal rather than stale authorization.
      await expect(
        client.conversations.replies({ channel: 'CTEST', ts: '1.000001' }),
      ).rejects.toBeDefined();
      expect(Object.fromEntries(calls)).toEqual({
        '/conversations.members': 2,
        '/chat.postMessage': 1,
        '/conversations.info': 1,
        '/files.info': 1,
        '/conversations.replies': 3,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
