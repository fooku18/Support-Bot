import type { NativeAgentOptions } from '../agent-options.js';
import { coordinatorRunConfiguration, type CoordinatorConfig } from '../configuration/config.js';
import {
  resolveChannelTools,
  type EffectiveToolName,
} from '../../integrations/tools/tool-profile.js';
import {
  fetchCliRuntimeReadiness,
  verifyGitlabInstance,
  verifyAtlassianInstance,
  verifyDatadogInstance,
  verifyCloudflareInstance,
  verifySlackInstance,
} from '../../integrations/tools/tool-runtime-readiness.js';
import {
  gitlabViaRuntime,
  atlassianViaRuntime,
  datadogViaRuntime,
  describeDatadogCatalog,
  cloudflareViaRuntime,
  slackViaRuntime,
  webViaRuntime,
  type BrokerToolResult,
} from '../../integrations/tools/runtime-client.js';
import {
  GITLAB_READ_OPERATIONS,
  operationScopeLabel,
  validateGitlabOperation,
  type ValidatedGitlabArgs,
} from '../../integrations/gitlab/gitlab-operations.js';
import {
  hintProjectPaths,
  normalizeGitlabOutput,
  renderGitlabResultText,
} from '../../integrations/gitlab/gitlab-rest-adapter.js';
import { validateAtlassianOperation } from '../../integrations/atlassian/atlassian-operations.js';
import { validateDatadogArguments } from '../../integrations/datadog/datadog-schema.js';
import {
  validateCloudflareGet,
  validateCloudflareGraphql,
} from '../../integrations/cloudflare/cloudflare-api-adapter.js';
import { validateSlackRequest } from '../../integrations/slack/slack-api-adapter.js';
import {
  readSlackMessage,
  type NativeMessageClient,
} from '../../integrations/slack/message-client.js';
import { publicWebUrl, readWebPage, type WebReader } from '../../integrations/web/gemini-reader.js';

function webQuestion(value: unknown): string {
  const question = typeof value === 'string' ? value.trim() : '';
  if (question.length < 3 || question.length > 500)
    throw new Error('web_fetch requires a question of 3 to 500 characters');
  return question;
}

/** Typed, credential-free clients over the existing approved tool runtime.
 * Mastra createTool owns invocation. No ToolBroker instance, action journal,
 * checkout, publisher or old execution protocol is instantiated here. */
