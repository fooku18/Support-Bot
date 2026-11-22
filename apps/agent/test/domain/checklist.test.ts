import { describe, expect, it } from 'vitest';
import {
  parseChecklist,
  parseProjectEvidence,
  renderChecklist,
  safeChecklistLabel,
} from '../../src/domain/delivery/checklist.js';

describe('bounded task checklist', () => {
  const snapshot = {
    objectiveRunId: 'run-1',
    runId: 'run-1',
    attempt: 1,
    revision: 2,
    items: [{ ordinal: 1, label: 'Inspect requirement', status: 'in_progress' }],
  };
  it('validates revision-scoped ordinal identities and bounds', () => {
    expect(parseChecklist(snapshot)).toEqual(snapshot);
    expect(() =>
      parseChecklist({ ...snapshot, items: Array(7).fill(snapshot.items[0]) }),
    ).toThrow();
    expect(() =>
      parseChecklist({ ...snapshot, items: [{ ...snapshot.items[0], ordinal: 2 }] }),
    ).toThrow();
    expect(() =>
      parseChecklist({ ...snapshot, items: [{ ...snapshot.items[0], label: 'a'.repeat(81) }] }),
    ).toThrow();
    expect(() => parseChecklist({ ...snapshot, revision: -1 })).toThrow();
  });
  it('redacts before bounding and removes active Slack syntax, paths and commands', () => {
    const label = safeChecklistLabel(
      'Use <!channel> <@U123> https://secret.invalid/a `cat /etc/passwd` token=privatevalue sk-1234567890',
    );
    expect(label).not.toMatch(/channel|U123|https:|passwd|privatevalue|sk-|[<>`@]/);
    expect(label.length).toBeLessThanOrEqual(80);
  });
  it('distinguishes model claims from controller evidence', () => {
    expect(renderChecklist(parseChecklist(snapshot), [])).toContain('Model plan');
    expect(renderChecklist(parseChecklist(snapshot), [])).not.toContain('Verify: passed');
  });
  it('rejects arrays and objects instead of coercing enum values', () => {
    expect(() =>
      parseChecklist({ ...snapshot, items: [{ ...snapshot.items[0], status: ['completed'] }] }),
    ).toThrow();
    const row = {
      project: 'group/project',
      treeDigest: 'a'.repeat(64),
      verification: 'passed',
      publication: 'published',
    };
    for (const field of ['verification', 'publication'])
      for (const value of [['passed'], ['published'], {}, null, 1])
        expect(() => parseProjectEvidence([{ ...row, [field]: value }])).toThrow();
  });
});
