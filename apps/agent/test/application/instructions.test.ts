import { describe, expect, it } from 'vitest';
import { nativeInstructions, supportPlaybook } from '../../src/application/instructions.js';

const staging = { maxSteps: 12, timeoutMs: 120000 };

describe('support playbook', () => {
  it('is part of the built-in instructions every channel receives', () => {
    expect(nativeInstructions(staging)).toContain(supportPlaybook);
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
    expect(supportPlaybook).toMatch(/same monitoring system count as one/i);
    expect(supportPlaybook).toMatch(/deployments/i);
    expect(supportPlaybook).toMatch(/severity/i);
  });

  it('hands off instead of guessing', () => {
    expect(supportPlaybook).toMatch(/instead of guessing/i);
  });

  it('links earlier reports of the same problem or says none were found', () => {
    expect(supportPlaybook).toMatch(/earlier reports/i);
    expect(supportPlaybook).toMatch(/one to three/i);
    expect(supportPlaybook).toMatch(/permalink/i);
    expect(supportPlaybook).toMatch(/no earlier report was found/i);
  });

  it('stays compact because it is sent on every step', () => {
    expect(supportPlaybook.length).toBeLessThanOrEqual(2400);
  });
});

describe('run budget', () => {
  it('states the step and time limits the run is executed with', () => {
    expect(nativeInstructions(staging)).toContain('at most 12 steps and 120 seconds');
    expect(nativeInstructions({ maxSteps: 40, timeoutMs: 600000 })).toContain(
      'at most 40 steps and 600 seconds',
    );
  });

  it('says the last step allows no tool calls', () => {
    expect(nativeInstructions(staging)).toContain('the last step allows no tool calls');
  });
});
