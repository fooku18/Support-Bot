import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNativeAgentDelivery } from '../../src/application/agent-delivery.js';
import type { NativeAgentOptions, NativeAgentSender } from '../../src/application/agent-options.js';
import { CoordinatorError } from '../../src/application/errors.js';

const runId = '00000000-0000-4000-8000-000000000501';
const owner = '00000000-0000-4000-8000-000000000502';
const text = 'Answer under the accepted settings.';

/** A retained answer. `recipient` scripts the current authorization per call
 * (1: before admission, 2: after admission, 3: after the send); `changed` says
 * whether the channel's settings differ from the run's accepted ones. */
function fixture(options: { changed?: boolean; recipient?: (call: number) => Promise<unknown> }) {
  const delivery = {
    run_id: runId,
    operation_id: '00000000-0000-4000-8000-000000000503',
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    outcome: 'retained',
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='cancel'"))
      return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT 1 FROM native_agents.deliveries WHERE run_id=$1'))
      return { rows: [{}], rowCount: 1 };
    const transition =
      /SET outcome='(\w+)'(?:,slack_ts=\$2)?\s+WHERE run_id=\$1 AND outcome=(?:'(\w+)'|\$2)/.exec(
        sql,
      );
    if (transition) {
      const from = transition[2] ?? params[1];
      if (delivery.outcome !== from) return { rows: [], rowCount: 0 };
      delivery.outcome = transition[1]!;
      return { rows: [delivery], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id,name,sha256,content FROM native_agents.exports'))
      return { rows: [], rowCount: 0 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const row = {
    run_id: runId,
    task_key: 'task-501',
    owner,
    accepted: { channelId: 'CCHAN', rootTs: '1794866400.000501', userId: 'UOWNER' },
  };
  let calls = 0;
  const service = createNativeAgentDelivery(
    { pool: { query }, log } as unknown as NativeAgentOptions,
    // The run executed with `alt`; the channel's current model is irrelevant.
    { row: async () => row, admit: async () => {}, runModel: async () => 'alt' } as never,
    {
      authorize: async () => ({}),
      recipient: async () => {
        calls++;
        return (await options.recipient?.(calls)) ?? {};
      },
      policyCurrent: async () => !options.changed,
    } as never,
    {
      track: (work) => work,
      result: async () => {
        throw new CoordinatorError(409, 'authorization_revoked');
      },
      inspect: async () => {
        // Inspection refuses a revoked recipient; delivery must still decide.
        throw new CoordinatorError(409, 'authorization_revoked');
      },
    },
  );
  return { service, delivery, log };
}
const sent = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000600' }));
const revoked = (code: string) => async () => {
  throw new CoordinatorError(409, code);
};

describe('delivery after a settings change or an authorization change', () => {
  it('delivers under the accepted settings with the run model, logged once', async () => {
    const f = fixture({ changed: true });
    const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000600' }));
    expect(await f.service.deliver(runId, 'UOWNER', owner, send)).toMatchObject({
      outcome: 'delivered',
    });
    expect(f.delivery.outcome).toBe('delivered');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ text, footer: '✅ Done · Model: *alt*' });
    expect(f.log.info.mock.calls).toEqual([
      [`native delivery policy_changed_delivered run_id=${runId}`],
    ]);
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it('logs nothing for unchanged settings', async () => {
    const f = fixture({});
    expect((await f.service.deliver(runId, 'UOWNER', owner, sent)).outcome).toBe('delivered');
    expect(f.log.info).not.toHaveBeenCalled();
  });

  for (const code of ['authorization_revoked', 'origin_revoked', 'stale_owner'])
    it(`withholds the answer for good when authorization is refused (${code})`, async () => {
      const f = fixture({ changed: true, recipient: revoked(code) });
      const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000600' }));
      // Presentation reaches delivery although inspection refuses the recipient.
      expect(await f.service.present(runId, 'UOWNER', owner, send)).toEqual({
        outcome: 'withheld',
        reason: code,
      });
      expect(send).not.toHaveBeenCalled();
      // Terminal: no longer retained, so it neither delivers later nor keeps
      // the instance busy.
      expect(f.delivery.outcome).toBe('withheld');
      expect(f.log.warn.mock.calls).toEqual([
        [`native presentation result refused run_id=${runId} reason=authorization_revoked`],
        [`native delivery withheld run_id=${runId} reason=${code}`],
      ]);
      expect(f.log.info).not.toHaveBeenCalled();
    });

  it('withholds when authorization is refused between admission and the send', async () => {
    const f = fixture({
      recipient: async (call) => {
        if (call === 2) throw new CoordinatorError(409, 'authorization_revoked');
      },
    });
    const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000600' }));
    expect(await f.service.deliver(runId, 'UOWNER', owner, send)).toEqual({
      outcome: 'withheld',
      operationId: f.delivery.operation_id,
      reason: 'authorization_revoked',
    });
    expect(send).not.toHaveBeenCalled();
    expect(f.delivery.outcome).toBe('withheld');
  });

  it('keeps the answer retained when the check fails without a decision', async () => {
    for (const call of [1, 2]) {
      const f = fixture({
        recipient: async (n) => {
          if (n === call) throw new TypeError('https://adapter.example/unavailable');
        },
      });
      await expect(f.service.deliver(runId, 'UOWNER', owner, sent)).rejects.toThrow(TypeError);
      expect(f.delivery.outcome).toBe('retained');
      expect(f.log.warn.mock.calls).toEqual([
        [`native delivery refused run_id=${runId} reason=TypeError`],
      ]);
    }
  });

  it('keeps a revocation after the send uncertain and never sends again', async () => {
    const f = fixture({
      recipient: async (call) => {
        if (call === 3) throw new CoordinatorError(409, 'authorization_revoked');
      },
    });
    const send = vi.fn<NativeAgentSender>(async () => ({ ts: '1794866400.000600' }));
    expect((await f.service.deliver(runId, 'UOWNER', owner, send)).outcome).toBe('uncertain');
    expect(f.delivery.outcome).toBe('uncertain');
    expect(send).toHaveBeenCalledOnce();
  });
});
