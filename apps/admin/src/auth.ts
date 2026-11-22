/**
 * Local admin authentication (D2): scrypt password hashes, signed session
 * cookies with a CSRF token per session, a login lock after repeated
 * failures, hashed API tokens, and signed single-use OAuth state.
 */

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { AdminStore, AdminUser } from './store.js';

export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_TTL_MS = 12 * 3_600_000;
export const LOGIN_LOCK_WINDOW_MS = 15 * 60_000;
export const LOGIN_LOCK_FAILURES = 5;
export const SESSION_COOKIE = 'support_agent_admin_session';
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 };
const ADMIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validAdminName(name: string): boolean {
  return ADMIN_NAME.test(name);
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) =>
      err === null ? resolve(key) : reject(err),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const expectedKey = Buffer.from(expected, 'base64');
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(salt, 'base64'),
      expectedKey.length,
      { N: Number(n), r: Number(r), p: Number(p) },
      (err, derived) => (err === null ? resolve(derived) : reject(err)),
    );
  });
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
}

// Verifying against this keeps the timing of unknown and known names alike.
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`;

export type LoginResult =
  | { ok: true; admin: AdminUser }
  | { ok: false; reason: 'locked' | 'invalid' | 'busy' };

/** Password checks running at once (scrypt is deliberately expensive). */
export const MAX_CONCURRENT_LOGINS = 4;
let loginsInFlight = 0;

/**
 * Signs an admin in. The lock check and the attempt's reservation happen
 * in a transaction before the password check, so parallel requests
 * cannot all pass the check: every attempt counts as a failure
 * until it succeeds. Audit rows stay bounded: at most the failures up to the
 * lock plus one `locked` row per name and window.
 */
export async function login(
  store: AdminStore,
  name: string,
  password: string,
): Promise<LoginResult> {
  const key = name.slice(0, 64);
  let reserved = false;
  try {
    const attempt = await store.transaction(async () => {
      const failures = await store.recentLoginFailures(key, Date.now() - LOGIN_LOCK_WINDOW_MS);
      if (failures >= LOGIN_LOCK_FAILURES) {
        if (failures === LOGIN_LOCK_FAILURES) {
          // Advance the count so further refusals within the window write nothing.
          await store.recordLoginFailure(key);
          await store.audit('anonymous', 'admin.login.locked', key);
        }
        return 'locked' as const;
      }
      if (loginsInFlight >= MAX_CONCURRENT_LOGINS) return 'busy' as const;
      loginsInFlight += 1;
      reserved = true;
      return store.recordLoginFailure(key);
    });
    if (typeof attempt === 'string') return { ok: false, reason: attempt };
    const admin = validAdminName(name) ? await store.adminByName(name) : null;
    const valid = await verifyPassword(password, admin?.passwordHash ?? DUMMY_HASH);
    if (admin === null || admin.disabled || !valid) {
      await store.audit('anonymous', 'admin.login.failed', key);
      return { ok: false, reason: 'invalid' };
    }
    await store.transaction(async () => {
      await store.clearLoginFailure(attempt);
      await store.audit(admin.name, 'admin.login', admin.name);
    });
    return { ok: true, admin };
  } finally {
    if (reserved) loginsInFlight -= 1;
  }
}

export class Sessions {
  constructor(
    private readonly store: AdminStore,
    private readonly key: Buffer,
  ) {}

  private sign(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }

  /** Creates a session and returns the cookie value. */
  async create(admin: AdminUser): Promise<string | null> {
    const id = randomBytes(32).toString('base64url');
    return this.store.transaction(async () => {
      const current = await this.store.adminById(admin.id);
      if (current === null || current.disabled || current.passwordHash !== admin.passwordHash)
        return null;
      await this.store.createSession(
        id,
        admin.id,
        randomBytes(24).toString('base64url'),
        Date.now() + SESSION_TTL_MS,
      );
      return `${id}.${this.sign(id)}`;
    });
  }

  /** Resolves a cookie value to its live session and enabled admin. */
  async resolve(
    cookie: string | undefined,
  ): Promise<{ id: string; admin: AdminUser; csrf: string } | null> {
    if (cookie === undefined) return null;
    const [id, mac] = cookie.split('.');
    if (id === undefined || mac === undefined || !safeEqual(mac, this.sign(id))) return null;
    const session = await this.store.session(id);
    return session === null ? null : { id, ...session };
  }

  async destroy(id: string): Promise<void> {
    await this.store.deleteSession(id);
  }

  /** Signed, single-use OAuth `state` for the Slack install redirect. */
  async oauthState(): Promise<string> {
    const nonce = randomBytes(24).toString('base64url');
    await this.store.saveOauthState(nonce, Date.now() + OAUTH_STATE_TTL_MS);
    return `${nonce}.${this.sign(`oauth:${nonce}`)}`;
  }

  async consumeOauthState(state: string): Promise<boolean> {
    const [nonce, mac] = state.split('.');
    if (nonce === undefined || mac === undefined) return false;
    if (!safeEqual(mac, this.sign(`oauth:${nonce}`))) return false;
    return await this.store.consumeOauthState(nonce);
  }
}

export function newApiToken(): string {
  return `cat_${randomBytes(32).toString('base64url')}`;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}
