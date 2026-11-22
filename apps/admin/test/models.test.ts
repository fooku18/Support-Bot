import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { parseModelKeys } from '../src/models.js';

const catalog = JSON.stringify([
  { key: 'sonnet', route: 'anthropic', model: 'claude-sonnet', webSearch: true },
  { key: 'opus', route: 'vertex-claude', model: 'claude-opus@20250514' },
]);

describe('parseModelKeys', () => {
  it('reads the keys of MODEL_CATALOG and the default key', () => {
    expect(parseModelKeys(catalog, 'sonnet')).toMatchObject({
      models: { keys: ['sonnet', 'opus'], defaultKey: 'sonnet' },
      problems: [],
    });
  });

  it('hides the model controls without an allowlist', () => {
    expect(parseModelKeys('', '')).toEqual({ models: null, problems: [] });
  });

  it('fails closed on malformed lists and a default outside the list', () => {
    for (const [models, defaultKey] of [
      ['sonnet', 'sonnet'],
      ['default=x', 'default'],
      ['Sonnet=x', 'Sonnet'],
      ['sonnet=x,sonnet=y', 'sonnet'],
      ['sonnet=x', 'opus'],
      ['', 'sonnet'],
    ] as const) {
      const parsed = parseModelKeys(models, defaultKey);
      expect(parsed.models).toBeNull();
      expect(parsed.problems.length).toBeGreaterThan(0);
    }
  });

  it('is part of the admin configuration and names variables only', () => {
    const env: Record<string, string> = {
      ADMIN_PUBLIC_URL: 'https://admin.example.test',
      ADMIN_INTERNAL_TOKEN: 'i'.repeat(32),
      ADMIN_STORE_KEY: 'a'.repeat(64),
      ADMIN_SESSION_KEY: 'b'.repeat(64),
      SLACK_CLIENT_ID: 'client',
      SLACK_CLIENT_SECRET: 'secret',
      MODEL_CATALOG: catalog,
      MODEL_DEFAULT_KEY: 'opus',
    };
    expect(loadConfig((name) => env[name]).models).toMatchObject({
      keys: ['sonnet', 'opus'],
      defaultKey: 'opus',
    });
    expect(() => loadConfig((name) => ({ ...env, MODEL_DEFAULT_KEY: 'haiku' })[name])).toThrow(
      /MODEL_DEFAULT_KEY/,
    );
  });
});
