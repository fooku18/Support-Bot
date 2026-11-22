import { modelConversationIdentity, type ResolvedModel } from '../../contracts/model-catalog.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { IdentityRow } from '../../application/agent-options.js';
import { digest, fail } from '../../application/agent-support.js';
import type { NativeInputReceipt } from '../../domain/files/native-inputs.js';

/** Explicit fresh-store provisioning. Only identity/input provenance, admission, publication and delivery effects
 * belong to this application schema. No execution snapshots or transcript tables. */
export async function provisionNativeAgents(pool: Pool) {
  await pool.query(`CREATE SCHEMA native_agents;
    CREATE TABLE native_agents.tasks (task_key text PRIMARY KEY, owner uuid NOT NULL);
    CREATE TABLE native_agents.requests (
      run_id uuid PRIMARY KEY, task_key text NOT NULL, event_id text NOT NULL,
      owner uuid NOT NULL, accepted jsonb NOT NULL, execution_policy_hash text NOT NULL,
      input_receipts jsonb NOT NULL DEFAULT '[]',
      UNIQUE(task_key,event_id));
    CREATE TABLE native_agents.actions (
      run_id uuid NOT NULL REFERENCES native_agents.requests, action text NOT NULL,
      actor text NOT NULL, answer_hash text, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(run_id,action));
    CREATE TABLE native_agents.deliveries (
      run_id uuid PRIMARY KEY REFERENCES native_agents.requests,
      operation_id uuid NOT NULL UNIQUE, text text NOT NULL, sha256 text NOT NULL,
      bytes integer NOT NULL, outcome text NOT NULL, slack_ts text);
    CREATE TABLE native_agents.publications (
      task_key text NOT NULL, run_id uuid NOT NULL REFERENCES native_agents.requests,
      project text NOT NULL, outcome text NOT NULL, evidence jsonb,
      PRIMARY KEY(run_id,project));
    CREATE TABLE native_agents.exports (
      id text PRIMARY KEY, run_id uuid NOT NULL REFERENCES native_agents.requests,
      path text NOT NULL, name text NOT NULL, sha256 text NOT NULL,
      content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 2097152),
      receipt jsonb, UNIQUE(run_id,path));`);
}

/** Application receipts and segment leases only. Framework execution stays in Mastra.
 * The caller retains the advisory-lock connection across admission and execution. */
