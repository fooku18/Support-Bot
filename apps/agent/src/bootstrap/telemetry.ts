import { readSecret } from '../infrastructure/secret.js';
import { maintenanceConnection } from './maintenance.js';
/** Explicit maintenance connection only. Existing native database must already exist.
 * No native fresh provisioner, app DDL or HTTP listener. */
import fs from 'node:fs';
import { Pool } from 'pg';
import { provisionTelemetry } from '../infrastructure/storage/telemetry-store.js';
const env = process.env;
const pool = new Pool({
  ...maintenanceConnection(env),
  database: 'native_answer',
  max: 1,
});
let stopping = false;
let timer: NodeJS.Timeout | undefined;
let work: Promise<void>;
const close = async () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await work.catch(() => {});
  await pool.end();
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void close());
work = (async () => {
  const storage = await provisionTelemetry(pool, readSecret(env, 'NATIVE_OBSERVABILITY_PASSWORD'));
  const schedule = () => {
    if (!stopping)
      timer = setTimeout(
        () => {
          work = storage
            .ensurePartitions()
            .then(schedule)
            .catch(async () => {
              console.error('telemetry partition maintenance failed; retain state and inspect');
              process.exitCode = 1;
              await pool.end();
            });
        },
        6 * 60 * 60 * 1000,
      );
  };
  // Compose gates explicit enablement on this readiness marker. No primary seal.
  fs.writeFileSync('/tmp/telemetry-ready', 'ready');
  console.log('private telemetry schema, role and official partitions ready');
  schedule();
})().catch(async () => {
  console.error('telemetry maintenance refused; retain state and inspect');
  process.exitCode = 1;
  if (!stopping) await pool.end();
});
