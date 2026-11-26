import { defineConfig } from 'vitest/config';

// Real framework/PG behavior runs separately via test:native:integration.
export default defineConfig({
  test: {
    include: [
      'tests/integration/native-deployment.test.ts',
      'tests/integration/native-coding-deployment.test.ts',
      'tests/integration/native-live.test.ts',
      'tests/integration/agent-config.test.ts',
      'tests/integration/slack-manifest.test.ts',
      'tests/integration/mastra/native-dependencies.test.ts',
      'tests/integration/mastra/native-tools-upstream.test.ts',
      'tests/integration/admin-backup-script.test.ts',
      'tests/integration/docker-gc-script.test.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
