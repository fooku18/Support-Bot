import { parseCoordinatorAdminDocument, type CoordinatorAdminDocument } from './admin-document.js';

export type ConfigSyncResult =
  | { status: 'applied' | 'unchanged'; version: number; adminHash: string }
  | { status: 'unavailable'; reason: 'fetch' | 'response' | 'document' | 'apply' };

/** Trusted maintenance-side transport. The sink must acknowledge the validated
 * document's durable configuration commit. This transport
 * never supplies a runtime pool, policy default, or model-visible credential.
 * Admin ETags name the source document, not the coordinator's derived hash.
 */
export function createAdminConfigSync(options: {
  adminUrl: string;
  adminToken: string;
  applyDocument(document: CoordinatorAdminDocument): Promise<void>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}) {
  const base = new URL(options.adminUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !options.adminToken
  )
    throw new Error('invalid coordinator admin synchronization configuration');
  const endpoint = `${base.href.replace(/\/+$/, '')}/internal/config`;
  const request = options.fetch ?? fetch;
  let accepted: { version: number; adminHash: string } | undefined;
  let pending: Promise<ConfigSyncResult> | undefined;

  async function pull(): Promise<ConfigSyncResult> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(1500),
      ...(options.signal ? [options.signal] : []),
    ]);
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await request(endpoint, {
        redirect: 'error',
        headers: {
          authorization: `Bearer ${options.adminToken}`,
          ...(accepted ? { 'if-none-match': `"${accepted.adminHash}"` } : {}),
        },
        signal,
      });
    } catch {
      return { status: 'unavailable', reason: 'fetch' };
    }
    if (response.status === 304)
      return accepted
        ? { status: 'unchanged', ...accepted }
        : { status: 'unavailable', reason: 'response' };
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { status: 'unavailable', reason: 'response' };
    }
    let document: CoordinatorAdminDocument;
    try {
      if (!response.body) throw new Error('missing document');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024) throw new Error('document too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      signal.throwIfAborted();
      document = parseCoordinatorAdminDocument(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
      ).document;
    } catch {
      return { status: 'unavailable', reason: 'document' };
    }
    // No ETag is advanced on a failed or unknown commit acknowledgement. The
    // next pull re-applies by the store's version/hash identity, without a retry
    // loop here. Last accepted policy remains owned by the durable store.
    const sourceIdentity = { version: document.version, adminHash: document.hash };
    try {
      await options.applyDocument(document);
    } catch {
      return { status: 'unavailable', reason: 'apply' };
    }
    accepted = sourceIdentity;
    return { status: 'applied', ...accepted };
  }

  return {
    refresh(): Promise<ConfigSyncResult> {
      pending ??= pull().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
