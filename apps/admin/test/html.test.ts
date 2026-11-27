import { describe, expect, it } from 'vitest';
import { count } from '../src/views/html.js';

describe('count', () => {
  it('keeps separators below 100k and shortens larger counts', () => {
    expect(count(99_999)).toBe('99,999');
    expect(count(123_456)).toBe('123k');
    expect(count(1_234_567)).toBe('1.23M');
    expect(count(18_400_000)).toBe('18.4M');
  });

  it('moves to the next unit when rounding reaches it', () => {
    expect(count(999_499)).toBe('999k');
    expect(count(999_500)).toBe('1.00M');
    expect(count(999_999)).toBe('1.00M');
    expect(count(9_994_999)).toBe('9.99M');
    expect(count(9_995_000)).toBe('10.0M');
    expect(count(9_999_999)).toBe('10.0M');
  });
});
