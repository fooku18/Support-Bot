import { describe, expect, it } from 'vitest';
import {
  flattenMessageContent,
  flattenOwnAnswer,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_OWN_ANSWER_BYTES,
  TRUNCATED_MARKER,
} from '../src/generated/slack-message-content.js';

describe('flattenMessageContent', () => {
  it('flattens an Opsgenie-style alert: short text plus attachment fields', () => {
    const content = flattenMessageContent({
      text: '',
      attachments: [
        {
          fallback: 'New alert: High error rate on checkout',
          color: '#ff0000',
          pretext: 'New alert created',
          title: '#4711: [Datadog] High error rate on checkout',
          title_link: 'https://example.app.opsgenie.com/alert/detail/abc',
          text: 'Error rate is above 5% for service:checkout',
          fields: [
            { title: 'Priority', value: 'P2', short: true },
            { title: 'Tags', value: 'env:prod, team:frontend', short: true },
            { title: 'Source', value: '<https://gitlab.example.com/app|app repository>' },
          ],
          footer: 'Opsgenie',
        },
      ],
    });
    expect(content).toBe(
      [
        'New alert created',
        '#4711: [Datadog] High error rate on checkout (https://example.app.opsgenie.com/alert/detail/abc)',
        'Error rate is above 5% for service:checkout',
        'Priority: P2',
        'Tags: env:prod, team:frontend',
        'Source: <https://gitlab.example.com/app|app repository>',
        'Opsgenie',
      ].join('\n'),
    );
  });

  it('uses the attachment fallback only when the attachment yields nothing else', () => {
    expect(
      flattenMessageContent({ attachments: [{ fallback: 'Only the fallback', color: 'good' }] }),
    ).toBe('Only the fallback');
    expect(
      flattenMessageContent({ attachments: [{ fallback: 'Hidden fallback', text: 'Body' }] }),
    ).toBe('Body');
  });

  it('flattens a GitLab-style post: header, section text and fields, context and rich text', () => {
    const content = flattenMessageContent({
      text: 'Pipeline failed',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Pipeline #991 failed' } },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Project:* <https://gitlab.example.com/g/app|g/app>' },
          fields: [
            { type: 'mrkdwn', text: '*Branch:* main' },
            { type: 'mrkdwn', text: '*Job:* test' },
          ],
          accessory: { type: 'button', text: { type: 'plain_text', text: 'Open' } },
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [
            { type: 'image', image_url: 'https://x/avatar.png', alt_text: 'avatar' },
            { type: 'mrkdwn', text: 'Triggered by' },
            { type: 'plain_text', text: 'alice' },
          ],
        },
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'Failing test: ' },
                { type: 'text', text: 'cart.spec.ts', style: { code: true } },
                { type: 'text', text: ' see ' },
                { type: 'link', url: 'https://gitlab.example.com/g/app/-/jobs/5', text: 'job 5' },
                { type: 'text', text: ' cc ' },
                { type: 'user', user_id: 'U0ALICE' },
                { type: 'text', text: ' in ' },
                { type: 'channel', channel_id: 'C0OPS' },
                { type: 'text', text: ' ' },
                { type: 'emoji', name: 'rotating_light' },
              ],
            },
            {
              type: 'rich_text_list',
              style: 'ordered',
              elements: [
                { type: 'rich_text_section', elements: [{ type: 'text', text: 'rerun' }] },
                { type: 'rich_text_section', elements: [{ type: 'text', text: 'bisect' }] },
              ],
            },
          ],
        },
        { type: 'image', image_url: 'https://x/graph.png', alt_text: 'error rate graph' },
        {
          type: 'actions',
          elements: [{ type: 'button', text: { type: 'plain_text', text: 'x' } }],
        },
      ],
    });
    expect(content).toBe(
      [
        'Pipeline failed',
        'Pipeline #991 failed',
        '*Project:* <https://gitlab.example.com/g/app|g/app>',
        '*Branch:* main',
        '*Job:* test',
        'Triggered by alice',
        'Failing test: cart.spec.ts see job 5 (https://gitlab.example.com/g/app/-/jobs/5) cc <@U0ALICE> in <#C0OPS> :rotating_light:\n1. rerun\n2. bisect',
        'error rate graph',
      ].join('\n'),
    );
  });

  it("skips link unfurls on a person's message", () => {
    expect(
      flattenMessageContent({
        text: 'see <https://news.example.com/a|this article>',
        attachments: [
          {
            from_url: 'https://news.example.com/a',
            title: 'Some article',
            text: 'Preview text of the article',
          },
          { is_msg_unfurl: true, text: 'Quoted Slack message' },
          { is_app_unfurl: true, text: 'App preview' },
        ],
        blocks: [
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [
                  { type: 'text', text: 'see ' },
                  { type: 'link', url: 'https://news.example.com/a', text: 'this article' },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe('see <https://news.example.com/a|this article>');
  });

  it('drops a block that repeats the text (markup, mentions, formatting and entities ignored)', () => {
    expect(
      flattenMessageContent({
        text: 'Deploy *done* for <@U0BOB> &amp; <#C0OPS|ops>: :tada:',
        blocks: [
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [
                  { type: 'text', text: 'Deploy ' },
                  { type: 'text', text: 'done', style: { bold: true } },
                  { type: 'text', text: ' for ' },
                  { type: 'user', user_id: 'U0BOB' },
                  { type: 'text', text: ' & ' },
                  { type: 'channel', channel_id: 'C0OPS' },
                  { type: 'text', text: ': ' },
                  { type: 'emoji', name: 'tada' },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe('Deploy *done* for <@U0BOB> & <#C0OPS|ops>: :tada:');
    // A section block whose text equals the fallback text appears once.
    expect(
      flattenMessageContent({
        text: 'Monitor recovered: checkout latency',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Monitor recovered: checkout latency' },
          },
          { type: 'section', text: { type: 'mrkdwn', text: 'p95 back under 800 ms' } },
        ],
      }),
    ).toBe('Monitor recovered: checkout latency\np95 back under 800 ms');
  });

  it("decodes Slack's HTML entities in a person's text and in mrkdwn, once", () => {
    expect(
      flattenMessageContent({
        text: 'compare a &lt; b &amp;&amp; c &gt; d, literally &amp;lt;',
      }),
    ).toBe('compare a < b && c > d, literally &lt;');
    expect(
      flattenMessageContent({
        text: '',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Map&lt;K, V&gt;' } }],
      }),
    ).toBe('Map<K, V>');
    // Rich text arrives decoded: a literal entity stays as typed.
    expect(
      flattenMessageContent({
        blocks: [
          {
            type: 'rich_text',
            elements: [
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'x &lt; y' }] },
            ],
          },
        ],
      }),
    ).toBe('x &lt; y');
  });

  it('keeps short segments that merely occur inside earlier text', () => {
    expect(
      flattenMessageContent({
        text: 'lookup failed',
        attachments: [{ fields: [{ title: '', value: 'OK' }] }],
      }),
    ).toBe('lookup failed\nOK');
  });

  it('returns an empty string for a message without content', () => {
    expect(flattenMessageContent({})).toBe('');
    expect(flattenMessageContent({ text: '   ', attachments: 'nope', blocks: [null, 3] })).toBe('');
  });

  it('caps the content per message with a truncation marker', () => {
    const content = flattenMessageContent({ text: 'ä'.repeat(MAX_MESSAGE_CONTENT_BYTES) });
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(MAX_MESSAGE_CONTENT_BYTES);
    expect(content.endsWith(`\n${TRUNCATED_MARKER}`)).toBe(true);
    expect(content.startsWith('ää')).toBe(true);
    const small = 'x'.repeat(100);
    expect(flattenMessageContent({ text: small })).toBe(small);
  });
});

describe('flattenOwnAnswer', () => {
  /** A final answer as Slack returns it: rich-text blocks plus the collapsed `text` fallback. */
  const answer = {
    text: 'Fact: hello amber-falcon-3102 Code number: 1591 Steps: • read the file • multiply',
    blocks: [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Fact: hello amber-falcon-3102\nCode number: 1591\nSteps:' },
            ],
          },
          {
            type: 'rich_text_list',
            style: 'bullet',
            elements: [
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'read the file' }] },
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'multiply' }] },
            ],
          },
          {
            type: 'rich_text_preformatted',
            elements: [{ type: 'text', text: 'npm test\nok' }],
          },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '✅ Done · Model: *sonnet*' }],
      },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '👍' } }] },
    ],
  };

  it('keeps line breaks, lists and code blocks and drops the collapsed fallback', () => {
    expect(flattenOwnAnswer(answer)).toBe(
      [
        'Fact: hello amber-falcon-3102',
        'Code number: 1591',
        'Steps:',
        '- read the file',
        '- multiply',
        'npm test',
        'ok',
      ].join('\n'),
    );
  });

  it('never carries the agent footer into context', () => {
    expect(flattenOwnAnswer(answer)).not.toContain('Done');
    expect(flattenOwnAnswer(answer)).not.toContain('Model:');
  });

  it('reads a markdown block as posted, and falls back to text without blocks', () => {
    expect(
      flattenOwnAnswer({
        text: 'Line one Line two',
        blocks: [{ type: 'markdown', text: 'Line one\n\n- Line two' }],
      }),
    ).toBe('Line one\n\n- Line two');
    expect(flattenOwnAnswer({ text: 'plain &lt;answer&gt;' })).toBe('plain <answer>');
  });

  it('reads a long answer whole up to the own-answer cap', () => {
    // 11 900 multi-byte characters (23 800 bytes) exceed the 16 KiB message cap.
    const answer = 'ä'.repeat(11_900);
    expect(Buffer.byteLength(answer, 'utf8')).toBeGreaterThan(MAX_MESSAGE_CONTENT_BYTES);
    expect(flattenOwnAnswer({ text: answer })).toBe(answer);
    expect(flattenOwnAnswer({ blocks: [{ type: 'markdown', text: answer }] })).toBe(answer);
    const capped = flattenOwnAnswer({ text: 'ä'.repeat(MAX_OWN_ANSWER_BYTES) });
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(MAX_OWN_ANSWER_BYTES);
    expect(capped.endsWith(`\n${TRUNCATED_MARKER}`)).toBe(true);
    // Other messages keep the 16 KiB cap.
    const other = flattenMessageContent({ text: answer });
    expect(Buffer.byteLength(other, 'utf8')).toBeLessThanOrEqual(MAX_MESSAGE_CONTENT_BYTES);
  });

  it('ignores the preview text when the blocks carry the answer', () => {
    // Slack returns the markdown block as rich text; its rendering differs
    // from the raw preview (emoji as names), so the preview never matches.
    const message = {
      text: '✅ Item 1: oak …',
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'emoji', name: 'white_check_mark' },
                { type: 'text', text: ' Item 1: oak\nItem 2: pine' },
              ],
            },
          ],
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '✅ Done' }] },
      ],
    };
    expect(flattenOwnAnswer(message)).toBe(':white_check_mark: Item 1: oak\nItem 2: pine');
  });
});
