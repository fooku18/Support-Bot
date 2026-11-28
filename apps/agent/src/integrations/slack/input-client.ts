import type { SlackFileDescriptorDto } from '../../contracts/dto.js';
import type { NativeInputIdentity, NativeInputReceipt } from '../../domain/files/native-inputs.js';
import { NATIVE_IMAGE_BYTES } from '../../domain/files/native-inputs.js';

export interface NativeInputClient {
  acquire(
    identity: NativeInputIdentity,
    file: SlackFileDescriptorDto,
    signal: AbortSignal,
    source?: NativeInputIdentity,
  ): Promise<Buffer>;
  check(
    identity: NativeInputIdentity,
    receipts: NativeInputReceipt[],
    signal: AbortSignal,
  ): Promise<void>;
}

/** Trusted private adapter address/credential, never resolved from a model URL
 * or serialized into a framework request, snapshot or application receipt. */
export function createNativeInputClient(options: {
  baseUrl: string;
  token: string;
}): NativeInputClient {
  if (!options.token) throw new Error('native input client requires authentication');
  async function call(operation: string, body: unknown, signal: AbortSignal) {
    const response = await fetch(`${options.baseUrl}/native-inputs/${operation}`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('native input authority unavailable or changed; start a fresh thread');
    }
    return response;
  }
  return {
    async acquire(identity, file, signal, source = identity) {
      const response = await call('acquire', { identity, file, source }, signal);
      if (!response.body) throw new Error('native input bytes unavailable');
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > file.bytes || size > NATIVE_IMAGE_BYTES)
          throw new Error('native input download bounds');
        parts.push(Buffer.from(chunk));
      }
      if (size !== file.bytes) throw new Error('native input incomplete acquisition');
      return Buffer.concat(parts);
    },
    async check(identity, receipts, signal) {
      if (!receipts.length) return;
      const response = await call('check', { identity, receipts }, signal);
      // Consume the successful response: an interrupted check is unknown.
      if (!response.body) throw new Error('native input check incomplete');
      for await (const chunk of response.body)
        if (chunk.length) throw new Error('invalid native input check');
    },
  };
}
