import { readSecret } from '../infrastructure/secret.js';
import { maintenanceConnection } from './maintenance.js';
import { Pool } from 'pg';
import { provisionNativeApplication } from '../infrastructure/storage/native-store.js';

// Maintenance command only. Dedicated fresh database/role: never update
// existing credentials, schemas or retained fixtures.
const connection = maintenanceConnection(process.env);
const password = readSecret(process.env, 'NATIVE_PG_PASSWORD');
const cluster = new Pool({ ...connection, database: 'postgres', max: 1 });
let database: Pool | undefined;
try {
  if (
    (await cluster.query("SELECT 1 FROM pg_database WHERE datname='native_answer'")).rowCount ||
    (await cluster.query("SELECT 1 FROM pg_roles WHERE rolname='native_answer'")).rowCount
  )
    throw new Error('native provision refuses existing database or role');
  if (password.length < 24) throw new Error('native runtime secret too short');
  const sql = (
    await cluster.query(
      "SELECT format('CREATE ROLE native_answer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text) AS sql",
      [password],
    )
  ).rows[0].sql;
  await cluster.query(sql);
  await cluster.query('CREATE DATABASE native_answer OWNER postgres');
  database = new Pool({ ...connection, database: 'native_answer', max: 2 });
  await database.query('REVOKE ALL ON DATABASE native_answer FROM PUBLIC');
  await provisionNativeApplication(database);
  console.log('fresh native framework and application receipt tables provisioned');
} catch {
  console.error('native maintenance refused; preserve state and inspect prerequisites');
  process.exitCode = 1;
} finally {
  await database?.end();
  await cluster.end();
}
