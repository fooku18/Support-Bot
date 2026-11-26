import { afterEach, expect, it, vi } from 'vitest';
import { createStageLogger } from '../../src/infrastructure/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('writes warnings to stderr', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  createStageLogger('scope').warn('careful');
  expect(log).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toMatch(/ warn {2}\[scope\] careful$/);
});
