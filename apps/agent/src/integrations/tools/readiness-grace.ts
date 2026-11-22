/**
 * Transient readiness failures. A single failed DNS lookup in a
 * periodic probe used to flip an instance to not ready until the next probe,
 * and a run claimed in that window lost the tool. The Atlassian, Datadog,
 * Cloudflare and Slack providers share two defences:
 *
 * - in-probe retry: a transient failure is retried (3 attempts, 3 s apart,
 *   as the GitLab probe does) before the probe counts as failed;
 * - last-good grace: a probe that still fails only transiently while the
 *   instance was ready keeps the last good readiness and binding, until
 *   `READINESS_GRACE_FAILURES` consecutive failures or `READINESS_GRACE_MS`
 *   since the first one, whichever comes first.
 *
 * Definitive categories (rejected or under-scoped credentials, mismatched
 * site/workspace/zone, unexpected shapes) never get either: they flip the
 * instance to not ready at once.
 */

/** Categories that say the service was not reached or answered with a server-side failure. */
export const TRANSIENT_READINESS_CATEGORIES: ReadonlySet<string> = new Set([
  'network',
  'timeout',
  'upstream_error',
  'rate_limit',
]);

export function isTransientReadinessCategory(category: string | null): boolean {
  return category !== null && TRANSIENT_READINESS_CATEGORIES.has(category);
}

export const READINESS_PROBE_ATTEMPTS = 3;
export const READINESS_PROBE_RETRY_MS = 3_000;
/** Consecutive transient probe failures tolerated while the last good readiness is kept. */
export const READINESS_GRACE_FAILURES = 3;
/** The last good readiness is kept at most this long after the first transient failure. */
export const READINESS_GRACE_MS = 10 * 60_000;

/** Retry and grace bounds of one provider (tests shorten the delay). */
export interface ReadinessRetryOptions {
  attempts?: number;
  retryDelayMs?: number;
  graceFailures?: number;
  graceMs?: number;
}

/**
 * Runs `once` until it succeeds or fails definitively, at most `attempts`
 * times; returns the last outcome.
 */
export async function probeWithRetry<T>(
  once: () => Promise<T>,
  categoryOf: (outcome: T) => string | null,
  options: ReadinessRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? READINESS_PROBE_ATTEMPTS);
  const delay = options.retryDelayMs ?? READINESS_PROBE_RETRY_MS;
  let outcome = await once();
  for (let attempt = 2; attempt <= attempts; attempt += 1) {
    if (!isTransientReadinessCategory(categoryOf(outcome))) break;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    outcome = await once();
  }
  return outcome;
}

/** Consecutive transient failures of one readiness subject (an instance or a product). */
export class ReadinessGrace {
  private failures = 0;
  private firstFailureAtMs: number | null = null;
  /** Set while a held failure is reported: `network (1 of 3 tolerated)`. */
  held: string | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: ReadinessRetryOptions = {},
  ) {}

  /**
   * Records a probe outcome and decides whether the last good readiness is
   * kept: true only for a transient failure of an instance that was ready,
   * within the grace bounds. Success and definitive failures reset it.
   */
  hold(category: string | null, wasReady: boolean): boolean {
    if (category === null || !wasReady || !isTransientReadinessCategory(category)) {
      this.failures = 0;
      this.firstFailureAtMs = null;
      this.held = null;
      return false;
    }
    const limit = this.options.graceFailures ?? READINESS_GRACE_FAILURES;
    const graceMs = this.options.graceMs ?? READINESS_GRACE_MS;
    this.failures += 1;
    this.firstFailureAtMs ??= this.now();
    if (this.failures >= limit || this.now() - this.firstFailureAtMs >= graceMs) {
      this.held = null;
      return false;
    }
    this.held = `${category} (${this.failures} of ${limit - 1} tolerated)`;
    return true;
  }

  /** Detail suffix while a failure is held (empty otherwise). */
  note(): string {
    return this.held === null
      ? ''
      : `; the last probe failed transiently: ${this.held}, the last good readiness is kept`;
  }
}
