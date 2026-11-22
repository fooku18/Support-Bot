import { describe, expect, it } from 'vitest';
import { describeDatadogCatalog } from '../../src/integrations/tools/runtime-client.js';

const catalog = Array.from({ length: 200 }, (_, i) => ({
  name: 'read_' + i,
  description: 'metric ' + 'x'.repeat(1000),
  inputSchema: { type: 'object', description: 'x'.repeat(25_000) },
}));

describe('Datadog catalog discovery', () => {
  it('bounds keyword matches and returns only previews even when the catalog is large', () => {
    const result = describeDatadogCatalog(catalog, { search: 'metric' });
    expect(result.ok).toBe(true);
    const previews = JSON.parse(result.output);
    expect(previews).toHaveLength(20);
    expect(previews[0]).toEqual({
      name: 'read_0',
      description: 'metric ' + 'x'.repeat(153),
    });
    expect(Buffer.byteLength(result.output)).toBeLessThan(5000);
    expect(describeDatadogCatalog(catalog, { search: 'unmatched' }).output).toBe('[]');
  });

  it('returns the complete requested schema once and refuses an oversized selection', () => {
    const one = describeDatadogCatalog(catalog, { names: ['read_13', 'read_13'] });
    expect(one.ok).toBe(true);
    expect(JSON.parse(one.output)).toEqual([catalog[13]]);
    const two = describeDatadogCatalog(catalog, { names: ['read_13', 'read_14'] });
    expect(two.ok).toBe(false);
    expect(two.output).toMatch(/fewer/);
  });

  it.each([{}, { search: '   ' }, { names: ['unknown'] }, { names: ['read_1'], search: 'metric' }])(
    'refuses an ambiguous, empty or unavailable selection without returning the catalog',
    (input) => {
      const result = describeDatadogCatalog(catalog, input);
      expect(result.ok).toBe(false);
      expect(result.output.length).toBeLessThan(100);
    },
  );
});
