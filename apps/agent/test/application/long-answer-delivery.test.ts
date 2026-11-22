import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNativeAgentDelivery } from '../../src/application/agent-delivery.js';
import type { NativeAgentOptions, NativeAgentSender } from '../../src/application/agent-options.js';
import { longAnswerNotice, SLACK_MARKDOWN_CHARS } from '../../src/domain/delivery/long-answer.js';

const runId = '00000000-0000-4000-8000-000000000201';
const owner = '00000000-0000-4000-8000-000000000202';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const long = Array.from(
  { length: 450 },
  (_, i) => `Line ${String(i + 1).padStart(5, '0')} of the long answer.`,
).join('\n');

/** A retained delivery and the SQL the delivery boundary issues, nothing else. */
function fixture(text: string) {
  const delivery = {
    run_id: runId,
    operation_id: '00000000-0000-4000-8000-000000000203',
    text,
    sha256: sha(text),
    bytes: Buffer.byteLength(text),
    outcome: 'retained',
  };
  const actions: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SET outcome='uncertain'")) {
      if (delivery.outcome !== 'retained') return { rows: [], rowCount: 0 };
      delivery.outcome = 'uncertain';
      return { rows: [delivery], rowCount: 1 };
    }
    if (sql.includes("SET outcome='delivered'")) {
      delivery.outcome = 'delivered';
      return { rows: [{ run_id: runId }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id,name,sha256,content FROM native_agents.exports'))
      return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO native_agents.actions')) {
      actions.push(params);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const row = {
    run_id: runId,
    task_key: 'task-201',
    owner,
    accepted: { channelId: 'CCHAN', rootTs: '1794866400.000201', userId: 'UOWNER' },
  };
  const service = createNativeAgentDelivery(
    { pool: { query }, log: { info() {}, warn() {}, error() {} } } as unknown as NativeAgentOptions,
    { row: async () => row, admit: async () => {}, runModel: async () => 'fixture' } as never,
    {
      authorize: async () => ({}),
      recipient: async () => ({}),
      policyCurrent: async () => true,
    } as never,
    {
      track: (work) => work,
      result: async () => undefined,
      inspect: async () => ({ delivery: null, suspended: undefined, actions: [], active: false }),
    },
  );
  return { service, delivery, actions };
}

describe('long answer delivery', () => {
  it('sends an answer within the limit whole, without a file or export authority', async () => {
    const f = fixture('Short answer.');
    const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000300' }));
    const result = await f.service.deliver(runId, 'UOWNER', owner, send);
    expect(result.outcome).toBe('delivered');
    expect(send).toHaveBeenCalledOnce();
    const value = send.mock.calls[0]![0];
    expect(value.text).toBe('Short answer.');
    expect(value).not.toHaveProperty('answerFile');
    expect(value).not.toHaveProperty('authority');
    expect(f.actions).toEqual([]);
  });

  it('sends a preview and the full answer file in one delivery and records the file', async () => {
    const f = fixture(long);
    expect(long.length).toBeGreaterThan(SLACK_MARKDOWN_CHARS);
    const send = vi.fn<NativeAgentSender>(async (value) => ({
      ts: '1794866400.000300',
      answerFile: {
        attached: true,
        fileId: 'F0ANSWER',
        permalink: 'https://slack.com/files/F0ANSWER',
        sha256: value.answerFile!.sha256,
        bytes: value.answerFile!.bytes,
      },
    }));
    const result = await f.service.deliver(runId, 'UOWNER', owner, send);
    expect(result.outcome).toBe('delivered');
    const value = send.mock.calls[0]![0];
    expect(long.startsWith(value.text)).toBe(true);
    expect(value.text.length).toBeLessThanOrEqual(3_000);
    expect(value.answerFile).toMatchObject({ name: 'answer.md', sha256: f.delivery.sha256 });
    expect(Buffer.from(value.answerFile!.data, 'base64').toString('utf8')).toBe(long);
    expect(value.authority).toEqual({ runId, actor: 'UOWNER', owner });
    expect(f.actions).toEqual([[runId, 'answer-file:F0ANSWER', 'UOWNER', f.delivery.sha256]]);
  });

  it('still confirms the preview when the file was not attached and records that', async () => {
    const f = fixture(long);
    const send = vi.fn<NativeAgentSender>(async () => ({
      ts: '1794866400.000300',
      answerFile: { attached: false },
    }));
    expect((await f.service.deliver(runId, 'UOWNER', owner, send)).outcome).toBe('delivered');
    expect(f.actions).toEqual([[runId, 'answer-file:unattached', 'UOWNER', f.delivery.sha256]]);
    // A mismatched file receipt counts as not attached.
    const g = fixture(long);
    const wrong = vi.fn<NativeAgentSender>(async () => ({
      ts: '1794866400.000300',
      answerFile: {
        attached: true,
        fileId: 'F0ANSWER',
        permalink: 'https://slack.com/files/F0ANSWER',
        sha256: '0'.repeat(64),
        bytes: 1,
      },
    }));
    await g.service.deliver(runId, 'UOWNER', owner, wrong);
    expect(g.actions).toEqual([[runId, 'answer-file:unattached', 'UOWNER', g.delivery.sha256]]);
    expect(longAnswerNotice(false)).toContain('could not be attached');
  });

  it('keeps an unknown transport outcome uncertain and never sends again', async () => {
    const f = fixture(long);
    const send = vi.fn<NativeAgentSender>(async () => {
      throw new Error('adapter outcome unknown');
    });
    expect(await f.service.deliver(runId, 'UOWNER', owner, send)).toMatchObject({
      outcome: 'uncertain',
    });
    expect(f.delivery.outcome).toBe('uncertain');
    expect(await f.service.deliver(runId, 'UOWNER', owner, send)).toMatchObject({
      duplicate: true,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(f.actions).toEqual([]);
  });
});
