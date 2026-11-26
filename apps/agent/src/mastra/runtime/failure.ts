import type { ClaudeFailureCategory } from '../../contracts/protocol.js';
import { sanitizeFailureForSlack } from '../../integrations/providers/failure.js';
import { ExecutorError } from '../../integrations/providers/error.js';

export function answerFailure(category: ClaudeFailureCategory): ExecutorError {
  return new ExecutorError(`${category}: ${sanitizeFailureForSlack(category)}`);
}

/** Classify an HTTP refusal without retaining upstream content. */
export function providerHttpFailure(status: number): ExecutorError {
  if (status === 401 || status === 403) return answerFailure('provider_auth');
  if (status === 404) return answerFailure('model_unavailable');
  if (status === 408 || status === 504) return answerFailure('timeout');
  if (status === 413) return answerFailure('context_limit');
  if (status === 429 || status >= 500) return answerFailure('transient');
  return answerFailure('invalid_response');
}
