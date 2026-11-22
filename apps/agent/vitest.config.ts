import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    maxWorkers: 1,
    // Code Mode's isolated-vm needs this flag in the process that creates isolates.
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
  },
});
