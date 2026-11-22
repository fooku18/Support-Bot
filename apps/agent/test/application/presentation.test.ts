import { describe, expect, it, vi } from 'vitest';
import { createNativeAgentDelivery } from '../../src/application/agent-delivery.js';
import type { NativeAgentOptions, NativeAgentSender } from '../../src/application/agent-options.js';
import { CoordinatorError } from '../../src/application/errors.js';

const runId = '00000000-0000-4000-8000-000000000301';
const owner = '00000000-0000-4000-8000-000000000302';

/** Presentation of a run without a retained answer; inspection is scripted. */
function fixture(
  inspection: { active: boolean; suspended?: { question: string; toolCallId: string } },
  policyCurrent: () => Promise<boolean> = async () => true,
) {
  const actions: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='cancel'"))
      return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT 1 FROM native_agents.deliveries WHERE run_id=$1'))
      return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO native_agents.actions')) {
      actions.push(params);
      return { rows: [{ action: params[1] }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const row = {
    run_id: runId,
    task_key: 'task-301',
    owner,
    accepted: { channelId: 'CCHAN', rootTs: '1794866400.000301', userId: 'UOWNER' },
  };
  const service = createNativeAgentDelivery(
    { pool: { query }, log } as unknown as NativeAgentOptions,
    { row: async () => row, admit: async () => {}, runModel: async () => 'fixture' } as never,
    {
      authorize: async () => ({}),
      recipient: async () => ({}),
      policyCurrent,
    } as never,
    {
      track: (work) => work,
      result: async () => {
        throw new CoordinatorError(409, 'input_provenance_changed_start_fresh_thread');
      },
      inspect: async () => ({ delivery: null, actions: [], ...inspection }) as never,
    },
  );
  return { service, actions, log };
}

describe('native presentation', () => {
  it('never posts the failure notice for a run that still executes', async () => {
    const f = fixture({ active: true });
    const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000400' }));
    await expect(f.service.present(runId, 'UOWNER', owner, send)).rejects.toMatchObject({
      code: 'native_run_still_active',
    });
    expect(send).not.toHaveBeenCalled();
    expect(f.actions).toEqual([]);
  });

  it('logs the refused result and the failure notice it posts instead', async () => {
    const f = fixture({ active: false });
    const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000400' }));
    expect(await f.service.present(runId, 'UOWNER', owner, send)).toEqual({
      notice: 'notice:failure',
      outcome: 'delivered',
    });
    expect(f.log.warn.mock.calls.map(([m]) => m)).toEqual([
      `native presentation result refused run_id=${runId} reason=input_provenance_changed_start_fresh_thread`,
      `native failure notice run_id=${runId}; no retained answer`,
    ]);
  });

  it('logs an unconfirmed notice with the error class only', async () => {
    const f = fixture({ active: false });
    const send = vi.fn<NativeAgentSender>(async () => {
      throw new TypeError('https://slack.example/secret-url');
    });
    expect(await f.service.present(runId, 'UOWNER', owner, send)).toEqual({
      notice: 'notice:failure',
      outcome: 'uncertain',
    });
    const lines = f.log.warn.mock.calls.map(([m]) => m).join('\n');
    expect(lines).toContain(
      `native notice unconfirmed run_id=${runId} notice=notice:failure reason=TypeError`,
    );
    expect(lines).not.toContain('slack.example');
  });

  it('posts the failure notice when the run was refused for a changed channel policy', async () => {
    const f = fixture({ active: false }, async () => false);
    const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000400' }));
    expect(await f.service.present(runId, 'UOWNER', owner, send)).toEqual({
      notice: 'notice:failure',
      outcome: 'delivered',
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('withdraws a question whose continue the changed settings would refuse', async () => {
    const question = { question: 'Which?', toolCallId: 'call-1' };
    // Unchanged settings: the question is posted and can be continued.
    const kept = fixture({ active: false, suspended: question });
    const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000400' }));
    expect(await kept.service.present(runId, 'UOWNER', owner, send)).toEqual({
      notice: 'notice:question:call-1',
      outcome: 'delivered',
    });
    expect(send.mock.calls[0]![0].text).toContain('continue <answer>');
    // Changed settings: a continue would be refused, so the user never waits
    // on the question; the failure notice asks for a fresh request.
    const changed = fixture({ active: false, suspended: question }, async () => false);
    expect(await changed.service.present(runId, 'UOWNER', owner, send)).toEqual({
      notice: 'notice:failure',
      outcome: 'delivered',
    });
    expect(send.mock.calls[1]![0].text).toMatch(/^No confirmed answer\./);
    expect(send.mock.calls[1]![0].text).not.toContain('Which?');
    expect(changed.actions.map((a) => a[1])).toEqual(['notice:failure']);
    expect(changed.log.warn.mock.calls.map(([m]) => m)).toContain(
      `native failure notice run_id=${runId}; question withdrawn reason=execution_policy_changed_start_fresh`,
    );
  });
});
