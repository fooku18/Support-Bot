import { describe, expect, it } from 'vitest';
import { nativeInstructions, supportPlaybook } from '../../src/application/instructions.js';

describe('support playbook', () => {
  it('is part of the built-in instructions every channel receives', () => {
    expect(nativeInstructions).toContain(supportPlaybook);
  });

  it('classifies requests and investigates per type', () => {
    for (const type of ['bug', 'question', 'data request', 'incident', 'routing', 'FYI'])
      expect(supportPlaybook).toContain(type);
  });

  it('separates verified facts from hypotheses and names what was not checked', () => {
    expect(supportPlaybook).toMatch(/verified/i);
    expect(supportPlaybook).toMatch(/hypothes[ie]s/i);
    expect(supportPlaybook).toMatch(/not check/i);
  });

  it('never settles an incident from one monitoring source and leaves severity to people', () => {
    expect(supportPlaybook).toMatch(/never confirm or deny/i);
    expect(supportPlaybook).toMatch(/single monitoring source/i);
    expect(supportPlaybook).toMatch(/monitoring itself/i);
    expect(supportPlaybook).toMatch(/deployments/i);
    expect(supportPlaybook).toMatch(/severity/i);
  });

  it('hands off instead of guessing', () => {
    expect(supportPlaybook).toMatch(/instead of guessing/i);
  });

  it('stays compact because it is sent on every step', () => {
    expect(supportPlaybook.length).toBeLessThanOrEqual(2000);
  });
});
