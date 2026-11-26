import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createNativeAgentStorage } from '../../src/infrastructure/storage/agent-storage.js';

it('keeps a held task lock connection error from crashing the process', async () => {
  const client = Object.assign(new EventEmitter(), {
    query: async () => ({ rows: [{ held: true }] }),
    release: () => undefined,
  });
  const pool = { options: { max: 11 }, connect: async () => client };
  const storage = createNativeAgentStorage(pool as unknown as Pool);
  const held = await storage.taskLock('task-1', 8);
  expect(() => held.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
  await storage.unlock(held, 'task-1');
  expect(client.listenerCount('error')).toBe(0);
});
