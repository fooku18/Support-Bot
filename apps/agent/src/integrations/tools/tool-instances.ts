/**
 * Admin-managed tool instances as seen by the credential-owning runtimes
 * (cli-runtime, web-runtime) and the runner's trusted controller (D7, D9).
 *
 * - `ToolInstanceSync` polls `GET <ADMIN_URL>/internal/tool-instances`
 *   (ETag revalidation, at most `pollMs` old) and keeps the instances of the
 *   kinds this process serves. Settings are re-validated with the shared
 *   kinds module; an instance that fails validation is dropped.
 * - Secrets are fetched per instance only when its `credentialVersion`
 *   changes, and held in memory only.
 * - Readiness outcomes are reported to `POST /internal/tool-instances/status`.
 *
 * Nothing here logs or returns a credential.
 */

import {
  isToolKind,
  TOOL_INSTANCE_ID,
  validateToolInstance,
  type ToolInstanceState,
  type ToolKind,
  type ToolSettingsByKind,
} from '../../contracts/tool-kinds.js';

export type ToolInstanceCaller = 'runner' | 'cli-runtime' | 'web-runtime';

export interface SyncedToolInstance<K extends ToolKind = ToolKind> {
  id: string;
  teamId: string;
  kind: K;
  label: string;
  host: string | null;
  settings: ToolSettingsByKind[K];
  credentialVersion: number;
  hasCredential: boolean;
}

export interface ToolInstanceStatusReport {
  instanceId: string;
  state: ToolInstanceState;
  detail: string;
  credentialVersion: number;
  toolsCount?: number | null;
}

export interface AdminEndpoint {
  adminUrl: string;
  adminToken: string;
  caller: ToolInstanceCaller;
  fetchImpl?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 5_000;

function base(endpoint: AdminEndpoint): string {
  return endpoint.adminUrl.replace(/\/+$/, '');
}

function headers(endpoint: AdminEndpoint): Record<string, string> {
  return {
    authorization: `Bearer ${endpoint.adminToken}`,
    'x-support-agent-caller': endpoint.caller,
  };
}

export class ToolInstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInstanceError';
  }
}

