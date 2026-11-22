/**
 * Unavailable-tool wording: an assigned tool the run cannot use is
 * named with its reason; a failed or pending readiness check is described as
 * usually temporary with a hint to ask again, a configuration or credential
 * problem is not.
 */
import { describe, expect, it } from 'vitest';
import {
  describeEffectiveTools,
  describeToolChanges,
  isTemporaryUnavailability,
  resolveChannelTools,
  summarizeToolCapabilities,
  type ToolCapabilitySummary,
} from '../../src/integrations/tools/tool-profile.js';

const TEMPORARY = 'This is usually temporary (a failed readiness check)';

describe('unavailable tool wording', () => {
  it('words a transient readiness failure as temporary, with the reason', () => {
    const resolved = resolveChannelTools(
      {
        teamId: 'T1',
        tools: [
          {
            kind: 'cloudflare',
            instanceId: 'ti_cf',
            label: 'Cloudflare prod',
            credentialVersion: 1,
            ready: false,
            detail: 'network (see docs/cloudflare.md troubleshooting)',
          },
        ],
      } as never,
      { gitlab: true },
    );
    const text = describeEffectiveTools(resolved.profile, resolved.unavailable);
    expect(text).toContain(
      '- Cloudflare (Cloudflare prod) is assigned to this channel but was not available when this run started: not ready (network (see docs/cloudflare.md troubleshooting)).',
    );
    expect(text).toContain(TEMPORARY);
    expect(text).toContain('suggest asking again in a minute');
  });

  it('does not call configuration or credential problems temporary', () => {
    for (const reason of [
      'not ready (invalid_auth (see docs/cloudflare.md troubleshooting))',
      'not ready (instance disabled)',
      'not ready (no credential)',
      'no host',
      'the isolated web runtime is not configured (WEB_RUNTIME_URL/WEB_RUNTIME_TOKEN)',
      'the tool runtime serves this instance for another kind or workspace',
    ]) {
      expect(isTemporaryUnavailability(reason)).toBe(false);
      const text = describeEffectiveTools({ tools: [], gitlab: null }, [
        { kind: 'atlassian', label: 'Jira', reason },
      ]);
      expect(text).toContain(`unavailable for this run: ${reason}.`);
      expect(text).toContain('needs an admin to fix');
      expect(text).not.toContain(TEMPORARY);
    }
  });

  it('treats pending readiness and an unreachable runtime as temporary', () => {
    for (const reason of [
      'not ready (waiting for runtime readiness)',
      'not ready (jira: timeout; confluence: network (see docs/atlassian.md troubleshooting))',
      'not ready (upstream_error (see docs/datadog.md troubleshooting))',
      'the tool runtime is unreachable (connect ECONNREFUSED)',
      'the tool runtime does not serve this instance yet (it syncs within seconds)',
      'the tool runtime holds another credential version; retry shortly',
    ])
      expect(isTemporaryUnavailability(reason)).toBe(true);
  });
});

describe('tool change note after a rotation', () => {
  const before: ToolCapabilitySummary = {
    available: [
      { kind: 'gitlab', label: 'GitLab' },
      { kind: 'datadog', label: 'Datadog' },
    ],
    unavailable: [
      { kind: 'cloudflare', label: 'CF', reason: 'not ready (network)' },
      { kind: 'atlassian', label: 'Jira', reason: 'not ready (jira: network)' },
    ],
  };

  it('names tools that became available with the earlier reason, and tools that went away', () => {
    const now: ToolCapabilitySummary = {
      available: [
        { kind: 'gitlab', label: 'GitLab' },
        { kind: 'cloudflare', label: 'CF' },
        { kind: 'atlassian', label: 'Jira' },
        { kind: 'webSearch', label: 'Search' },
      ],
      unavailable: [{ kind: 'datadog', label: 'Datadog', reason: 'not ready (invalid_auth)' }],
    };
    expect(describeToolChanges(before, now)).toBe(
      [
        'Your tools changed since your previous answer in this thread:',
        '- Now available: Cloudflare (CF) (unavailable then: not ready (network)); Jira/Confluence (Jira) (unavailable then: not ready (jira: network)); Web search (Search) (not assigned then).',
        '- No longer available: Datadog (Datadog) (now: not ready (invalid_auth)).',
        'If the user asks why an earlier answer did not use a tool, give the reason above; you can use the tools that are available now.',
      ].join('\n'),
    );
  });

  it('reports a configuration-only change and a missing earlier summary', () => {
    expect(describeToolChanges(before, before)).toContain(
      'The same tools are available, but their configuration changed',
    );
    expect(describeToolChanges(undefined, before)).toBe(
      'Your tools changed since your previous answer in this thread: the earlier tool list was not recorded, so compare only with the effective tools above.',
    );
  });

  it('summarizes kinds, labels and reasons only', () => {
    const summary = summarizeToolCapabilities(
      {
        tools: [],
        gitlab: {
          instanceId: 'ti_g',
          label: 'GitLab',
          host: 'gitlab.example',
          credentialVersion: 4,
        },
      },
      [{ kind: 'slack', label: 'Slack', reason: 'x'.repeat(500) }],
    );
    expect(summary.available).toEqual([{ kind: 'gitlab', label: 'GitLab' }]);
    expect(summary.unavailable[0]!.reason).toHaveLength(200);
    expect(JSON.stringify(summary)).not.toMatch(/ti_g|gitlab\.example|credentialVersion/);
  });
});
