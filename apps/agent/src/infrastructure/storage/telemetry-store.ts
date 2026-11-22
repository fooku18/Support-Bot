import { postgresTransport } from './postgres-connection.js';
import { readSecret } from '../secret.js';
import { Pool } from 'pg';
import { MastraCompositeStore } from '@mastra/core/storage';
import { studioStore } from './studio-store.js';

export const TELEMETRY_SCHEMA = 'native_observability';
export const TELEMETRY_ROLE = 'native_observability';
const seal = 'support-agent-private-observability@1';

/** Core 1.83's startWorkers() calls init() even with disableInit; unlike the PG
 * adapter, its composite init bypasses that flag and initializes domain DDL.
 * Honor the supported flag at this runtime boundary. Provisioning stays in the
 * separate maintenance process; startup already checks schema/role readiness. */
class RuntimeTelemetryStore extends MastraCompositeStore {
  override async init() {
    if (!this.disableInit) await super.init();
  }
}

/** Official per-domain routing keeps the primary PostgresStore and every
 * application/memory domain unchanged. Only observability uses the separate pool. */
export function withTelemetryStore(
  primary: MastraCompositeStore,
  primaryPool: Pool,
  telemetry: Pool,
) {
  const signals = studioStore(primaryPool, { pool: telemetry, schemaName: TELEMETRY_SCHEMA });
  return new RuntimeTelemetryStore({
    id: 'native-with-private-observability',
    default: primary,
    domains: { observability: signals.stores!.observability! },
    disableInit: true,
  });
}

/** Explicit optional source. Never fall back to primary credentials or an
 * ambient DATABASE_URL; caller owns this separate bounded pool's lifecycle. */
export function telemetryPool(env: NodeJS.ProcessEnv): Pool | undefined {
  const source = env.NATIVE_OBSERVABILITY_SOURCE;
  if (!source || source === 'off') return undefined;
  if (source !== 'native') throw new Error('invalid native observability source');
  if (!env.NATIVE_OBSERVABILITY_HOST) throw new Error('explicit telemetry host required');
  const password = readSecret(env, 'NATIVE_OBSERVABILITY_PASSWORD');
  if (password.length < 24) throw new Error('telemetry secret too short');
  const pool = new Pool({
    host: env.NATIVE_OBSERVABILITY_HOST,
    ...postgresTransport(env, env.NATIVE_OBSERVABILITY_HOST),
    database: 'native_answer',
    user: TELEMETRY_ROLE,
    password,
    max: 2,
    connectionTimeoutMillis: 2000,
    // Acquisition alone does not bound an accepted INSERT waiting on a lock,
    // nor a server/connection that stops responding. These affect only this pool.
    lock_timeout: 1000,
    statement_timeout: 2000,
    query_timeout: 2500,
  });
  // Never let an idle PG error print connection details through EventEmitter.
  pool.on('error', () => console.error('telemetry connection unavailable'));
  return pool;
}

/** Refuse elevated/adopted roles, including indirect memberships. DML is confined
 * to telemetry; native application storage readiness/grants/seal stay unchanged. */
export async function checkTelemetryStorage(pool: Pool) {
  const r = (
    await pool.query(`SELECT current_user, current_database() AS db,
    rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships,
    has_database_privilege(current_user,current_database(),'CREATE') AS db_create,
    has_schema_privilege(current_user,'framework','USAGE') AS framework_usage,
    has_schema_privilege(current_user,'native_agents','USAGE') AS app_usage,
    has_schema_privilege(current_user,'public','CREATE') AS public_create,
    has_schema_privilege(current_user,'native_observability','CREATE') AS telemetry_create,
    has_schema_privilege(current_user,'native_observability','USAGE') AS telemetry_usage,
    obj_description('native_observability'::regnamespace,'pg_namespace') AS seal
    FROM pg_roles WHERE rolname=current_user`)
  ).rows[0];
  if (
    !r ||
    r.current_user !== TELEMETRY_ROLE ||
    r.db !== 'native_answer' ||
    r.rolsuper ||
    r.rolcreatedb ||
    r.rolcreaterole ||
    r.rolreplication ||
    r.rolbypassrls ||
    r.memberships ||
    r.db_create ||
    r.framework_usage ||
    r.app_usage ||
    r.public_create ||
    r.telemetry_create ||
    !r.telemetry_usage ||
    r.seal !== seal
  )
    throw new Error('telemetry identity or schema refused');
  // A missing/unqualified observability domain is a startup failure, not a skip.
  await pool.query('SELECT 1 FROM native_observability.mastra_span_events LIMIT 0');
}

/** Only called by the separate maintenance entrypoint. Official
 * Mastra owns all telemetry DDL and partition maintenance. This never initializes
 * the composite primary domain, or changes application grants/passwords/seals. */
export async function provisionTelemetry(pool: Pool, password: string) {
  const identity = (await pool.query('SELECT current_user, current_database() AS db')).rows[0];
  if (
    identity.current_user !== 'postgres' ||
    identity.db !== 'native_answer' ||
    password.length < 24
  )
    throw new Error('explicit telemetry maintenance identity required');
  await pool.query('SELECT pg_advisory_lock(115,11515)');
  try {
    const existing = (
      await pool.query(`SELECT obj_description(oid,'pg_namespace') AS seal, pg_get_userbyid(nspowner) AS owner
      FROM pg_namespace WHERE nspname='native_observability'`)
    ).rows[0];
    const role = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname='native_observability'"))
      .rowCount;
    if (existing ? existing.seal !== seal || existing.owner !== 'postgres' || !role : !!role)
      throw new Error('refusing unrelated telemetry schema or role');
    if (!existing) {
      // Transactional role/schema creation: uncertain starts are inspectable and
      // repeatable without rotating an existing role's password.
      await pool.query('BEGIN');
      try {
        const sql = (
          await pool.query(
            "SELECT format('CREATE ROLE native_observability LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text) AS sql",
            [password],
          )
        ).rows[0].sql;
        await pool.query(sql);
        await pool.query(`CREATE SCHEMA native_observability AUTHORIZATION postgres;
          COMMENT ON SCHEMA native_observability IS '${seal}';
          REVOKE ALL ON SCHEMA native_observability FROM PUBLIC`);
        await pool.query('COMMIT');
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    }
    const storage = studioStore(pool, { pool, schemaName: TELEMETRY_SCHEMA });
    await (await storage.getStore('observability'))!.init();
    await storage.ensurePartitions();
    await pool.query(`GRANT CONNECT ON DATABASE native_answer TO native_observability;
      GRANT USAGE ON SCHEMA native_observability TO native_observability;
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA native_observability TO native_observability;
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA native_observability TO native_observability;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA native_observability
        GRANT SELECT,INSERT,UPDATE ON TABLES TO native_observability;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA native_observability
        GRANT USAGE ON SEQUENCES TO native_observability`);
    await pool.query('SET ROLE native_observability');
    try {
      await checkTelemetryStorage(pool);
    } finally {
      await pool.query('RESET ROLE');
    }
    return storage;
  } finally {
    await pool.query('SELECT pg_advisory_unlock(115,11515)');
  }
}
