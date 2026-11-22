import { describe, expect, it } from 'vitest';
import {
  FULL_ANSWER_CHARS,
  INCOMPLETE_RESULT_HEADER,
  retainAnswer,
  resultPreview,
} from '../../src/domain/delivery/file-results.js';

describe('full results', () => {
  it('retains trailing evidence beyond the Slack limit independently of the preview', () => {
    const text = `Conclusion.\n\n${'evidence\n\n'.repeat(2000)}TRAILING-FACT-96`;
    expect(retainAnswer(text)).toEqual({ text, incomplete: false });
    expect(resultPreview(text).length).toBeLessThanOrEqual(3000);
    expect(retainAnswer(text).text).toContain('TRAILING-FACT-96');
  });
  it('does not cut inside a fenced block or invent a complete report', () => {
    expect(resultPreview('```csv\n' + 'cell\n'.repeat(2000))).toBe(
      'The result is available as a downloadable file.',
    );
    expect(resultPreview('Conclusion.\n\n~~~\n' + 'cell\n'.repeat(2000))).toBe('Conclusion.');
    const partial = retainAnswer('a'.repeat(80_000));
    expect(partial.incomplete).toBe(true);
    expect(partial.text.length).toBe(FULL_ANSWER_CHARS);
    expect(partial.text.startsWith(INCOMPLETE_RESULT_HEADER)).toBe(true);
    expect(retainAnswer(partial.text, true)).toEqual(partial);
  });
});
