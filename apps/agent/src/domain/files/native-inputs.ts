import type { IntakeRequest, SlackFileDescriptorDto } from '../../contracts/dto.js';

/** Native answer input contract. No URL, credential, output or sandbox handle. */
export type NativeInputIdentity = Pick<
  IntakeRequest,
  'installationId' | 'teamId' | 'channelId' | 'rootTs' | 'messageTs' | 'userId' | 'authorBotId'
>;
export interface NativeInputReceipt {
  identity: NativeInputIdentity;
  file: SlackFileDescriptorDto;
  sha256: string;
}
export const NATIVE_INPUT_VERSION = 'answer-inputs@1';
export const NATIVE_INPUT_COUNT = 4;
export const NATIVE_INPUT_BYTES = 6 * 1024 ** 2;
export const NATIVE_TEXT_BYTES = 200 * 1024;
export const NATIVE_IMAGE_BYTES = 2 * 1024 ** 2;
export const NATIVE_TEXT_TYPES = [
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'text/markdown',
];
export const NATIVE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Refuse the whole request rather than silently drop an input. Reconstruct the
 * public descriptor; event URL/token/extra fields never cross this boundary. */
export function nativeInputFiles(value: unknown, messageTs: string): SlackFileDescriptorDto[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > NATIVE_INPUT_COUNT)
    throw new Error('native_input_count_limit');
  const seen = new Set<string>();
  let total = 0;
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('native_input_invalid');
    const f = raw as SlackFileDescriptorDto;
    const limit = NATIVE_TEXT_TYPES.includes(f.mime)
      ? NATIVE_TEXT_BYTES
      : NATIVE_IMAGE_TYPES.includes(f.mime)
        ? NATIVE_IMAGE_BYTES
        : 0;
    if (!limit) throw new Error('native_input_unsupported_format');
    if (
      !/^F[A-Z0-9]{1,40}$/.test(f.id) ||
      f.sourceTs !== messageTs ||
      !/^[0-9]+\.[0-9]+$/.test(f.sourceTs) ||
      !/^[a-f0-9]{64}$/.test(f.revision) ||
      f.hosted !== true ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes <= 0 ||
      f.bytes > limit ||
      typeof f.name !== 'string' ||
      f.name.length > 160 ||
      /[\p{Cc}/\\]/u.test(f.name) ||
      seen.has(f.id) ||
      (total += f.bytes) > NATIVE_INPUT_BYTES
    )
      throw new Error('native_input_invalid_or_over_bounds');
    seen.add(f.id);
    return {
      id: f.id,
      sourceTs: f.sourceTs,
      name: f.name,
      mime: f.mime,
      bytes: f.bytes,
      revision: f.revision,
      hosted: true,
    };
  });
}
