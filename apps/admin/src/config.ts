import type { SettingsDatabaseConfig } from './database.js';
import { parseModelKeys, type ModelKeys } from './models.js';

/**
 * Admin service configuration from the process environment. Diagnostics name
 * variables only; values are never printed.
 */

export interface AdminConfig {
  /** Public base URL behind the reverse proxy, e.g. https://support-agent-test-admin.example. */
  publicUrl: string;
  /** Bearer credential for /internal/* (the agent and the adapter). */
  internalToken: string;
  /** 32-byte AES-256-GCM key for stored Slack bot tokens. */
  storeKey: Buffer;
  /** HMAC key for session cookies and OAuth state. */
  sessionKey: Buffer;
  slackClientId: string;
  slackClientSecret: string;
  /** Test-only Slack Web API base URL (fake Slack); undefined is the real API. */
  slackApiUrl: string | undefined;
  /** Egress proxy for outbound Slack calls (CONNECT); undefined is direct. */
  egressProxyUrl: string | undefined;
  port: number;
  host: string;
  database: SettingsDatabaseConfig;
  /** Keys of `MODEL_CATALOG` admins choose from; null hides the model controls. */
  models: ModelKeys | null;
  /** Optional public HTTPS origin of Mastra Studio; navigation only. */
  studioUrl: string | null;
  /** Days of cost ledger rows kept (COST_RETENTION_DAYS, 30..3650, default 400). */
  costRetentionDays: number;
}

export const DEFAULT_COST_RETENTION_DAYS = 400;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const PLACEHOLDER = /^(<.+>|change-?me|placeholder|todo|xxx)$/i;

export function isPostgresUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null &&
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
    url.hostname !== '' &&
    url.pathname.length > 1 &&
    url.hash === ''
  );
}

export function loadConfig(getValue: (name: string) => string | undefined): AdminConfig {
  const problems: string[] = [];
  const value = (name: string): string => {
    const raw = (getValue(name) ?? '').trim();
    if (raw.length === 0 || PLACEHOLDER.test(raw)) {
      problems.push(`- ${name}: required; set a real value (no placeholders)`);
      return '';
    }
    return raw;
  };
  const publicUrl = value('ADMIN_PUBLIC_URL').replace(/\/+$/, '');
  if (publicUrl.length > 0) {
    try {
      const parsed = new URL(publicUrl);
      if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search !== '') {
        problems.push('- ADMIN_PUBLIC_URL: must be an https origin without path or query');
      }
    } catch {
      problems.push('- ADMIN_PUBLIC_URL: must be an https origin');
    }
  }
  const internalToken = value('ADMIN_INTERNAL_TOKEN');
  if (internalToken.length > 0 && internalToken.length < 32) {
    problems.push('- ADMIN_INTERNAL_TOKEN: must have at least 32 characters');
  }
  const hexKey = (name: string): Buffer => {
    const raw = value(name);
    if (raw.length > 0 && !/^[0-9a-fA-F]{64}$/.test(raw)) {
      problems.push(`- ${name}: must be exactly 64 hex characters (32 bytes)`);
      return Buffer.alloc(0);
    }
    return Buffer.from(raw, 'hex');
  };
  const storeKey = hexKey('ADMIN_STORE_KEY');
  const sessionKey = hexKey('ADMIN_SESSION_KEY');
  const slackClientId = value('SLACK_CLIENT_ID');
  const slackClientSecret = value('SLACK_CLIENT_SECRET');
  const slackApiUrlRaw = (getValue('SLACK_API_URL') ?? '').trim();
  let slackApiUrl: string | undefined;
  if (slackApiUrlRaw.length > 0) {
    try {
      const parsed = new URL(slackApiUrlRaw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
      slackApiUrl = slackApiUrlRaw.endsWith('/') ? slackApiUrlRaw : `${slackApiUrlRaw}/`;
    } catch {
      problems.push('- SLACK_API_URL: must be an absolute http(s) URL (test-only override)');
    }
  }
  const egressProxyUrlRaw = (getValue('EGRESS_PROXY_URL') ?? '').trim();
  let egressProxyUrl: string | undefined;
  if (egressProxyUrlRaw.length > 0) {
    try {
      const parsed = new URL(egressProxyUrlRaw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
      egressProxyUrl = egressProxyUrlRaw;
    } catch {
      problems.push('- EGRESS_PROXY_URL: must be an absolute http(s) URL of the egress proxy');
    }
  }
  const studioUrlRaw = (getValue('ADMIN_STUDIO_URL') ?? '').trim();
  let studioUrl: string | null = null;
  if (studioUrlRaw.length > 0) {
    try {
      const parsed = new URL(studioUrlRaw);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.pathname !== '/' ||
        parsed.search !== '' ||
        parsed.hash !== ''
      )
        throw new Error('origin');
      studioUrl = parsed.origin;
    } catch {
      problems.push(
        '- ADMIN_STUDIO_URL: must be an https origin without credentials, path, query or fragment',
      );
    }
  }
  const portRaw = (getValue('ADMIN_PORT') ?? '').trim();
  const port = portRaw.length === 0 ? 9883 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    problems.push('- ADMIN_PORT: must be a TCP port');
  }
  const connectionString = getValue('ADMIN_DATABASE_URL')?.trim();
  const databasePath = getValue('ADMIN_DB')?.trim();
  if (connectionString !== undefined) {
    if (!isPostgresUrl(connectionString)) {
      problems.push('- ADMIN_DATABASE_URL: must be a PostgreSQL connection URL');
    }
    if (databasePath) problems.push('- ADMIN_DB: omit when ADMIN_DATABASE_URL is set');
  }
  const database: SettingsDatabaseConfig =
    connectionString === undefined
      ? { path: databasePath || '/var/lib/support-agent-admin/admin.sqlite' }
      : { connectionString };
  const retentionRaw = (getValue('COST_RETENTION_DAYS') ?? '').trim();
  const costRetentionDays =
    retentionRaw.length === 0 ? DEFAULT_COST_RETENTION_DAYS : Number(retentionRaw);
  if (
    !/^\d+$/.test(retentionRaw || '0') ||
    !Number.isInteger(costRetentionDays) ||
    costRetentionDays < 30 ||
    costRetentionDays > 3650
  ) {
    problems.push('- COST_RETENTION_DAYS: must be a whole number of days from 30 to 3650');
  }
  if (storeKey.length > 0 && sessionKey.length > 0 && storeKey.equals(sessionKey)) {
    problems.push('- ADMIN_SESSION_KEY: must differ from ADMIN_STORE_KEY');
  }
  const parsedModels = parseModelKeys(
    getValue('MODEL_CATALOG') ?? '',
    getValue('MODEL_DEFAULT_KEY') ?? '',
    getValue('NATIVE_MODEL_STUB') === '1',
  );
  problems.push(...parsedModels.problems);
  if (problems.length > 0) {
    throw new ConfigError(
      ['Configuration errors (variable names only; values are never logged):', ...problems].join(
        '\n',
      ),
    );
  }
  return {
    publicUrl,
    internalToken,
    storeKey,
    sessionKey,
    slackClientId,
    slackClientSecret,
    slackApiUrl,
    egressProxyUrl,
    port,
    host: (getValue('ADMIN_HOST_BIND') ?? '').trim() || '0.0.0.0',
    database,
    models: parsedModels.models,
    studioUrl,
    costRetentionDays,
  };
}