export function createNativeAgentStorage(pool: Pool) {
  let taskLeases = 0;
  async function taskLock(taskKey: string, globalLimit: number) {
    // Reserve synchronously, before awaiting a connection or changing owner or
    // request rows. A refused event stays retryable; no queue is created.
    const limit = Math.min(globalLimit, (pool.options.max ?? 10) - 3);
    if (taskLeases >= limit) fail('native_capacity');
    taskLeases++;
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      const held = (
        await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,1152)) AS held', [
          taskKey,
        ])
      ).rows[0]?.held;
      if (!held) fail('task_busy');
      return client;
    } catch (error) {
      client?.release();
      taskLeases--;
      throw error;
    }
  }
  async function unlock(client: PoolClient, taskKey: string) {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,1152))', [taskKey]);
    } finally {
      client.release();
      taskLeases--;
    }
  }
  async function row(runId: string, actor: string, owner: string) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) fail('invalid_run');
    const r = (
      await pool.query<IdentityRow>('SELECT * FROM native_agents.requests WHERE run_id=$1', [runId])
    ).rows[0];
    if (!r || r.accepted.userId !== actor || r.owner !== owner) fail('stale_or_wrong_owner');
    return r;
  }
  async function stopped(r: IdentityRow) {
    const found = await pool.query(
      "SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='cancel'",
      [r.run_id],
    );
    if (found.rowCount) fail('cancelled_no_replay');
  }
  async function admit(r: IdentityRow, action: string, answer?: string) {
    const admitted = await pool.query(
      `INSERT INTO native_agents.actions(run_id,action,actor,answer_hash)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING action`,
      [r.run_id, action, r.accepted.userId, answer === undefined ? null : digest(answer)],
    );
    if (!admitted.rowCount) fail('already_admitted_do_not_replay');
  }
  /** Records the model key a run executes with, once, before its first segment
   * is admitted. A resume keeps the first record: it runs only under the
   * accepted execution policy, which covers the model. */
  async function recordModel(r: IdentityRow, model: ResolvedModel) {
    await pool.query(
      'INSERT INTO native_agents.actions(run_id,action,actor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [r.run_id, `model:${model.key}`, r.accepted.userId],
    );
    const prefix = `model-conversation:${digest(JSON.stringify(modelConversationIdentity(model)))}:`;
    async function epochResult(action: string) {
      const [epoch, marker] = action.slice(prefix.length).split(':');
      if (!epoch) fail('execution_policy_changed_start_fresh');
      if (marker !== 'changed') return { epoch, changed: false };
      // Keep the notice pending across suspension and failed first attempts,
      // until a completed reply in the epoch has retained it.
      const { rowCount } = await pool.query(
        `SELECT 1 FROM native_agents.requests r
         JOIN native_agents.actions a ON a.run_id=r.run_id AND a.action=$2
         JOIN native_agents.deliveries d ON d.run_id=r.run_id
         WHERE r.task_key=$1 LIMIT 1`,
        [r.task_key, action],
      );
      return { epoch, changed: !rowCount };
    }
    const existing = await pool.query<{ action: string }>(
      "SELECT action FROM native_agents.actions WHERE run_id=$1 AND action LIKE 'model-conversation:%'",
      [r.run_id],
    );
    const action = existing.rows[0]?.action;
    if (action) {
      if (!action.startsWith(prefix)) fail('execution_policy_changed_start_fresh');
      return epochResult(action);
    }
    const previous = await pool.query<{ action: string }>(
      `SELECT a.action FROM native_agents.requests r
       JOIN native_agents.actions a ON a.run_id=r.run_id
       WHERE r.task_key=$1 AND r.run_id<>$2 AND
             (a.action LIKE 'model-conversation:%' OR (a.action LIKE 'model:%' AND
               NOT EXISTS (SELECT 1 FROM native_agents.actions m WHERE m.run_id=r.run_id AND m.action LIKE 'model-conversation:%')))
       ORDER BY a.created_at DESC LIMIT 1`,
      [r.task_key, r.run_id],
    );
    const last = previous.rows[0]?.action;
    const sameConversation = last?.startsWith(prefix) ?? false;
    const nextAction = sameConversation ? last! : prefix + r.run_id + (last ? ':changed' : '');
    await pool.query('INSERT INTO native_agents.actions(run_id,action,actor) VALUES($1,$2,$3)', [
      r.run_id,
      nextAction,
      r.accepted.userId,
    ]);
    return epochResult(nextAction);
  }
  /** The model key a run executed with; the answer footer names it. A run
   * refused before execution has none. */
  async function runModel(r: IdentityRow): Promise<string | undefined> {
    const found = await pool.query<{ action: string }>(
      "SELECT action FROM native_agents.actions WHERE run_id=$1 AND action LIKE 'model:%'",
      [r.run_id],
    );
    return found.rows[0]?.action.slice('model:'.length);
  }
  async function inputReceipts(r: IdentityRow): Promise<NativeInputReceipt[]> {
    // Delivery can still expose legacy answers, and the coding Workspace keeps
    // original files across model conversations. Effect authorization checks
    // every retained source. Admission keeps the original task-wide bound.
    const rows = await pool.query<{ input_receipts: NativeInputReceipt[] }>(
      "SELECT input_receipts FROM native_agents.requests WHERE task_key=$1 AND input_receipts <> '[]'::jsonb",
      [r.task_key],
    );
    const bySource = new Map<string, NativeInputReceipt>();
    for (const receipt of rows.rows.flatMap((row) => row.input_receipts)) {
      const key = `${receipt.file.id}:${receipt.file.sourceTs}`;
      const prior = bySource.get(key);
      if (
        prior &&
        (prior.sha256 !== receipt.sha256 || prior.file.revision !== receipt.file.revision)
      )
        fail('input_provenance_changed_start_fresh_thread');
      bySource.set(key, receipt);
    }
    return [...bySource.values()];
  }
  async function sequence(r: IdentityRow) {
    const result = await pool.query(
      'SELECT count(*)::int AS n FROM native_agents.requests WHERE task_key=$1',
      [r.task_key],
    );
    return result.rows[0].n as number;
  }
  async function publicationReceipts(r: IdentityRow) {
    return (
      await pool.query(
        "SELECT run_id,project,outcome,evidence FROM native_agents.publications WHERE task_key=$1 AND (run_id=$2 OR outcome='uncertain') ORDER BY run_id,project",
        [r.task_key, r.run_id],
      )
    ).rows;
  }
  async function retain(r: IdentityRow, text: string) {
    await pool.query(
      `INSERT INTO native_agents.deliveries VALUES($1,$2,$3,$4,$5,'retained',NULL)
      ON CONFLICT DO NOTHING`,
      [r.run_id, randomUUID(), text, digest(text), Buffer.byteLength(text)],
    );
  }
  return {
    taskLock,
    unlock,
    row,
    stopped,
    admit,
    recordModel,
    runModel,
    inputReceipts,
    sequence,
    publicationReceipts,
    retain,
  };
}
