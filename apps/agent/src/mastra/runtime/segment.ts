import { webFetchReceipts } from '../tools/web-fetch.js';
import type { DurableAgentStreamResult } from '@mastra/core/agent/durable';
import { providerSearchReceipts } from '../tools/provider-search.js';

/** One framework segment; a question closes only after its native snapshot persists. */
export async function runNativeSegment(
  segment: DurableAgentStreamResult,
  onToolCall?: (toolName: string, args: unknown) => void,
) {
  const progress: unknown[] = [];
  let suspended: unknown;
  let failed = false;
  let rejected = false;
  try {
    for await (const chunk of segment.output.fullStream) {
      if (chunk.type === 'tool-call') onToolCall?.(chunk.payload.toolName, chunk.payload.args);
      if (chunk.type === 'tool-call-suspended') suspended = chunk.payload;
      if (chunk.type === 'error' || chunk.type === 'abort') failed = true;
      if (chunk.type === 'tripwire') rejected = true;
      // Small inspection projection; no parallel transcript or model request copies.
      if (progress.length < 64) progress.push({ type: chunk.type });
    }
    const output = await segment.output.getFullOutput();
    rejected ||= !!output.tripwire || output.finishReason === 'tripwire';
    const answer = output.steps.at(-1)?.text;
    return {
      runId: segment.runId,
      text: answer?.trim() ? answer : output.text,
      suspended,
      finishReason: output.finishReason,
      usage: output.usage,
      webSearch: providerSearchReceipts(output.steps),
      webFetch: webFetchReceipts(output.steps),
      uncertain: rejected || failed || !!output.error || output.finishReason === 'error',
      ...(rejected
        ? {
            failure: 'processor_rejected' as const,
            receipt:
              'A native processor refused this request. Reduce the input and submit a fresh request; no automatic replay.',
          }
        : {}),
      progress,
    };
  } finally {
    // Public cleanup releases in-process subscriptions/cache. Framework memory
    // and suspended workflow snapshots remain the source for a cold resume.
    segment.cleanup();
  }
}
