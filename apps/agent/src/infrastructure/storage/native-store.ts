import type { Pool } from 'pg';
import { PostgresStore } from '@mastra/pg';
import { provisionNativeAgents } from './agent-storage.js';

export const NATIVE_STORAGE_VERSION = 'coding-application@2';

export function nativeStore(pool: Pool, provision = false) {
  return new PostgresStore({
    id: 'native-answer',
    pool,
    schemaName: 'framework',
    disableInit: !provision,
  });
}

/** Explicit maintenance identity, dedicated fresh database only. Never called by startup.
 * No adoption, migrations or reset of coordinator/native qualification stores. */
export async function provisionNativeApplication(pool: Pool) {
  const identity = (await pool.query('SELECT current_user, current_database() AS db')).rows[0];
  if (identity.current_user !== 'postgres' || identity.db !== 'native_answer')
    throw new Error('explicit native maintenance identity required');
  const existing = await pool.query(
    "SELECT 1 FROM pg_namespace WHERE nspname IN ('framework','native_agents','coordinator')",
  );
  if (existing.rowCount) throw new Error('native provisioning refuses existing schemas');
  await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const storage = nativeStore(pool, true);
  await storage.init();
  await provisionNativeAgents(pool);
  const seal = JSON.stringify({ version: NATIVE_STORAGE_VERSION });
  const comment = (
    await pool.query("SELECT format('COMMENT ON SCHEMA native_agents IS %L', $1::text) AS sql", [
      seal,
    ])
  ).rows[0].sql;
  await pool.query(comment);
  await pool.query(`
    GRANT CONNECT ON DATABASE native_answer TO native_answer;
    GRANT USAGE ON SCHEMA framework,native_agents TO native_answer;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA framework TO native_answer;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA framework TO native_answer;
    GRANT SELECT ON ALL TABLES IN SCHEMA native_agents TO native_answer;
    GRANT INSERT,UPDATE(owner) ON native_agents.tasks TO native_answer;
    GRANT INSERT,UPDATE(input_receipts) ON native_agents.requests TO native_answer;
    GRANT INSERT ON native_agents.actions TO native_answer;
    GRANT INSERT,UPDATE(outcome,slack_ts) ON native_agents.deliveries TO native_answer;
  `);
}

/** Runtime has DML on an already provisioned store, never framework DDL privileges. */
export async function checkNativeStorage(pool: Pool) {
  const r = (
    await pool.query(`SELECT current_user, current_database() AS db,
    rolsuper,rolcreatedb,rolcreaterole,rolreplication,
    has_database_privilege(current_user,current_database(),'CREATE') AS db_create,
    has_schema_privilege(current_user,'framework','CREATE') AS framework_create,
    has_schema_privilege(current_user,'native_agents','CREATE') AS app_create,
    has_schema_privilege(current_user,'public','CREATE') AS public_create,
    obj_description('native_agents'::regnamespace,'pg_namespace') AS seal
    FROM pg_roles WHERE rolname=current_user`)
  ).rows[0];
  if (
    r.current_user !== 'native_answer' ||
    r.db !== 'native_answer' ||
    r.rolsuper ||
    r.rolcreatedb ||
    r.rolcreaterole ||
    r.rolreplication ||
    r.db_create ||
    r.framework_create ||
    r.app_create ||
    r.public_create ||
    r.seal !== JSON.stringify({ version: NATIVE_STORAGE_VERSION })
  )
    throw new Error('native storage identity, grants or seal refused');
  await pool.query('SELECT run_id,input_receipts FROM native_agents.requests LIMIT 0');
  await pool.query('SELECT operation_id,outcome FROM native_agents.deliveries LIMIT 0');
  const storage = nativeStore(pool);
  const workflows = await storage.getStore('workflows');
  if (!workflows) throw new Error('native framework storage unavailable');
  await workflows.getWorkflowRunById({ runId: '00000000-0000-4000-8000-000000000000' });
}
