import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// @ts-expect-error operational JavaScript
import { slackManifest } from '../../scripts/slack-manifest.mjs';

const template = JSON.parse(fs.readFileSync('deploy/slack-app-settings.json', 'utf8'));

describe('slack:manifest', () => {
  it('fills the callback and name and keeps scopes, events and Socket Mode', () => {
    const m = slackManifest({
      ADMIN_PUBLIC_URL: 'https://admin.example.test:8443',
      SUPPORT_AGENT_INSTANCE: 'alice',
    });
    expect(m.oauth_config.redirect_urls).toEqual([
      'https://admin.example.test:8443/slack/oauth/callback',
    ]);
    expect(m.display_information.name).toBe('support-agent-alice');
    expect(m.features.bot_user.display_name).toBe('support-agent-alice');
    expect(m.oauth_config.scopes).toEqual(template.oauth_config.scopes);
    expect(m.settings).toEqual(template.settings);
    expect(
      slackManifest({ ADMIN_PUBLIC_URL: 'https://a.test', SUPPORT_AGENT_INSTANCE: 'x' }, 'bob-test')
        .display_information.name,
    ).toBe('bob-test');
  });
  it('refuses a non-HTTPS origin, a path and an invalid name', () => {
    for (const url of ['http://a.test', 'https://a.test/admin', 'https://a.test/?x=1', ''])
      expect(() => slackManifest({ ADMIN_PUBLIC_URL: url, SUPPORT_AGENT_INSTANCE: 'x' })).toThrow(
        'ADMIN_PUBLIC_URL',
      );
    for (const name of ['Bad Name', 'x'.repeat(36), '-x'])
      expect(() => slackManifest({ ADMIN_PUBLIC_URL: 'https://a.test' }, name)).toThrow('app name');
  });
  it('prints only the manifest, never other env values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-manifest-'));
    try {
      fs.writeFileSync(
        path.join(dir, '.env.testing'),
        'ADMIN_PUBLIC_URL=https://a.test\nSUPPORT_AGENT_INSTANCE=t\nSLACK_CLIENT_SECRET=never-print-this\n',
      );
      const r = spawnSync(process.execPath, ['scripts/slack-manifest.mjs', '--instance-dir', dir], {
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).display_information.name).toBe('support-agent-t');
      expect(r.stdout + r.stderr).not.toContain('never-print-this');
      expect(spawnSync(process.execPath, ['scripts/slack-manifest.mjs']).status).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
