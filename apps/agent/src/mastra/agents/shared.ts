import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { InputProcessor, ToolSearchProcessor } from '@mastra/core/processors';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { MastraModelConfig } from '@mastra/core/llm';
import { askUserTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import type { ModelBinding } from '../../integrations/providers/access.js';
import { ContextBudgetProcessor } from '../runtime/context-budget.js';
import { createAnswerModel } from '../runtime/model.js';

export interface NativeAgentConfiguration {
  /** Exact inline input documents for either native template. */
  nativeInputs?: boolean;
  storage: MastraCompositeStore;
  model: ModelBinding;
  /** Studio binds to the framework's run identity on each invocation. */
  modelForRun?(runId: string): ModelBinding;
  instructions: string;
  tools: ConstructorParameters<typeof ToolSearchProcessor>[0]['tools'];
  unavailableTools?: string[];
  /** Current application authority, re-evaluated before EVERY provider dispatch. */
  beforeDispatch(): Promise<void>;
  /** Present only for a ready assigned search instance; rechecked at dispatch. */
  webSearch?: { authorize(): Promise<void> };
  /** Estimated prompt tokens per request; the selected model's catalog entry sets it. */
  contextTokens: number;
  outputTokens: number;
  maxSteps: number;
}

const TOOL_LABELS: Record<string, string> = {
  gitlab: 'GitLab',
  atlassian: 'Jira and Confluence',
  datadog: 'Datadog',
  cloudflare: 'Cloudflare',
  slack: 'Slack',
};

type StepArgs = Parameters<NonNullable<InputProcessor['processInputStep']>>[0];

function answerNow(systemMessages: StepArgs['systemMessages']) {
  return {
    toolChoice: 'none' as const,
    systemMessages: [
      ...systemMessages,
      {
        role: 'system' as const,
        content:
          'This is the last step of this run and no more tool calls are possible. Answer now from what you have found so far, and say what you could not check.',
      },
    ],
  };
}

export function answerBefore(deadlineMs: number) {
  return ({ systemMessages }: StepArgs) =>
    Date.now() >= deadlineMs ? answerNow(systemMessages) : undefined;
}

/** Shared limits, model and memory configuration. The framework owns execution,
 * transcripts and suspension; process-local clients never enter request context. */
export function nativeAgentConfiguration(options: NativeAgentConfiguration, timeoutMs: number) {
  for (const n of [options.contextTokens, options.outputTokens, options.maxSteps])
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('invalid answer limits');
  const modelOptions = {
    beforeDispatch: options.beforeDispatch,
    authorizeSearch: options.webSearch?.authorize,
    nativeTextDocuments: !!options.nativeInputs,
    timeoutMs,
  };
  const model = createAnswerModel(options.model, modelOptions);
  const forRun = options.modelForRun;
  const attributionProcessor: InputProcessor = {
    id: 'studio-model-attribution',
    processInputStep({ runId, providerOptions, abort, requestContext }) {
      // Mastra 1.83's durable processor bridge omits its runId argument.
      // Its execution claim is server-owned, refreshed on resume and never
      // serialized into the durable request context.
      const claims = requestContext?.get('mastra__durableExecutions');
      const claimIds = claims && typeof claims === 'object' ? Object.keys(claims) : [];
      const id = runId ?? (claimIds.length === 1 ? claimIds[0] : undefined);
      if (!id) abort('Studio inference has no framework run identity');
      return { providerOptions: { ...providerOptions, supportAgent: { runId: id } } };
    },
  };
  const lastStepProcessor: InputProcessor = {
    id: 'answer-on-last-step',
    processInputStep({ stepNumber, systemMessages }) {
      if (stepNumber < options.maxSteps - 1) return;
      return answerNow(systemMessages);
    },
  };
  const unavailable = (options.unavailableTools ?? []).map((tool) => TOOL_LABELS[tool] ?? tool);
  const unavailableProcessor: InputProcessor = {
    id: 'unavailable-tools',
    processInputStep({ systemMessages }) {
      return {
        systemMessages: [
          ...systemMessages,
          {
            role: 'system',
            content: `These assigned tools are unavailable in this run: ${unavailable.join(', ')}. If the request needs one of them, say that it is temporarily unavailable and answer what you can without it.`,
          },
        ],
      };
    },
  };
  function runBinding(request: Parameters<typeof model.doStream>[0]) {
    const { supportAgent, ...providerOptions } = request.providerOptions ?? {};
    if (!forRun || typeof supportAgent?.runId !== 'string')
      throw new Error('Studio inference has no framework run identity');
    return {
      model: createAnswerModel(forRun(supportAgent.runId), modelOptions),
      request: { ...request, providerOptions },
    };
  }
  const boundModel = forRun
    ? {
        specificationVersion: model.specificationVersion,
        provider: model.provider,
        modelId: model.modelId,
        supportedUrls: model.supportedUrls,
        doStream(request: Parameters<typeof model.doStream>[0]) {
          const bound = runBinding(request);
          return bound.model.doStream(bound.request);
        },
        doGenerate(request: Parameters<typeof model.doGenerate>[0]) {
          const bound = runBinding(request);
          return bound.model.doGenerate(bound.request);
        },
      }
    : model;
  return {
    instructions: options.instructions,
    // Mastra 1.83 types both v4 entry points as stream results. The SDK implements
    // the runtime v4 contract, including an ordinary generation result.
    model: boundModel as unknown as MastraModelConfig,
    memory: new Memory({
      storage: options.storage,
      options: {
        lastMessages: 40,
        semanticRecall: false,
        workingMemory: { enabled: false },
        observationalMemory: false,
        generateTitle: false,
      },
    }),
    tools: {
      ask_user: askUserTool,
      ...(options.webSearch && options.model.selection.webSearch
        ? {
            web_search:
              options.model.selection.route === 'openai'
                ? openai.tools.webSearch({ externalWebAccess: true })
                : anthropic.tools.webSearch_20250305({ maxUses: 1 }),
          }
        : {}),
    },
    inputProcessors: [
      ...(forRun ? [attributionProcessor] : []),
      ...(unavailable.length > 0 ? [unavailableProcessor] : []),
      lastStepProcessor,
      new ContextBudgetProcessor(options.contextTokens),
    ],
    outputProcessors: [],
    errorProcessors: [],
    defaultOptions: {
      maxSteps: options.maxSteps,
      modelSettings: {
        maxOutputTokens: options.outputTokens,
        maxRetries: 0,
        timeout: { totalMs: timeoutMs },
      },
      ...(options.model.selection.route === 'anthropic'
        ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } } }
        : {}),
      toolCallConcurrency: 1,
      disableBackgroundTasks: true,
      autoResumeSuspendedTools: false,
      closeOnSuspend: true,
    },
    maxRetries: 0,
    maxProcessorRetries: 0,
    errorProcessorDefaults: false as const,
  };
}
