import { describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { CHART_NOT_SHOWN, chartBlock, replyParts } from '../src/generated/slack-charts.js';
import { postMessage, replyBlocks } from '../src/slackclient.js';
import { flattenOwnAnswer } from '../src/generated/slack-message-content.js';

const hours = ['00', '01', '02'];
const line = {
  type: 'line',
  title: 'PDP requests per hour (M)',
  categories: hours,
  series: [
    { name: 'Today', values: [3.6, 3.8, 4.1] },
    { name: 'Yesterday', values: [3.1, 3.2, -0.5] },
  ],
  x_label: 'Hour (UTC)',
  y_label: 'Requests (M)',
};
const fence = (spec: unknown) => ['```chart', JSON.stringify(spec), '```'].join('\n');

describe('chart blocks', () => {
  it('turns a line chart into a data_visualization block with one point per category', () => {
    expect(chartBlock(JSON.stringify(line))).toEqual({
      type: 'data_visualization',
      title: 'PDP requests per hour (M)',
      chart: {
        type: 'line',
        series: [
          {
            name: 'Today',
            data: [
              { label: '00', value: 3.6 },
              { label: '01', value: 3.8 },
              { label: '02', value: 4.1 },
            ],
          },
          {
            name: 'Yesterday',
            data: [
              { label: '00', value: 3.1 },
              { label: '01', value: 3.2 },
              { label: '02', value: -0.5 },
            ],
          },
        ],
        axis_config: { categories: hours, x_label: 'Hour (UTC)', y_label: 'Requests (M)' },
      },
    });
  });

  it('turns a pie into segments', () => {
    expect(
      chartBlock(
        JSON.stringify({
          type: 'pie',
          title: 'Share of requests',
          categories: ['DE', 'PL'],
          series: [{ name: 'Requests', values: [30.4, 6.3] }],
        }),
      ),
    ).toEqual({
      type: 'data_visualization',
      title: 'Share of requests',
      chart: {
        type: 'pie',
        segments: [
          { label: 'DE', value: 30.4 },
          { label: 'PL', value: 6.3 },
        ],
      },
    });
  });

  it.each([
    ['invalid JSON', '{"type":'],
    ['an unknown type', JSON.stringify({ ...line, type: 'scatter' })],
    ['a long title', JSON.stringify({ ...line, title: 'x'.repeat(51) })],
    ['a long category', JSON.stringify({ ...line, categories: ['x'.repeat(21), '01', '02'] })],
    ['duplicate categories', JSON.stringify({ ...line, categories: ['00', '00', '02'] })],
    [
      '21 categories',
      JSON.stringify({
        ...line,
        categories: Array.from({ length: 21 }, (_, i) => String(i)),
        series: [{ name: 'Today', values: Array.from({ length: 21 }, () => 1) }],
      }),
    ],
    [
      '13 series',
      JSON.stringify({
        ...line,
        series: Array.from({ length: 13 }, (_, i) => ({ name: `S${i}`, values: [1, 2, 3] })),
      }),
    ],
    ['a missing value', JSON.stringify({ ...line, series: [{ name: 'Today', values: [1, 2] }] })],
    [
      'a null value',
      JSON.stringify({ ...line, series: [{ name: 'Today', values: [1, null, 3] }] }),
    ],
    [
      'duplicate series names',
      JSON.stringify({
        ...line,
        series: [
          { name: 'Today', values: [1, 2, 3] },
          { name: 'Today', values: [1, 2, 3] },
        ],
      }),
    ],
    ['a long axis label', JSON.stringify({ ...line, y_label: 'y'.repeat(51) })],
    [
      'a pie with a zero value',
      JSON.stringify({
        type: 'pie',
        title: 'Share',
        categories: ['DE', 'PL'],
        series: [{ name: 'Requests', values: [1, 0] }],
      }),
    ],
    [
      'a pie with two series',
      JSON.stringify({
        type: 'pie',
        title: 'Share',
        categories: ['DE'],
        series: [
          { name: 'A', values: [1] },
          { name: 'B', values: [1] },
        ],
      }),
    ],
  ])('rejects %s', (_, source) => {
    expect(chartBlock(source)).toBeNull();
  });
});

describe('reply parts', () => {
  it('places each chart where its fence was, between Markdown blocks', () => {
    const text = `Traffic is up.\n\n${fence(line)}\n\nDE is flat.`;
    expect(replyBlocks(text, 'Done')).toEqual([
      { type: 'markdown', text: 'Traffic is up.' },
      chartBlock(JSON.stringify(line)),
      { type: 'markdown', text: 'DE is flat.' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Done' }] },
    ]);
  });

  it('keeps an answer without charts as one Markdown block', () => {
    const text = 'Plain answer.\n\n```js\nconst x = 1;\n```';
    expect(replyBlocks(text)).toEqual([{ type: 'markdown', text }]);
  });

  it('replaces an invalid chart and every chart after the second with a note', () => {
    const text = [fence(line), fence({ ...line, type: 'radar' }), fence(line), fence(line)].join(
      '\n\n',
    );
    const parts = replyParts(text);
    expect(parts.map((p) => (p.kind === 'chart' ? 'chart' : p.text))).toEqual([
      'chart',
      CHART_NOT_SHOWN,
      'chart',
      CHART_NOT_SHOWN,
    ]);
  });

  it('reads a posted chart back as its title', () => {
    const text = `Traffic is up.

${fence(line)}`;
    expect(flattenOwnAnswer({ text: 'Traffic is up.', blocks: replyBlocks(text) })).toBe(
      'Traffic is up.
[Chart: PDP requests per hour (M)]',
    );
  });
});

describe('posting charts', () => {
  const delivery = { operationId: 'out-chart', revision: 1, answer: true };
  const text = `Traffic is up.\n\n${fence(line)}`;

  it('names the chart in the notification text instead of its JSON', async () => {
    const post = vi.fn(async (_args: unknown) => ({ ok: true, message: { ts: '1.1' } }));
    const webClient = { chat: { postMessage: post } } as unknown as WebClient;
    await postMessage(
      { webClient, botUserId: 'UBOT' },
      { channel: 'C1', thread_ts: '1.0', text, delivery },
    );
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      text: 'Traffic is up.\n\n[Chart: PDP requests per hour (M)]',
    });
  });

  it('posts once more without charts when Slack rejects the blocks', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } }),
      )
      .mockResolvedValueOnce({ ok: true, message: { ts: '1.2' } });
    const webClient = { chat: { postMessage: post } } as unknown as WebClient;
    const result = await postMessage(
      { webClient, botUserId: 'UBOT' },
      { channel: 'C1', thread_ts: '1.0', text, delivery },
    );
    expect(result.ts).toBe('1.2');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toMatchObject({
      text: `Traffic is up.\n\n${CHART_NOT_SHOWN}`,
      blocks: [{ type: 'markdown', text: `Traffic is up.\n\n${CHART_NOT_SHOWN}` }],
    });
  });

  it('never posts again for other failures or answers without charts', async () => {
    for (const [answer, error] of [
      [text, 'not_in_channel'],
      ['No chart.', 'invalid_blocks'],
    ] as const) {
      const post = vi.fn(async () => {
        throw Object.assign(new Error(error), { data: { error } });
      });
      const webClient = { chat: { postMessage: post } } as unknown as WebClient;
      await expect(
        postMessage(
          { webClient, botUserId: 'UBOT' },
          { channel: 'C1', thread_ts: '1.0', text: answer, delivery },
        ),
      ).rejects.toMatchObject({ failure: { kind: 'definite' } });
      expect(post).toHaveBeenCalledOnce();
    }
  });
});
