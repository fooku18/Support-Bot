import { DEFAULT_CONTEXT_TOKENS, type ResolvedModel } from '../src/contracts/model-catalog.js';
import type { ModelBinding } from '../src/integrations/providers/access.js';

export function testSelection(key: string, model: string, webSearch = false): ResolvedModel {
  return {
    key,
    model,
    route: 'anthropic',
    webSearch,
    connection: 'anthropic',
    contextTokens: DEFAULT_CONTEXT_TOKENS,
  };
}

export function testModel(origin: string, apiKey: string, selection: ResolvedModel): ModelBinding {
  return {
    selection,
    access: { connection: 'anthropic', apiKey },
    fetchImpl(input, init) {
      const request = new URL(String(input));
      return fetch(new URL(request.pathname + request.search, origin), init);
    },
  };
}
