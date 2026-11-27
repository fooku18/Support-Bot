import { Pool } from 'pg';
import { maintenanceConnection } from './maintenance.js';
import { upgradeNativeApplication } from '../infrastructure/storage/native-store.js';

const pool = new Pool({ ...maintenanceConnection(process.env), database: 'native_answer', max: 2 });
try {
  await upgradeNativeApplication(pool);
  console.log('native framework tables upgraded; application tables unchanged');
} catch {
  console.error('native upgrade refused; preserve state and inspect prerequisites');
  process.exitCode = 1;
} finally {
  await pool.end();
}
