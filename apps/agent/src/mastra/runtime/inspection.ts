import { DurableStepIds } from '@mastra/core/agent/durable';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';
import type { Pool } from 'pg';

type NativeRunStorage = Pick<MastraCompositeStore, 'getStore'>;

/** Inert persisted inspection, including from a cold process. No Agent/runtime,
 * model, tools, subscriptions, recovery or writes are constructed here.
 *
 * core@1.83.0 has no DurableAgent.getRun(). getWorkflow().getWorkflowRunById()
 * returns processed WorkflowState rather than the raw WorkflowRun exposed by
 * this service. listSuspendedRuns() only returns suspended runs; absence cannot
 * distinguish unknown, running or terminal state. observe() subscribes to the
 * replay cache and hydrates messages/processors, and cannot recover a question
 * from a cleared cache. None replaces this service's full inspection contract.
 *
 * Keep the public storage read and raw return shape; the only snapshot decoding
 * below is the persisted status and top-level ask_user projection. See the pinned
 * public API regression tests before changing this boundary on a core upgrade.
 * https://mastra.ai/reference/agents/durable-agent
 * https://mastra.ai/docs/agents/human-in-the-loop
 */
export async function readNativeRun(storage: NativeRunStorage, runId: string) {
  const workflows = await storage.getStore('workflows');
  const native = await workflows?.getWorkflowRunById({
    runId,
    workflowName: DurableStepIds.AGENTIC_LOOP,
  });
  const snapshot: WorkflowRunState | undefined =
    typeof native?.snapshot === 'string' ? JSON.parse(native.snapshot) : native?.snapshot;
  return {
    native,
    status: snapshot?.status,
    suspended: nativeSuspension(snapshot),
    mayBeInterrupted: !snapshot || snapshot.status === 'running',
  };
}

/** Read-only operational projection; application receipts retain cancellation
 * and ambiguous delivery truth independently of framework execution snapshots. */
export async function nativeAgentOperations({
  pool,
  storage,
  active,
  state,
}: {
  pool: Pick<Pool, 'query'>;
  storage: NativeRunStorage;
  active: ReadonlyMap<string, unknown>;
  state(): { admitted: number; accepting: boolean };
}) {
  const current = (
    await pool.query<{ run_id: string; task_key: string }>(
      'SELECT r.* FROM native_agents.tasks t JOIN native_agents.requests r ON r.task_key=t.task_key AND r.owner=t.owner',
    )
  ).rows;
  const waits: Array<{ taskKey: string; runId: string }> = [];
  let interrupted = 0;
  for (const r of current) {
    const { status, mayBeInterrupted } = await readNativeRun(storage, r.run_id);
    const canceled = (
      await pool.query("SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='cancel'", [
        r.run_id,
      ])
    ).rowCount;
    if (!canceled && status === 'suspended') waits.push({ taskKey: r.task_key, runId: r.run_id });
    const completed = (
      await pool.query('SELECT 1 FROM native_agents.deliveries WHERE run_id=$1', [r.run_id])
    ).rowCount;
    if (!canceled && !completed && !active.has(r.run_id) && mayBeInterrupted) interrupted++;
  }
  const ambiguous = Number(
    (await pool.query("SELECT count(*) FROM native_agents.deliveries WHERE outcome='uncertain'"))
      .rows[0].count,
  );
  const undelivered = Number(
    (await pool.query("SELECT count(*) FROM native_agents.deliveries WHERE outcome='retained'"))
      .rows[0].count,
  );
  const unknownNotices = Number(
    (
      await pool.query(
        "SELECT count(*) FROM native_agents.actions a WHERE a.action LIKE 'notice:%' AND NOT EXISTS (SELECT 1 FROM native_agents.actions ack WHERE ack.run_id=a.run_id AND ack.action='ack:'||a.action)",
      )
    ).rows[0].count,
  );
  const { admitted, accepting } = state();
  return {
    undelivered,
    unknownNotices,
    runtime: 'native-answer',
    accepting,
    admitted,
    active: [...active.keys()],
    waits,
    interrupted,
    ambiguous,
    idle:
      admitted === 0 &&
      active.size === 0 &&
      ambiguous === 0 &&
      undelivered === 0 &&
      unknownNotices === 0,
  };
}

/** Compatibility decoder for core@1.83.0's persisted top-level suspension.
 * listSuspendedRuns() offers a public tool-call projection but no by-ID raw
 * snapshot projection. Preserve this service's single-record read and existing
 * question contract without constructing an execution agent just to inspect it.
 * Do not walk arbitrary nested steps or infer a question from an old tool call.
 * Framework storage remains the only question state. */
function nativeSuspension(snapshot: WorkflowRunState | undefined) {
  const step = snapshot?.context?.[DurableStepIds.AGENTIC_EXECUTION];
  const payload = step?.suspendPayload;
  if (
    snapshot?.status === 'suspended' &&
    step?.status === 'suspended' &&
    payload?.type === 'suspension' &&
    payload.toolName === 'ask_user' &&
    typeof payload.toolCallId === 'string' &&
    typeof payload.toolCallSuspended?.question === 'string'
  )
    return { toolCallId: payload.toolCallId, question: payload.toolCallSuspended.question };
}
