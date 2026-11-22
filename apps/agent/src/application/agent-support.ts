import { createHash } from 'node:crypto';
import { CoordinatorError } from './errors.js';

export function fail(code: string): never {
  throw new CoordinatorError(409, code);
}
/** A log-safe reason: the refusal code, or only the error class. Messages can
 * carry identifiers or URLs and stay out of logs. */
export function reason(error: unknown): string {
  if (error instanceof CoordinatorError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
