import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { NATIVE_EXPORT_BYTES, NATIVE_EXPORT_COUNT, nativeExportName } from './native-exports.js';
import { CoordinatorError } from '../../application/errors.js';
const fail = (code: string): never => {
  throw new CoordinatorError(409, code);
};
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
/** Exact idempotence and capacity apply equally to Slack and Studio exports. */
export async function registerNativeExport(
  pool: Pool,
  runId: string,
  file: { name: string; path: string; sha256: string; bytes: Buffer },
) {
  nativeExportName(file.name);
  if (
    !file.bytes.length ||
    file.bytes.length > NATIVE_EXPORT_BYTES ||
    createHash('sha256').update(file.bytes).digest('hex') !== file.sha256
  )
    fail('export_bytes_invalid');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT run_id FROM native_agents.requests WHERE run_id=$1 FOR UPDATE', [runId]);
    const prior = (
      await tx.query('SELECT id,path,name,sha256 FROM native_agents.exports WHERE run_id=$1', [
        runId,
      ])
    ).rows;
    const old = prior.find((f) => f.path === file.path);
    if (old && (old.sha256 !== file.sha256 || old.name !== file.name))
      fail('export_already_designated');
    if (!old && prior.length >= NATIVE_EXPORT_COUNT) fail('export_count_limit');
    const id = old?.id ?? digest(JSON.stringify([runId, file.path, file.sha256]));
    if (!old)
      await tx.query(
        'INSERT INTO native_agents.exports(id,run_id,path,name,sha256,content) VALUES($1,$2,$3,$4,$5,$6)',
        [id, runId, file.path, file.name, file.sha256, file.bytes],
      );
    await tx.query('COMMIT');
    return {
      id,
      name: file.name,
      sha256: file.sha256,
      bytes: file.bytes.length,
      delivery: 'pending successful completion',
    };
  } catch (e) {
    await tx.query('ROLLBACK');
    throw e;
  } finally {
    tx.release();
  }
}
