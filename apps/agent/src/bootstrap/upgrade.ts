import { Pool } from 'pg';
import { maintenanceConnection } from './maintenance.js';
import { upgradeNativeApplication } from '../infrastructure/storage/native-store.js';

const pool = new Pool({
  ...maintenanceConnection(process.env),
  database: 'native_answer',
  max: 2,
  lock_timeout: 10000,
});
try {
  await upgradeNativeApplication(pool);
  console.log('native framework tables upgraded; application tables unchanged');
} catch (error) {
  const reason =
    (error as { code?: unknown }).code ?? (error instanceof Error ? error.name : 'unknown');
  console.error(
    `native upgrade refused (${String(reason)}); preserve state and inspect prerequisites`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
