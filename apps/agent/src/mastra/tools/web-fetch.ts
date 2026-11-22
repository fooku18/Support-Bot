import { createHash } from 'node:crypto';
import type { LLMStepResult } from '@mastra/core/stream';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Content-free evidence from completed direct fetch tool calls, not answer text. */
export function webFetchReceipts(steps: LLMStepResult[]) {
  return steps.flatMap((step) =>
    step.toolCalls.flatMap(({ payload: call }) => {
      const args: unknown = call.args;
      if (call.toolName !== 'web_fetch' || !record(args) || typeof args.url !== 'string') return [];
      const result = step.toolResults.find(
        ({ payload: p }) => p.toolName === call.toolName && p.toolCallId === call.toolCallId,
      )?.payload;
      if (!result || result.isError || !record(result.result) || !record(result.result.result))
        return [];
      const value = result.result.result;
      if (value.ok !== true || typeof value.output !== 'string') return [];
      return [
        {
          id: hash(call.toolCallId),
          url: hash(new URL(args.url).href),
          sha256: hash(value.output),
          bytes: Buffer.byteLength(value.output),
        },
      ];
    }),
  );
}
