import { createHash } from 'node:crypto';
import { CoordinatorError } from './errors.js';

export function fail(code: string): never {
  throw new CoordinatorError(409, code);
}
/** A log-safe reason: the refusal code, or the error class with its system
 * code. Messages can carry identifiers or URLs and stay out of logs. */
export function reason(error: unknown): string {
  if (error instanceof CoordinatorError) return error.code;
  if (!(error instanceof Error)) return 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code)
    ? `${error.name}:${code}`
    : error.name;
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
