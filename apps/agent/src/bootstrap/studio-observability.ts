/** Dedicated network-none Studio maintenance process. No application credentials
 * or HTTP listener; runtime never receives this Unix maintenance socket. */
import fs from 'node:fs';
import { Pool } from 'pg';
import { studioStore } from '../infrastructure/storage/studio-store.js';
const socket = process.env.NATIVE_PG_SOCKET;
const ready = process.env.STUDIO_OBSERVABILITY_READY;
if (process.env.NATIVE_STUDIO !== 'testing' || !socket?.startsWith('/') || !ready?.startsWith('/'))
  throw new Error('explicit Studio maintenance mounts required');
const pool = new Pool({ host: socket, user: 'postgres', database: 'native_answer', max: 1 });
const storage = studioStore(pool);
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let work: Promise<void> = Promise.resolve();
async function maintain() {
  await storage.ensurePartitions();
  await pool.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA studio_observability TO native_answer',
  );
  await pool.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA studio_observability TO native_answer');
  fs.writeFileSync(ready!, JSON.stringify({ ready: true, at: new Date().toISOString() }));
}
async function close() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await work.catch(() => {});
  await pool.end();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void close());
async function initialize() {
  const identity = (await pool.query('SELECT current_user, current_database() AS db')).rows[0];
  if (identity.current_user !== 'postgres' || identity.db !== 'native_answer')
    throw new Error('maintenance identity refused');
  const obs = await storage.getStore('observability');
  await obs!.init();
  await pool.query(`GRANT USAGE ON SCHEMA studio_observability TO native_answer;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA studio_observability
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO native_answer;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA studio_observability
    GRANT USAGE ON SEQUENCES TO native_answer`);
  await maintain();
  const schedule = () => {
    if (!stopping)
      timer = setTimeout(
        () => {
          work = maintain()
            .then(schedule)
            .catch(async () => {
              console.error('Studio observability maintenance failed');
              process.exitCode = 1;
              await pool.end();
            });
        },
        6 * 60 * 60 * 1000,
      );
  };
  schedule();
}
work = initialize().catch(async () => {
  console.error('Studio observability provisioning refused; retain state and inspect');
  process.exitCode = 1;
  if (!stopping) await pool.end();
});