/** Reads one instance's credential from the admin service (audited there). */
export async function fetchToolSecret(
  endpoint: AdminEndpoint,
  instanceId: string,
): Promise<{ credential: string; credentialVersion: number; teamId: string; kind: ToolKind }> {
  if (!TOOL_INSTANCE_ID.test(instanceId)) throw new ToolInstanceError('invalid tool instance ID');
  let response: Response;
  try {
    response = await (endpoint.fetchImpl ?? fetch)(
      `${base(endpoint)}/internal/tool-instances/${instanceId}/secret`,
      { headers: headers(endpoint), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
  } catch (err) {
    throw new ToolInstanceError(
      `admin service unreachable for the ${instanceId} credential: ${err instanceof Error ? err.name : 'error'}`,
    );
  }
  if (response.status === 404)
    throw new ToolInstanceError(`tool instance ${instanceId} has no usable credential`);
  if (!response.ok)
    throw new ToolInstanceError(`admin service answered HTTP ${response.status} for ${instanceId}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (
    body.id !== instanceId ||
    typeof body.credential !== 'string' ||
    body.credential.length === 0 ||
    !Number.isSafeInteger(body.credentialVersion) ||
    typeof body.teamId !== 'string' ||
    !isToolKind(body.kind)
  )
    throw new ToolInstanceError(`admin service returned an invalid credential for ${instanceId}`);
  return {
    credential: body.credential,
    credentialVersion: Number(body.credentialVersion),
    teamId: body.teamId,
    kind: body.kind,
  };
}

/** Parses one instance of the internal listing; null when it is malformed. */
export function parseSyncedInstance(raw: unknown): SyncedToolInstance | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !TOOL_INSTANCE_ID.test(entry.id)) return null;
  if (typeof entry.teamId !== 'string' || !/^T[A-Z0-9]{1,31}$/.test(entry.teamId)) return null;
  if (!Number.isSafeInteger(entry.credentialVersion) || Number(entry.credentialVersion) < 0)
    return null;
  try {
    const validated = validateToolInstance({
      kind: entry.kind,
      label: entry.label,
      host: entry.host,
      settings: entry.settings,
    });
    return {
      id: entry.id,
      teamId: entry.teamId,
      kind: validated.kind,
      label: validated.label,
      host: validated.host,
      settings: validated.settings,
      credentialVersion: Number(entry.credentialVersion),
      hasCredential: entry.hasCredential === true,
    } as SyncedToolInstance;
  } catch {
    return null;
  }
}

export interface ToolInstanceSyncOptions extends AdminEndpoint {
  /** Kinds this process serves; other instances are ignored. */
  kinds: readonly ToolKind[];
  /** Maximum listing age in ms (default 2000). */
  pollMs?: number;
  /** Called after every listing change with the instances of `kinds`. */
  onChange?(instances: ReadonlyMap<string, SyncedToolInstance>): void;
  log?(line: string): void;
}

/**
 * Keeps this process's view of the admin-managed instances current. The
 * listing is polled on a timer; `current()` answers from memory.
 */
export class ToolInstanceSync {
  private etag: string | null = null;
  private listing = new Map<string, SyncedToolInstance>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  configVersion: number | null = null;
  lastError: string | null = null;
  lastSyncMs = 0;

  constructor(private readonly options: ToolInstanceSyncOptions) {}

  get configured(): boolean {
    return this.options.adminUrl.trim().length > 0 && this.options.adminToken.trim().length > 0;
  }

  current(): ReadonlyMap<string, SyncedToolInstance> {
    return this.listing;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.syncOnce();
    this.timer = setInterval(() => void this.syncOnce(), this.options.pollMs ?? 2_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One listing revalidation; concurrent callers share it. Never throws. */
  syncOnce(): Promise<void> {
    this.syncing ??= this.pull().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async pull(): Promise<void> {
    if (!this.configured) {
      this.lastError = 'ADMIN_URL and ADMIN_INTERNAL_TOKEN are required';
      return;
    }
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        `${base(this.options)}/internal/tool-instances`,
        {
          headers: {
            ...headers(this.options),
            ...(this.etag === null ? {} : { 'if-none-match': this.etag }),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (err) {
      this.lastError = `admin unreachable: ${err instanceof Error ? err.name : 'error'}`;
      return;
    }
    if (response.status === 304) {
      this.lastError = null;
      this.lastSyncMs = Date.now();
      return;
    }
    if (!response.ok) {
      this.lastError = `admin answered HTTP ${response.status}`;
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      this.lastError = 'admin returned invalid JSON';
      return;
    }
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !Array.isArray(body.instances)
    ) {
      this.lastError = 'admin returned an invalid tool instance listing';
      return;
    }
    const next = new Map<string, SyncedToolInstance>();
    for (const raw of body.instances) {
      const instance = parseSyncedInstance(raw);
      if (instance === null) {
        this.options.log?.('tool instance sync: dropped a malformed instance');
        continue;
      }
      if (this.options.kinds.includes(instance.kind)) next.set(instance.id, instance);
    }
    this.etag = response.headers.get('etag');
    this.configVersion = Number.isSafeInteger(body.configVersion)
      ? Number(body.configVersion)
      : null;
    this.lastError = null;
    this.lastSyncMs = Date.now();
    const changed =
      next.size !== this.listing.size ||
      [...next].some(
        ([id, entry]) => JSON.stringify(this.listing.get(id)) !== JSON.stringify(entry),
      );
    this.listing = next;
    if (changed) this.options.onChange?.(next);
  }

  secret(instanceId: string): ReturnType<typeof fetchToolSecret> {
    return fetchToolSecret(this.options, instanceId);
  }

  /** Posts readiness outcomes; failures are logged, never thrown. */
  async report(statuses: ToolInstanceStatusReport[]): Promise<void> {
    if (!this.configured || statuses.length === 0) return;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${base(this.options)}/internal/tool-instances/status`,
        {
          method: 'POST',
          headers: { ...headers(this.options), 'content-type': 'application/json' },
          body: JSON.stringify({
            reporter: this.options.caller,
            statuses: statuses.slice(0, 256).map((status) => ({
              ...status,
              detail: sanitizeStatusDetail(status.detail),
            })),
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) this.options.log?.(`tool status report answered HTTP ${response.status}`);
    } catch (err) {
      this.options.log?.(`tool status report failed: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}

/** Status details are sanitized categories: one line, bounded, no control characters. */
export function sanitizeStatusDetail(detail: string): string {
  return (
    detail
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  );
}

/** Comma-separated host allowlist from the environment (D8). */
export function hostAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/** Background re-probe interval (TOOL_INSTANCE_PROBE_MS, default 5 minutes). */
export function probeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt((env.TOOL_INSTANCE_PROBE_MS ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return 300_000;
  return Math.min(Math.max(parsed, 10_000), 3_600_000);
}
