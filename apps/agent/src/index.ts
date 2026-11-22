// Native application factories only. Importing this module starts no services.
export {
  createChannelMemoryTransport,
  startChannelMemoryProxy,
  type ChannelMemoryTransport,
} from './integrations/slack/channel-memory.js';

export { createNativeAgentService, type NativeAgentService } from './application/agent-service.js';
export { startNativeAgentServer, startNativeApplication } from './application/server.js';
export {
  createNativeInputClient,
  type NativeInputClient,
} from './integrations/slack/input-client.js';
export { provisionNativeAgents } from './infrastructure/storage/agent-storage.js';
export type { NativeAgentOptions, NativeAgentInput } from './application/agent-options.js';
