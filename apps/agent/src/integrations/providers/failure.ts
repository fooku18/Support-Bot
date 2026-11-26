/** Fixed public failure labels; provider error text never reaches delivery. */
import type { ClaudeFailureCategory } from '../../contracts/protocol.js';

/**
 * Fixed category labels for Slack/outbox delivery. Provider detail is discarded,
 * since arbitrary credentials and reflected conversation text cannot be reliably scrubbed.
 */
export function sanitizeFailureForSlack(category: ClaudeFailureCategory): string {
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
  return labels[category];
}
