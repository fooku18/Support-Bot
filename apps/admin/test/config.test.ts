import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { html, page } from '../src/views/html.js';

const settings: Record<string, string> = {
  ADMIN_PUBLIC_URL: 'https://admin.example.test',
  ADMIN_INTERNAL_TOKEN: 'i'.repeat(32),
  ADMIN_STORE_KEY: 'a'.repeat(64),
  ADMIN_SESSION_KEY: 'b'.repeat(64),
  SLACK_CLIENT_ID: 'synthetic-client',
  SLACK_CLIENT_SECRET: 'synthetic-secret',
};

describe('settings database configuration', () => {
  it('selects PostgreSQL explicitly or keeps the existing SQLite path', () => {
    const connectionString = 'postgresql://settings@db.example.test/settings';
    const load = (overrides: Record<string, string>) => {
      const env = { ...settings, ...overrides };
      return loadConfig((name) => env[name]).database;
    };
    expect(load({ ADMIN_DATABASE_URL: connectionString })).toEqual({ connectionString });
    expect(load({ ADMIN_DB: '/test/settings.sqlite' })).toEqual({ path: '/test/settings.sqlite' });
    expect(load({})).toEqual({ path: '/var/lib/support-agent-admin/admin.sqlite' });
    expect(() => load({ ADMIN_DATABASE_URL: '' })).toThrow(/ADMIN_DATABASE_URL/);
    expect(() => load({ ADMIN_DATABASE_URL: 'https://example.test' })).toThrow(
      /ADMIN_DATABASE_URL/,
    );
    expect(() => load({ ADMIN_DATABASE_URL: connectionString, ADMIN_DB: '/test/db' })).toThrow(
      /ADMIN_DB/,
    );
  });
});

describe('optional Mastra Studio navigation', () => {
  it('keeps empty/default configuration', () => {
    for (const value of [undefined, '', '  ']) {
      const config = loadConfig((name) => {
        return name === 'ADMIN_STUDIO_URL' ? value : settings[name];
      });
      expect(config.studioUrl).toBeNull();
      expect(config.costRetentionDays).toBe(400);
      expect(config.models).toBeNull();
      const body = page(
        'Settings',
        { adminName: 'operator', csrf: 'csrf', studioUrl: config.studioUrl },
        html``,
      );
      expect(body).not.toContain('Mastra Studio');
      expect(body).not.toContain('href="/threads"');
      for (const path of ['/workspaces', '/config', '/costs', '/admins', '/tokens', '/audit']) {
        expect(body).toContain(`href="${path}"`);
      }
    }
  });

  it('normalizes a public HTTPS origin and renders an ordinary external link only when signed in', () => {
    const config = loadConfig((name) =>
      name === 'ADMIN_STUDIO_URL' ? ' https://studio.example.test:8443/ ' : settings[name],
    );
    expect(config.studioUrl).toBe('https://studio.example.test:8443');
    const body = page(
      'Settings',
      { adminName: 'operator', csrf: 'csrf', studioUrl: config.studioUrl },
      html``,
    );
    expect(body.replace(/\s+/g, ' ')).toContain(
      'href="https://studio.example.test:8443" target="_blank" rel="noopener noreferrer"',
    );
    expect(body).toContain('Mastra Studio');
    expect(
      page('Sign in', { adminName: null, csrf: null, studioUrl: config.studioUrl }, html``),
    ).not.toContain('Mastra Studio');
  });

  it('rejects non-origins without echoing supplied values', () => {
    for (const value of [
      'http://studio.example.test',
      'javascript:alert(1)',
      '/studio',
      'https://user:synthetic-password@studio.example.test',
      'https://studio.example.test/path',
      'https://studio.example.test?secret=synthetic',
      'https://studio.example.test#fragment',
      '<operator: studio URL>',
    ]) {
      try {
        loadConfig((name) => (name === 'ADMIN_STUDIO_URL' ? value : settings[name]));
        throw new Error('Expected invalid Studio URL to be refused');
      } catch (err) {
        expect((err as Error).message).toContain('ADMIN_STUDIO_URL');
        expect((err as Error).message).not.toContain(value);
      }
    }
  });
});
