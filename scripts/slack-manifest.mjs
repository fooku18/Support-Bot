#!/usr/bin/env node
/**
 * Prints the Slack app manifest for one instance.
 *
 *   node scripts/slack-manifest.mjs --instance-dir DIR [--name NAME]
 *
 * Reads only ADMIN_PUBLIC_URL and SUPPORT_AGENT_INSTANCE from DIR/.env.testing and
 * fills them into deploy/slack-app-settings.json: the OAuth callback becomes
 * <ADMIN_PUBLIC_URL>/slack/oauth/callback, the app and bot name default to
 * support-agent-<SUPPORT_AGENT_INSTANCE>. Prints no other env value.
 * Exit codes: 0 printed, 2 refused (missing or invalid input).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readEnvFile } from '../deploy/lib/env-contract.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(REPO_ROOT, 'deploy/slack-app-settings.json');
/** Slack limits app names to 35 characters; keep the bot name the same. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,34}$/;

/** Returns the manifest object for the given env values. Throws on invalid input. */
export function slackManifest(env, name, template = TEMPLATE) {
  let origin;
  try {
    origin = new URL(env.ADMIN_PUBLIC_URL ?? '');
  } catch {
    throw new Error('ADMIN_PUBLIC_URL is required');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error('ADMIN_PUBLIC_URL must be an HTTPS origin');
  const appName = name ?? `support-agent-${env.SUPPORT_AGENT_INSTANCE ?? ''}`;
  if (!NAME.test(appName))
    throw new Error(
      'app name must be 1-35 lowercase letters, digits, ".", "_" or "-" (set SUPPORT_AGENT_INSTANCE or --name)',
    );
  const manifest = JSON.parse(fs.readFileSync(template, 'utf8'));
  manifest.display_information.name = appName;
  manifest.features.bot_user.display_name = appName;
  manifest.oauth_config.redirect_urls = [`${origin.origin}/slack/oauth/callback`];
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { 'instance-dir': { type: 'string' }, name: { type: 'string' } },
    });
    if (!values['instance-dir'])
      throw new Error('usage: slack-manifest.mjs --instance-dir DIR [--name NAME]');
    const file = path.resolve(values['instance-dir'], '.env.testing');
    if (!fs.existsSync(file)) throw new Error(`env file missing: ${file}`);
    console.log(JSON.stringify(slackManifest(readEnvFile(file), values.name), null, 2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'Slack manifest refused');
    process.exitCode = 2;
  }
}
