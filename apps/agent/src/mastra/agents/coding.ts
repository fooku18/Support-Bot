import { createDurableAgent } from '@mastra/core/agent/durable';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { AnyWorkspace } from '@mastra/core/workspace';
import { TaskSignalProvider } from '@mastra/core/signals';
import { ToolSearchProcessor } from '@mastra/core/processors';
import {
  taskWriteTool,
  taskUpdateTool,
  taskCompleteTool,
  taskCheckTool,
  TaskStateProcessor,
} from '@mastra/core/tools';
import { nativeAgentConfiguration, type NativeAgentConfiguration } from './shared.js';

export const NATIVE_AGENT_ID = 'coding';
export const NATIVE_AGENT_VERSION = 1;

/** Assigned reads are discovered on demand. Workspace tools depend on the trusted binding. */
export function createNativeAgent(
  options: NativeAgentConfiguration & {
    coding?: {
      workspace: AnyWorkspace;
      tools: ToolsInput;
      codeMode: NativeAgentConfiguration['tools'];
    };
  },
) {
  const common = nativeAgentConfiguration(options, 600000);
  return createDurableAgent({
    cleanupTimeoutMs: 0,
    maxSteps: options.maxSteps,
    agent: new Agent({
      ...common,
      id: NATIVE_AGENT_ID,
      name: 'Support Agent',
      workspace: options.coding?.workspace,
      signals: options.coding ? [new TaskSignalProvider()] : [],
      hooks: {
        beforeToolCall: options.beforeDispatch,
        afterToolCall: options.beforeDispatch,
      },
      tools: {
        ...(options.coding && {
          ...options.coding.tools,
          task_write: taskWriteTool,
          task_update: taskUpdateTool,
          task_complete: taskCompleteTool,
          task_check: taskCheckTool,
        }),
        ...common.tools,
      },
      inputProcessors: [
        ...(options.coding ? [new TaskStateProcessor()] : []),
        new ToolSearchProcessor({
          tools: { ...options.tools, ...options.coding?.codeMode },
          storage: 'context',
          search: { topK: 3, autoLoad: true },
          filter: async () => {
            await options.beforeDispatch();
            return true;
          },
        }),
        ...common.inputProcessors,
      ],
    }),
  });
}
