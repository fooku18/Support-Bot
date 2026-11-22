import { createCodeMode, type Tool } from '@mastra/core/tools';
import type { ToolsInput } from '@mastra/core/agent';
import { IsolatedVmCodeModeTransport } from '@mastra/isolated-vm';

/** Bounds of one `execute_typescript` run. The script runs on the V8 isolate's
 * own thread, so a synchronous loop does not hold the agent's event loop; a
 * host timer disposes the isolate at the timeout. */
export const CODE_MODE_LIMITS = {
  timeoutMs: 15_000,
  memoryLimitMb: 64,
} as const;

/** A startup refusal whose message holds no secret and may be printed. */
export class CodeModeRuntimeError extends Error {
  override name = 'CodeModeRuntimeError';
}

/** isolated-vm crashes the process when it creates an isolate on Node 20+
 * without `--no-node-snapshot`. Call this at startup to fail with a clear error
 * instead of at the first script. */
export function assertCodeModeRuntime(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS ?? '',
): void {
  if (execArgv.includes('--no-node-snapshot')) return;
  if (nodeOptions.split(/\s+/).includes('--no-node-snapshot')) return;
  throw new CodeModeRuntimeError(
    'Code Mode needs Node started with --no-node-snapshot (set NODE_OPTIONS=--no-node-snapshot).',
  );
}

/** Mastra Code Mode over the given read tools, run in an in-process V8 isolate
 * (isolated-vm). The script gets no filesystem, network, process, timer or
 * module access; its only capabilities are the `external_*` functions of
 * `reads`. Each read authorizes itself per call. `authorize` checks the
 * current authorization once before a script starts. */
export function createNativeCodeMode(reads: ToolsInput, authorize: () => Promise<void>) {
  assertCodeModeRuntime();
  const code = createCodeMode(
    { tools: reads, timeout: CODE_MODE_LIMITS.timeoutMs },
    new IsolatedVmCodeModeTransport({ memoryLimitMb: CODE_MODE_LIMITS.memoryLimitMb }),
  );
  const tool = code.tool as Tool;
  const execute = tool.execute!;
  tool.execute = async (args, context) => {
    await authorize();
    return execute(args, context);
  };
  // Load the generated signatures with the tool instead of the system prompt.
  tool.description += `\n\n${code.instructions}`;
  return tool;
}
