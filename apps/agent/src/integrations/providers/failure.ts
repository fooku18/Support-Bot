/** Fixed public failure labels; provider error text never reaches delivery. */
export type ClaudeFailureCategory =
  | 'provider_auth'
  | 'model_unavailable'
  | 'timeout'
  | 'context_limit'
  | 'output_limit'
  | 'invalid_response'
  | 'transient'
  | 'interrupted'
  | 'budget_exhausted'
  | 'config'
  | 'authorization_denied'
  | 'storage_pressure'
  | 'verification_failed'
  | 'needs_recovery'
  | 'publication_failed'
  | 'turn_limit'
  | 'retention_expired';

/**
 * Fixed category labels for Slack/outbox delivery. Provider detail is discarded,
 * since arbitrary credentials and reflected conversation text cannot be reliably scrubbed.
 * Only `storage_pressure` appends a scrubbed admission-reason detail (byte counts
 * plus fixed words; never tokens, transcripts, or Slack text).
 */
export function sanitizeFailureForSlack(category: ClaudeFailureCategory, detail: string): string {
  const labels: Record<ClaudeFailureCategory, string> = {
    provider_auth: 'Model provider authentication or access failed',
    model_unavailable: 'Configured model is unavailable',
    timeout: 'Model inference timed out',
    context_limit:
      'Model request exceeded a context or attachment limit; send a new message to retry with fresh thread context',
    output_limit: 'The model answer exceeded the configured output limit',
    invalid_response: 'The model returned an empty or invalid answer',
    transient: 'Model provider request failed; send a new message in this thread to retry',
    interrupted: 'Model inference was interrupted',
    budget_exhausted: 'Inference budget exhausted',
    config: 'Model execution is misconfigured',
    authorization_denied: 'This operation is not authorized for the Slack actor',
    storage_pressure: 'Storage capacity is full — new work paused',
    verification_failed: 'Independent verification failed',
    needs_recovery: 'Workspace or session needs operator recovery',
    publication_failed: 'Publication needs a task-scoped retry; verified work is retained',
    turn_limit: 'The model reached the configured turn limit. Reply in this thread to continue.',
    retention_expired:
      'An expired clarification question left unpublished files that fence new work in this thread',
  };
  if (category === 'retention_expired') {
    // only checkout directory names (validated), never content; the
    // coordinator renders the recovery notice from them.
    const names = detail
      .split(',')
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z0-9_.-]{1,120}$/.test(name))
      .slice(0, 10);
    return `retention_expired: ${names.join(', ')}`.slice(0, 200);
  }
  if (category === 'storage_pressure') {
    return appendScrubbedStorageDetail(labels[category], detail);
  }
  void detail; // Internal diagnostics are never published.
  return labels[category];
}

/**
 * Scrubs an admission reason for thread delivery: the same token regexes as
 * the app-side sanitizer, single-line whitespace, truncated to 120 chars so
 * the stored error plus label stays within the 200-char runFail bound and the
 * threaded reply stays within its 160-char reason bound.
 */
export function appendScrubbedStorageDetail(label: string, detail: string): string {
  const scrubbed = detail
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, '[redacted]')
    .replace(/xox[bap]-[A-Za-z0-9-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (scrubbed.length === 0) return label;
  return `${label}: ${scrubbed}`;
}
