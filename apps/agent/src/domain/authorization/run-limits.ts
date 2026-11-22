/**
 * The admin document's `runLimits` section: the deployment-wide limits of a
 * coding run (admin Configuration page). ConfigSync validates it before
 * caching a document (a malformed section refuses the whole document, like a
 * refused policy); a document without the section, or no document at all,
 * uses the defaults below (the admin service's defaults).
 */

import type { RunLimitsDto } from '../../contracts/dto.js';

export const DEFAULT_RUN_LIMITS: RunLimitsDto = {
  maxToolCalls: 300,
  maxCostUsd: 10,
  maxActiveMinutes: 30,
  pauseWaitMinutes: 30,
  toolTimeoutMs: 60_000,
  maxOutputBytes: 200_000,
};

/** Same bounds as the admin service validates. */
const BOUNDS: Record<keyof RunLimitsDto, readonly [number, number]> = {
  maxToolCalls: [1, 10_000],
  maxCostUsd: [0.01, 1_000],
  maxActiveMinutes: [1, 1_440],
  pauseWaitMinutes: [1, 120],
  toolTimeoutMs: [1_000, 600_000],
  maxOutputBytes: [1_000, 10_000_000],
};

export class RunLimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLimitsError';
  }
}

/** Validates a `runLimits` section; `undefined` (no section) is the defaults. */
export function parseRunLimits(value: unknown): RunLimitsDto {
  if (value === undefined) return { ...DEFAULT_RUN_LIMITS };
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new RunLimitsError('runLimits must be an object');
  const input = value as Record<string, unknown>;
  const limits = { ...DEFAULT_RUN_LIMITS };
  for (const key of Object.keys(BOUNDS) as Array<keyof RunLimitsDto>) {
    const raw = input[key];
    const [min, max] = BOUNDS[key];
    const integral = key !== 'maxCostUsd';
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      (integral && !Number.isInteger(raw)) ||
      raw < min ||
      raw > max
    )
      throw new RunLimitsError(`runLimits.${key} must be a number between ${min} and ${max}`);
    limits[key] = raw;
  }
  return limits;
}
