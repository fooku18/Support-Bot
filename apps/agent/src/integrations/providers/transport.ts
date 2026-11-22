import type { ModelBinding } from './access.js';
import { ModelRequestAdmissionError, admitModelRequest } from './request-budget.js';
import type { RequestObservation } from './ledger.js';
import { ExecutorError } from './error.js';
import { answerFailure, providerHttpFailure } from '../../mastra/runtime/failure.js';

type Usage = Pick<RequestObservation, 'inputTokens' | 'outputTokens'>;
const MAX_ACCOUNTING_LINE = 256 * 1024;

function hostedTools(body: Record<string, unknown>, route: ModelBinding['selection']['route']) {
  if (body.tools === undefined) return [];
  if (!Array.isArray(body.tools)) throw answerFailure('config');
  return body.tools.filter((tool): tool is Record<string, unknown> => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw answerFailure('config');
    if (route === 'openai') return tool.type !== 'function';
    if (route === 'vertex-gemini')
      return Object.keys(tool).length !== 1 || !Array.isArray(tool.functionDeclarations);
    return tool.type !== undefined && tool.type !== 'custom';
  });
}

function readEvent(line: string, usage: Usage, stream: { terminal: boolean; error: boolean }) {
  const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!payload.startsWith('{')) return;
  try {
    const event = JSON.parse(payload);
    const data =
      event.message?.usage ?? event.response?.usage ?? event.usageMetadata ?? event.usage;
    const input = data?.input_tokens ?? data?.promptTokenCount;
    const output = data?.output_tokens ?? data?.candidatesTokenCount;
    if (Number.isSafeInteger(input) && input >= 0) usage.inputTokens = input;
    if (Number.isSafeInteger(output) && output >= 0) usage.outputTokens = output;
    if (
      event.type === 'message_stop' ||
      event.type === 'response.completed' ||
      event.type === 'response.incomplete' ||
      (Array.isArray(event.candidates) &&
        event.candidates.some((c: { finishReason?: string }) => c.finishReason))
    )
      stream.terminal = true;
    if (event.type === 'error' || event.type === 'response.failed' || event.error)
      stream.error = true;
  } catch {
    // The SDK interprets the provider payload. Accounting accepts counts only.
  }
}

function observeResponse(
  response: Response,
  signal: AbortSignal,
  finish: (outcome: RequestObservation['outcome'], usage?: Usage) => void,
) {
  if (!response.body) {
    finish('interrupted');
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
  const state = { terminal: false, error: false };
  const usage: Usage = { inputTokens: null, outputTokens: null };
  const onAbort = () => finish('interrupted', usage);
  let line = '';
  let discarded = false;
  const consume = (text: string) => {
    const parts = sse ? text.split('\n') : [text];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        if (!discarded) readEvent(line, usage, state);
        discarded = false;
        line = '';
      }
      const part = parts[i]!;
      if (!discarded && line.length + part.length <= MAX_ACCOUNTING_LINE) line += part;
      else {
        discarded = true;
        line = '';
      }
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const end = (outcome: RequestObservation['outcome']) => {
    signal.removeEventListener('abort', onAbort);
    finish(outcome, usage);
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            consume(decoder.decode());
            if (!discarded) readEvent(line, usage, state);
            end(state.error ? 'failed' : !sse || state.terminal ? 'completed' : 'interrupted');
            controller.close();
          } else {
            consume(decoder.decode(next.value, { stream: true }));
            controller.enqueue(next.value);
          }
        } catch (error) {
          end('interrupted');
          controller.error(error);
        }
      },
      async cancel(reason) {
        end('interrupted');
        await reader.cancel(reason);
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

export function guardedModelFetch(options: {
  binding: ModelBinding;
  endpoint: (url: URL) => boolean;
  beforeDispatch?: () => void | Promise<void>;
  authorizeSearch?: () => void | Promise<void>;
  nativeTextDocuments: boolean;
  timeoutMs: number;
}): typeof fetch {
  const { binding, endpoint, beforeDispatch, authorizeSearch, nativeTextDocuments, timeoutMs } =
    options;
  return async (input, init) => {
    const url = URL.parse(input instanceof Request ? input.url : String(input));
    if (
      !url ||
      url.username ||
      url.password ||
      url.hash ||
      !endpoint(url) ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      throw answerFailure('config');
    let body: Record<string, unknown>;
    try {
      body = admitModelRequest(
        Buffer.from(init.body),
        nativeTextDocuments,
        binding.selection.route,
      );
    } catch (error) {
      if (error instanceof ModelRequestAdmissionError) throw answerFailure('context_limit');
      throw error;
    }
    const { route, model, webSearch } = binding.selection;
    if ((route === 'anthropic' || route === 'openai') && body.model !== model)
      throw answerFailure('config');
    if (route === 'openai' && body.store !== false) throw answerFailure('config');
    const searches = hostedTools(body, route);
    const search = searches[0];
    if (
      search &&
      (!authorizeSearch ||
        !webSearch ||
        searches.length !== 1 ||
        (route === 'openai'
          ? search.type !== 'web_search' || body.max_tool_calls !== 1
          : route === 'vertex-gemini' ||
            search.type !== 'web_search_20250305' ||
            search.max_uses !== 1))
    )
      throw answerFailure('authorization_denied');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    signal.throwIfAborted();
    await beforeDispatch?.();
    if (searches.length) await authorizeSearch?.();
    signal.throwIfAborted();
    const started = performance.now();
    let status = 0;
    let recorded = false;
    const finish = (
      outcome: RequestObservation['outcome'],
      usage: Usage = { inputTokens: null, outputTokens: null },
    ) => {
      if (recorded) return;
      recorded = true;
      binding.accounting?.sink.recordRequest(binding.accounting.run, {
        completedAt: Date.now(),
        durationMs: Math.round(performance.now() - started),
        status,
        outcome,
        ...usage,
      });
    };
    try {
      const response = await (binding.fetchImpl ?? fetch)(url, {
        ...init,
        signal,
        redirect: 'error',
      });
      status = response.status;
      if (response.redirected || !response.ok) {
        finish('failed');
        await response.body?.cancel().catch(() => {});
        throw response.redirected ? answerFailure('invalid_response') : providerHttpFailure(status);
      }
      if (!binding.accounting) return response;
      return observeResponse(response, signal, finish);
    } catch (error) {
      finish(signal.aborted ? 'interrupted' : 'failed');
      if (error instanceof ExecutorError) throw error;
      throw answerFailure(signal.aborted ? 'timeout' : 'transient');
    }
  };
}
