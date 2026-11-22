import type { Pool } from 'pg';
import { PostgresStoreVNext } from '@mastra/pg';

/** Studio-only signals; existing chat/workflow storage remains in framework. */
export function studioStore(
  pool: Pool,
  telemetry: { pool: Pool; schemaName: string } = { pool, schemaName: 'studio_observability' },
) {
  return new PostgresStoreVNext({
    id: 'support-agent-studio',
    pool,
    schemaName: 'framework',
    disableInit: true,
    observability: {
      ...telemetry,
      partitioning: { mode: 'native', futureDays: 14 },
      discovery: { ttlSeconds: 10 },
    },
  });
}
