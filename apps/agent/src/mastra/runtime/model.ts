import { OAuth2Client } from 'google-auth-library';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { modelConnection } from '../../contracts/model-catalog.js';
import type { ModelBinding } from '../../integrations/providers/access.js';
import { guardedModelFetch } from '../../integrations/providers/transport.js';
import { renderInlineCitations } from './citations.js';
import { answerFailure } from './failure.js';

type FetchOptions = Omit<Parameters<typeof guardedModelFetch>[0], 'binding' | 'endpoint'>;

async function waitForVertexToken(
  authClient: Extract<ModelBinding['access'], { authClient: OAuth2Client }>['authClient'],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let stop: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    // A cancellation stops this waiter. Other runs can still consume the
    // same bounded refresh, which Google Auth shares per service account.
    const { token } = await Promise.race([authClient.getAccessToken(), interrupted]);
    if (!token) throw answerFailure('provider_auth');
    return token;
  } catch {
    throw answerFailure(signal.aborted ? 'timeout' : 'provider_auth');
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** Explicit SDK models keep credential lookup and fallback outside Mastra's model router. */
export function createAnswerModel(binding: ModelBinding, options: FetchOptions) {
  const { selection, access } = binding;
  const { route, model } = selection;
  if (modelConnection(route) !== access.connection) throw answerFailure('config');
  const transport = (endpoint: (url: URL) => boolean) =>
    guardedModelFetch({ ...options, binding, endpoint });
  const fixed =
    (...urls: string[]) =>
    (url: URL) =>
      urls.includes(url.href);
  if (access.connection === 'anthropic') {
    if (!access.apiKey.trim()) throw answerFailure('config');
    const baseURL = access.baseURL ?? `${access.origin ?? 'https://api.anthropic.com'}/v1`;
    return createAnthropic({
      baseURL,
      ...(access.bearer ? { authToken: access.apiKey } : { apiKey: access.apiKey }),
      fetch: transport(fixed(baseURL + '/messages')),
    })(model);
  }
  if (access.connection === 'openai') {
    const baseURL = access.baseURL ?? 'https://api.openai.com/v1';
    const responses = createOpenAI({
      baseURL,
      apiKey: access.apiKey,
      fetch: transport(fixed(baseURL + '/responses')),
    }).responses(model);
    function stateless<T extends Parameters<typeof responses.doStream>[0]>(request: T): T {
      const { openai, ...other } = request.providerOptions ?? {};
      return {
        ...request,
        providerOptions: {
          ...other,
          openai: {
            ...openai,
            store: false,
            previousResponseId: null,
            conversation: null,
            ...(request.tools?.some(
              (tool) => tool.type === 'provider' && tool.id === 'openai.web_search',
            )
              ? { maxToolCalls: 1 }
              : {}),
          },
        },
      };
    }
    const hasSearch = (request: Parameters<typeof responses.doStream>[0]) =>
      request.tools?.some((tool) => tool.type === 'provider' && tool.id === 'openai.web_search');
    return {
      specificationVersion: responses.specificationVersion,
      provider: responses.provider,
      modelId: responses.modelId,
      supportedUrls: responses.supportedUrls,
      async doStream(request: Parameters<typeof responses.doStream>[0]) {
        const result = await responses.doStream(stateless(request));
        if (!hasSearch(request)) return result;
        type Part = typeof result.stream extends ReadableStream<infer T> ? T : never;
        const pendingText = new Map<string, string>();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<Part, Part>({
              transform(part, controller) {
                if (part.type === 'text-delta') {
                  pendingText.set(part.id, (pendingText.get(part.id) ?? '') + part.delta);
                  return;
                }
                if (part.type === 'text-end') {
                  const text = pendingText.get(part.id);
                  pendingText.delete(part.id);
                  if (text)
                    controller.enqueue({
                      type: 'text-delta',
                      id: part.id,
                      delta: renderInlineCitations(text, part.citations ?? [], binding.onCitation),
                    });
                }
                controller.enqueue(part);
              },
            }),
          ),
        };
      },
      async doGenerate(request: Parameters<typeof responses.doGenerate>[0]) {
        const result = await responses.doGenerate(stateless(request));
        if (!hasSearch(request)) return result;
        return {
          ...result,
          content: result.content.map((part) =>
            part.type === 'text' && part.citations
              ? {
                  ...part,
                  text: renderInlineCitations(part.text, part.citations, binding.onCitation),
                }
              : part,
          ),
        };
      },
    };
  }
  const publishers =
    'baseURL' in access
      ? access.baseURL
      : `https://${access.host}/v1/projects/${access.project}/locations/${access.location}/publishers`;
  const claude = route === 'vertex-claude';
  const baseURL = publishers + (claude ? '/anthropic/models' : '/google');
  const target = claude ? `${baseURL}/${model}` : `${baseURL}/models/${model}`;
  const fetchModel = transport(
    claude
      ? fixed(target + ':rawPredict', target + ':streamRawPredict')
      : fixed(target + ':generateContent', target + ':streamGenerateContent?alt=sse'),
  );
  const sdk = (client: OAuth2Client, dispatch = fetchModel) => {
    const connection = { baseURL, googleAuthOptions: { authClient: client }, fetch: dispatch };
    return claude
      ? createVertexAnthropic(connection)(model)
      : createVertex({ ...connection, apiKey: '' })(model);
  };
  if ('apiKey' in access) {
    const client = new OAuth2Client({ credentials: { access_token: access.apiKey } });
    // Both Vertex SDKs request a bearer token from the explicit, refresh-free
    // client. Apply the gateway's wire contract at the guarded fetch boundary.
    return sdk(client, (input, init) => {
      const headers = new Headers(init?.headers);
      for (const name of ['authorization', 'x-goog-api-key', 'x-api-key']) headers.delete(name);
      if (access.authMode === 'bearer') headers.set('authorization', 'Bearer ' + access.apiKey);
      else headers.set(access.authMode, access.apiKey);
      return fetchModel(input, { ...init, headers });
    });
  }
  const { authClient } = access;
  const vertex = sdk(authClient);
  type Call = Parameters<typeof vertex.doStream>[0];
  async function prepare(request: Call) {
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = request.abortSignal
      ? AbortSignal.any([request.abortSignal, deadline])
      : deadline;
    signal.throwIfAborted();
    await options.beforeDispatch?.();
    const token = await waitForVertexToken(authClient, signal);
    signal.throwIfAborted();
    // The SDK receives the already resolved token. Its auth client has no
    // refresh credentials or ambient lookup path. Dispatch rechecks authority.
    return {
      model: sdk(new OAuth2Client({ credentials: { access_token: token } })),
      request: { ...request, abortSignal: signal },
    };
  }
  return {
    specificationVersion: vertex.specificationVersion,
    provider: vertex.provider,
    modelId: vertex.modelId,
    supportedUrls: vertex.supportedUrls,
    async doStream(request: Call) {
      const ready = await prepare(request);
      return ready.model.doStream(ready.request);
    },
    async doGenerate(request: Call) {
      const ready = await prepare(request);
      return ready.model.doGenerate(ready.request);
    },
  };
}
