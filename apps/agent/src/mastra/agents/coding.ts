import { createDurableAgent } from '@mastra/core/agent/durable';
import { Agent } from '@mastra/core/agent';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { nativeAgentConfiguration, type NativeAgentConfiguration } from './shared.js';

export const NATIVE_AGENT_ID = 'coding';
export const NATIVE_AGENT_VERSION = 1;

/** Assigned reads and Code Mode are discovered on demand. */
export function createNativeAgent(
  options: NativeAgentConfiguration & {
    codeMode?: NativeAgentConfiguration['tools'];
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
      hooks: {
        beforeToolCall: options.beforeDispatch,
        afterToolCall: options.beforeDispatch,
      },
      tools: common.tools,
      inputProcessors: [
        new ToolSearchProcessor({
          tools: { ...options.tools, ...options.codeMode },
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
