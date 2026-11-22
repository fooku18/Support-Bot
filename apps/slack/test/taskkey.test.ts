import { describe, expect, it } from 'vitest';
import {
  buildTaskKey,
  compareTs,
  displayTaskId,
  parseTaskKey,
  TaskKeyError,
} from '../src/taskkey.js';

/**
 * Golden vectors mirroring the agent contracts (both sides are pinned
 * so the adapter cannot derive a task key the task cell would name
 * differently).
 */
const GOLDEN: Array<{
  identity: { installationId: string; teamId: string; channelId: string; rootTs: string };
  key: string;
  display: string;
}> = [
  {
    identity: {
      installationId: 'B0123456789',
      teamId: 'T0123456789',
      channelId: 'C0123456789',
      rootTs: '1716234567.123456',
    },
    key: 'v1:B0123456789:T0123456789:C0123456789:1716234567.123456',
    display: 'C0123456789:1716234567.123456',
  },
  {
    identity: {
      installationId: 'B0123456789',
      teamId: 'T0123456789',
      channelId: 'G02TEST',
      rootTs: '999.001',
    },
    key: 'v1:B0123456789:T0123456789:G02TEST:999.001',
    display: 'G02TEST:999.001',
  },
];

describe('task identity (golden vectors, mirrored with the agent contracts)', () => {
  for (const vector of GOLDEN) {
    it(`builds and displays ${vector.key}`, () => {
      expect(buildTaskKey(vector.identity)).toBe(vector.key);
      expect(displayTaskId(vector.key)).toBe(vector.display);
      expect(parseTaskKey(vector.key)).toEqual(vector.identity);
    });
  }

  it('produces a valid cell-scope name and round-trips exactly', () => {
    const key = buildTaskKey(GOLDEN[0]!.identity);
    expect(key).toMatch(/^[A-Za-z0-9_.:$-]+$/);
    expect(key.length).toBeLessThanOrEqual(255);
  });

  it('rejects malformed components', () => {
    expect(() => buildTaskKey({ ...GOLDEN[0]!.identity, installationId: 'bot!' })).toThrow(
      TaskKeyError,
    );
    expect(() => buildTaskKey({ ...GOLDEN[0]!.identity, rootTs: '12345' })).toThrow(TaskKeyError);
    expect(parseTaskKey('v2:B:T:C:1.1')).toBeUndefined();
  });
});

describe('timestamp comparison (mirrored with the agent contracts)', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareTs('90.001', '100.001')).toBe(-1);
    expect(compareTs('1716234567.123456', '1716234567.12345')).toBe(1);
    expect(compareTs('1716234567.12345', '1716234567.123450')).toBe(0);
    expect(compareTs('999.999999', '1000.000001')).toBe(-1);
  });
});
