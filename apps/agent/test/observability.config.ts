import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// A focused runner until the parent composes these tests into the release gates.
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['apps/agent/test/observability.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
