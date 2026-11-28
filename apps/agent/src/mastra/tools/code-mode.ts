import { createCodeMode, type Tool } from '@mastra/core/tools';
import type { ToolsInput } from '@mastra/core/agent';
import { IsolatedVmCodeModeTransport } from '@mastra/isolated-vm';

/** Bounds of one `execute_typescript` run. The script runs on the V8 isolate's
 * own thread, so a synchronous loop does not hold the agent's event loop; a
 * host timer disposes the isolate at the timeout. */
export const CODE_MODE_LIMITS = {
  timeoutMs: 15_000,
  memoryLimitMb: 64,
  /** Read calls of one script; a direct call costs a model step instead. */
  maxReads: 50,
  /** Serialized result and logs that enter the conversation. */
  maxOutputBytes: 48_000,
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

type TransportRun = Parameters<IsolatedVmCodeModeTransport['run']>[0];

export const CODE_MODE_READ_SHAPE =
  'Every external_* function resolves to { ok: true, data, warnings? } with the parsed JSON response, or to { ok, output } with the text of a non-JSON response or of a failed read (ok false, output says why). warnings, when present, says the data is partial (for example a full page: read the next page). A read that is refused or cannot run rejects instead; use Promise.allSettled to keep the other results of a batch.';

export function codeModeReadResult(value: unknown): unknown {
  const result = (value as { result?: unknown } | null)?.result as
    { ok?: unknown; output?: unknown; data?: unknown; warnings?: unknown } | undefined;
  if (typeof result?.ok !== 'boolean' || typeof result.output !== 'string') return value;
  if (!result.ok) return { ok: false, output: result.output };
  if (result.data !== undefined)
    return Array.isArray(result.warnings) && result.warnings.length > 0
      ? { ok: true, data: result.data, warnings: result.warnings }
      : { ok: true, data: result.data };
  try {
    return { ok: true, data: JSON.parse(result.output) as unknown };
  } catch {
    return { ok: true, output: result.output };
  }
}

/** Bounds what one script may read and return. */
class BoundedTransport extends IsolatedVmCodeModeTransport {
  override async run(options: TransportRun) {
    let reads = 0;
    const result = await super.run({
      ...options,
      dispatch: async (tool, args) => {
        reads += 1;
        if (reads > CODE_MODE_LIMITS.maxReads)
          throw new Error(`a script may make at most ${CODE_MODE_LIMITS.maxReads} read calls`);
        return codeModeReadResult(await options.dispatch(tool, args));
      },
    });
    if (Buffer.byteLength(JSON.stringify(result) ?? '') <= CODE_MODE_LIMITS.maxOutputBytes)
      return result;
    return {
      success: false,
      error: {
        name: 'OutputLimitError',
        message: `the script's result and logs exceed ${CODE_MODE_LIMITS.maxOutputBytes} bytes; return only the data needed`,
      },
    };
  }
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
    new BoundedTransport({ memoryLimitMb: CODE_MODE_LIMITS.memoryLimitMb }),
  );
  const tool = code.tool as Tool;
  const execute = tool.execute!;
  tool.execute = async (args, context) => {
    await authorize();
    return execute(args, context);
  };
  // Load the generated signatures with the tool instead of the system prompt.
  tool.description += `\n\n${code.instructions}\n\n${CODE_MODE_READ_SHAPE}`;
  return tool;
}

/** The Code Mode tool, keyed for the agent's discovery catalog. */
export function nativeCodeModeTools(reads: ToolsInput, authorize: () => Promise<void>) {
  const tool = createNativeCodeMode(reads, authorize);
  return { [tool.id]: tool };
}
