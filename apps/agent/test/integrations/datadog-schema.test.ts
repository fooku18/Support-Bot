import { describe, expect, it } from 'vitest';
import {
  DatadogArgumentError,
  validateDatadogArguments,
} from '../../src/integrations/datadog/datadog-schema.js';

describe('Datadog argument validation', () => {
  it('validates against a fresh catalog schema without keeping earlier schemas registered', () => {
    const schema = () => ({
      $id: 'https://example.invalid/search_logs',
      type: 'object',
      properties: { query: { $ref: '#/definitions/query' } },
      definitions: { query: { type: 'string' } },
    });
    for (let refresh = 0; refresh < 3; refresh += 1) {
      const current = schema();
      expect(validateDatadogArguments(current, { query: 'service:web' })).toEqual({
        query: 'service:web',
      });
      expect(() => validateDatadogArguments(current, { query: 1 })).toThrow(DatadogArgumentError);
    }
  });
});
