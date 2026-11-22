import { describe, expect, it } from 'vitest';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';

/** Framework counters remain authoritative; the projection invents no accounting. */
describe('native answer usage', () => {
  it.each([
    undefined,
    { inputTokens: 21, outputTokens: 7, totalTokens: 28 },
    { inputTokens: 21, outputTokens: 7, totalTokens: 28, raw: {} },
    {
      inputTokens: 21,
      outputTokens: 7,
      totalTokens: 28,
      raw: { inputTokens: { total: 21, cacheRead: 5, cacheWrite: 3 }, outputTokens: { total: 7 } },
    },
    {
      inputTokens: 21,
      outputTokens: 7,
      totalTokens: 28,
      raw: {
        inputTokens: { noCache: -1, cacheRead: 5, cacheWrite: 3 },
        outputTokens: { total: 7 },
      },
    },
  ])(
    'preserves absent or partial framework counters without inventing values (%j)',
    async (usage) => {
      const result = await runNativeSegment({
        runId: 'usage-receipt',
        output: {
          fullStream: (async function* () {})(),
          getFullOutput: async () => ({ text: 'done', finishReason: 'stop', usage, steps: [] }),
        },
        cleanup() {},
      } as unknown as Parameters<typeof runNativeSegment>[0]);
      expect(result.usage).toBe(usage);
    },
  );
});
