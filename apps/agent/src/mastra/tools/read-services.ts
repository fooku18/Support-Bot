import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  GITLAB_READ_OPERATIONS,
  isGitlabOperationName,
} from '../../integrations/gitlab/gitlab-operations.js';
import { nativeOperationCapability } from './discovery.js';
import {
  createServiceToolDefinitions,
  type BrokerToolCatalogOptions,
  type BrokerToolReply,
} from '../../integrations/tools/service-catalog.js';
import type { ServiceToolHandlers } from '../../integrations/tools/runtime-client.js';
import type { EffectiveToolName } from '../../integrations/tools/tool-profile.js';

/** Reuse typed service contracts, never the broker's execution/state machine.
 * Credential-owning transports stay behind trusted closures. Search requiring
 * an action token is omitted unless the existing scoped transport qualified it. */
export function createReadServiceTools(options: {
  services: Pick<
    ServiceToolHandlers,
    | 'gitlab'
    | 'atlassian'
    | 'datadogDescribe'
    | 'datadog'
    | 'cloudflareGraphql'
    | 'cloudflareGet'
    | 'slackGetUser'
    | 'slackLookupUserByEmail'
    | 'slackSearchMessages'
  > &
    Partial<Pick<ServiceToolHandlers, 'webFetch' | 'slackReadMessage' | 'optimizely'>>;
  enabled: ReadonlySet<EffectiveToolName>;
  catalog: BrokerToolCatalogOptions;
  authorize(capability: string): Promise<void>;
}) {
  const allowed = new Set<string>([
    ...GITLAB_READ_OPERATIONS,
    ...(options.catalog.atlassianOperations ?? []),
    'datadog_describe_tools',
    'datadog_call',
    'cloudflare_graphql',
    'cloudflare_get',
    'slack_get_user',
    'slack_lookup_user_by_email',
    'web_fetch',
    'optimizely_lookup',
    ...(options.catalog.slackMessages ? ['slack_read_message'] : []),
    ...(options.catalog.slackSearch ? ['slack_search_messages'] : []),
  ]);
  // The shared catalog closes over method references; unselected workspace/write
  // handlers are never exposed or executed. No new schema facade or transport.
  const definitions = createServiceToolDefinitions(
    {
      ...options.services,
      webFetch: options.services.webFetch ?? unavailable,
      optimizely: options.services.optimizely ?? unavailable,
      slackReadMessage: options.services.slackReadMessage ?? unavailable,
    },
    options.enabled,
    options.catalog,
  ).filter((d) => allowed.has(d.name));
  return Object.fromEntries(
    definitions.map((d) => [
      d.name,
      createTool({
        id: d.name,
        description: d.description,
        inputSchema: isGitlabOperationName(d.name)
          ? z.object(d.inputSchema).strict()
          : z.object(d.inputSchema),
        execute: async (args) => {
          const capability = nativeOperationCapability(d.name);
          if (!capability) throw new Error('unavailable service');
          await options.authorize(capability);
          const result = await d.handler(args);
          await options.authorize(capability);
          return result;
        },
        toModelOutput: (reply) => {
          const content = (reply as Partial<BrokerToolReply> | null)?.content;
          return Array.isArray(content)
            ? { type: 'text', value: content.map((part) => part.text).join('\n') }
            : { type: 'json', value: reply };
        },
      }),
    ]),
  );
}

async function unavailable(): Promise<never> {
  throw new Error('This read is not configured');
}