export function nativeReadServices(options: {
  configuration(): Promise<CoordinatorConfig>;
  cli?: { url: string; token: string };
  /** Page reads: Gemini's URL context, or the isolated web runtime. */
  web?: { reader: WebReader } | { url: string; token: string };
  /** Linked message reads; offered with an assigned, ready Slack instance. */
  messages?: NativeMessageClient;
}): NativeAgentOptions['services'] {
  return async (identity, signal) => {
    const config = await options.configuration();
    const current = coordinatorRunConfiguration(config, identity.teamId, identity.channelId);
    const profile = resolveChannelTools(
      {
        teamId: identity.teamId,
        channelId: identity.channelId,
        tools: current.tools,
      } as Parameters<typeof resolveChannelTools>[0],
      { gitlab: true },
    );
    const { cli } = options;
    const readiness = cli ? await fetchCliRuntimeReadiness(cli.url, cli.token) : undefined;
    if (readiness?.syncError) throw new Error('tool configuration unavailable');
    const status = (id: string) => readiness?.instances.find((i) => i.instanceId === id);
    if (cli && profile.gitlab)
      verifyGitlabInstance(status(profile.gitlab.instanceId), profile.gitlab, identity.teamId);
    const find = (kind: EffectiveToolName) => profile.tools.find((t) => t.name === kind);
    const webFetch = options.web ? find('webFetch') : undefined;
    const at = find('atlassian'),
      dd = find('datadog'),
      cf = find('cloudflare'),
      sl = find('slack');
    const atlassian =
      cli && at ? verifyAtlassianInstance(status(at.instanceId), at, identity.teamId) : undefined;
    const datadog =
      cli && dd
        ? await verifyDatadogInstance(status(dd.instanceId), dd, identity.teamId, cli)
        : undefined;
    const cloudflare =
      cli && cf ? verifyCloudflareInstance(status(cf.instanceId), cf, identity.teamId) : undefined;
    const slack =
      cli && sl ? verifySlackInstance(status(sl.instanceId), sl, identity.teamId) : undefined;
    const limits = { timeoutMs: 30000, maxOutputBytes: 48000 };
    const ref = (instanceId: string | undefined) => {
      signal.throwIfAborted();
      if (!instanceId) throw new Error('read service not assigned');
      return { instanceId, teamId: identity.teamId, ...limits };
    };
    const reply = (value: { status: string; output: string }): BrokerToolResult => {
      let data: unknown;
      try {
        data = JSON.parse(value.output);
      } catch {
        /* bounded plain-text service result */
      }
      return {
        ok: value.status === 'completed',
        output: value.output,
        operationId: 'native-read',
        ...(data === undefined ? {} : { data }),
      };
    };
    const unavailable = async (): Promise<never> => {
      throw new Error('Unavailable in native answer candidate');
    };
    return {
      enabled: new Set<EffectiveToolName>([
        ...(atlassian?.operations.length ? ['atlassian' as const] : []),
        ...(datadog ? ['datadog' as const] : []),
        ...(cloudflare ? ['cloudflare' as const] : []),
        ...(slack ? ['slack' as const] : []),
        ...(webFetch ? ['webFetch' as const] : []),
      ]),
      catalog: {
        gitlab: !!cli && !!profile.gitlab,
        atlassianOperations: atlassian?.operations,
        datadogTools: datadog?.tools,
        slackSearch: false,
        slackMessages: !!slack && !!options.messages,
      },
      services: {
        async webFetch(input) {
          if (!webFetch || !options.web) return unavailable();
          if ('reader' in options.web) {
            const output = await readWebPage(
              options.web.reader,
              publicWebUrl(input.url),
              webQuestion(input.question),
              signal,
            );
            return { ok: true, output, operationId: 'native-web-fetch' };
          }
          const target = new URL(typeof input.url === 'string' ? input.url : '');
          if (
            !['http:', 'https:'].includes(target.protocol) ||
            target.username ||
            target.password ||
            (target.port && !['80', '443'].includes(target.port))
          )
            throw new Error('web_fetch requires a public HTTP(S) URL without credentials');
          const result = await webViaRuntime(
            {
              path: '/fetch',
              body: {
                instanceId: webFetch.instanceId,
                teamId: identity.teamId,
                url: target.href,
                maxOutputBytes: 48000,
              },
            },
            options.web.url,
            options.web.token,
            30000,
            signal,
          );
          if (Buffer.byteLength(result.output) > 48000)
            throw new Error('web_fetch output bound exceeded');
          return { ok: true, output: result.output, operationId: 'native-web-fetch' };
        },
        async gitlab(operation, args) {
          if (!cli || typeof operation !== 'string') return unavailable();
          if (!(GITLAB_READ_OPERATIONS as readonly string[]).includes(operation))
            return unavailable();
          const read = async (validated: ValidatedGitlabArgs) => {
            const response = await gitlabViaRuntime(
              {
                ...ref(profile.gitlab?.instanceId),
                // The capture bound of the coding path; the shared
                // normalization bounds what reaches the model.
                maxOutputBytes: 200000,
                operation: validated.kind,
                operationArgs: validated,
              },
              cli.url,
              cli.token,
              40000,
              signal,
            );
            if (response.status === 'not_run')
              return { refused: (response.refused ?? response.output).slice(0, 300) };
            // The same normalization as the coding path: bounded fields and
            // collections, the trace report, the decoded repository file.
            return normalizeGitlabOutput({
              operation: validated.kind,
              project: operationScopeLabel(validated),
              status: response.status,
              httpStatus: response.httpStatus,
              output: response.output,
              truncated: response.truncated,
              error: response.error,
              ...('page' in validated ? { page: validated.page } : {}),
              ...('per_page' in validated ? { per_page: validated.per_page } : {}),
              ...(validated.kind === 'search' ? { scope: validated.scope } : {}),
              textMeta: response.textMeta,
            });
          };
          const validated = validateGitlabOperation(operation, args);
          const result = await read(validated);
          if ('refused' in result)
            return {
              ok: false,
              output: `failed (${validated.kind} @ ${operationScopeLabel(validated)}): [refused] ${result.refused}`,
              operationId: 'native-read',
            };
          const normalized = await hintProjectPaths(result, async (search) => {
            const listed = await read(search);
            if ('refused' in listed) throw new Error('project search refused');
            return listed;
          });
          return {
            ok: normalized.ok,
            output: renderGitlabResultText(normalized),
            operationId: 'native-read',
            ...(normalized.ok ? { data: normalized.data } : {}),
          };
        },
        async atlassian(operation, args) {
          if (!cli || typeof operation !== 'string') return unavailable();
          if (!atlassian?.operations.includes(operation)) return unavailable();
          return reply(
            await atlassianViaRuntime(
              {
                ...ref(at?.instanceId),
                operation,
                operationArgs: validateAtlassianOperation(operation, args),
                binding: atlassian,
              },
              cli.url,
              cli.token,
              signal,
            ),
          );
        },
        async datadogDescribe(input) {
          if (!datadog) return unavailable();
          return describeDatadogCatalog(datadog.tools, input);
        },
        async datadog(tool, args) {
          const entry = datadog?.tools.find((t) => t.name === tool);
          if (!cli || !entry || !datadog) return unavailable();
          return reply(
            await datadogViaRuntime(
              {
                ...ref(dd?.instanceId),
                tool,
                arguments: validateDatadogArguments(entry.inputSchema, args),
                binding: datadog.binding,
              },
              cli.url,
              cli.token,
              signal,
            ),
          );
        },
        async cloudflareGet(args) {
          if (!cli || !cloudflare) return unavailable();
          return reply(
            await cloudflareViaRuntime(
              {
                ...ref(cf?.instanceId),
                operation: 'get',
                request: validateCloudflareGet(args, {
                  restrictedZones: cloudflare.restrictedZones,
                  accountId: cloudflare.binding.accountId,
                  zoneIds: cloudflare.zones.map((z) => z.id),
                }),
                binding: cloudflare.binding,
              },
              cli.url,
              cli.token,
              signal,
            ),
          );
        },
        async cloudflareGraphql(args) {
          if (!cli || !cloudflare) return unavailable();
          return reply(
            await cloudflareViaRuntime(
              {
                ...ref(cf?.instanceId),
                operation: 'graphql',
                request: validateCloudflareGraphql(args, {
                  accountId: cloudflare.binding.accountId,
                  zoneIds: cloudflare.zones.map((z) => z.id),
                  restrictedZones: cloudflare.restrictedZones,
                }),
                binding: cloudflare.binding,
              },
              cli.url,
              cli.token,
              signal,
            ),
          );
        },
        async slackGetUser(args) {
          if (!cli || !slack) return unavailable();
          return reply(
            await slackViaRuntime(
              {
                ...ref(sl?.instanceId),
                operation: 'getUser',
                arguments: validateSlackRequest('getUser', args),
                binding: slack,
              },
              cli.url,
              cli.token,
              signal,
            ),
          );
        },
        async slackLookupUserByEmail(args) {
          if (!cli || !slack) return unavailable();
          return reply(
            await slackViaRuntime(
              {
                ...ref(sl?.instanceId),
                operation: 'lookupByEmail',
                arguments: validateSlackRequest('lookupByEmail', args),
                binding: slack,
              },
              cli.url,
              cli.token,
              signal,
            ),
          );
        },
        slackSearchMessages: unavailable,
        async slackReadMessage(args) {
          if (!slack || !options.messages) return unavailable();
          return {
            ...(await readSlackMessage(options.messages, identity, args, signal)),
            operationId: 'native-slack-read',
          };
        },
      },
    };
  };
}
