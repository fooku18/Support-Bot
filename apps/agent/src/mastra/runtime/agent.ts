import { Mastra } from '@mastra/core/mastra';
import { createNativeAgent, NATIVE_AGENT_ID } from '../agents/coding.js';
import { createPrivateDiagnostics, type DiagnosticsSource } from '../studio-observability.js';
import { createNativeDiagnostics } from '../observability.js';

export type NativeRuntimeOptions = Parameters<typeof createNativeAgent>[0] & {
  observability?: DiagnosticsSource['correlation'];
};

export function createNativeRuntime(options: NativeRuntimeOptions) {
  const agent = createNativeAgent(options);
  const mastra = new Mastra({
    agents: { [NATIVE_AGENT_ID]: agent },
    storage: options.storage,
    ...(options.observability
      ? createPrivateDiagnostics([options.model.selection.model], {
          source: 'slack',
          route: options.model.selection.route,
          correlation: options.observability,
        })
      : createNativeDiagnostics()),
    recovery: { durableAgents: 'off', workflows: 'off' },
  });
  return { agent, mastra };
}
