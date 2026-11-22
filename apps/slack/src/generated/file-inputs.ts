/** GENERATED from apps/agent/src/domain/files/file-inputs.ts; run npm run generate:protocol. */
import type { SlackFileDescriptorDto } from './protocol.js';

export const FILE_INVENTORY_LIMIT = 200;
export const FILE_RUN_BYTES = 100 * 1024 * 1024;
export interface SelectedInput {
  file: SlackFileDescriptorDto;
  status: 'selected' | 'rejected' | 'not_loaded';
  reason: string;
}

/** Selection never elevates a model-supplied ID into authority. */
export function selectInputs(
  files: readonly SlackFileDescriptorDto[],
  triggerTs: string,
  mode: 'claude' | 'claude-code',
): SelectedInput[] {
  if (files.length > FILE_INVENTORY_LIMIT)
    throw new Error('file inventory exceeds 200 entries; file processing refused');
  const ordered = [...files].sort((a, b) => {
    const trigger = Number(b.sourceTs === triggerTs) - Number(a.sourceTs === triggerTs);
    return (
      trigger ||
      b.sourceTs.localeCompare(a.sourceTs, 'en', { numeric: true }) ||
      a.id.localeCompare(b.id)
    );
  });
  const countLimit = mode === 'claude' ? 10 : 20;
  let count = 0;
  let bytes = 0;
  const seen = new Set<string>();
  return ordered.map((file) => {
    let reason = '';
    const image = ['image/png', 'image/jpeg', 'image/webp'].includes(file.mime);
    const text = ['text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown'].includes(
      file.mime,
    );
    const max = image
      ? 5 * 1024 ** 2
      : file.mime === 'application/pdf'
        ? 20 * 1024 ** 2
        : text
          ? mode === 'claude'
            ? 200 * 1024
            : 50 * 1024 ** 2
          : 0;
    if (!file.hosted) reason = 'only Slack-hosted files are supported';
    else if (max === 0) reason = 'unsupported file type';
    else if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > max)
      reason = 'file exceeds the mode/type byte limit';
    if (reason) return { file, status: 'rejected', reason };
    if (seen.has(file.id)) return { file, status: 'not_loaded', reason: 'duplicate attachment' };
    seen.add(file.id);
    if (count >= countLimit || bytes + file.bytes > FILE_RUN_BYTES)
      return { file, status: 'not_loaded', reason: 'run file count or byte budget exhausted' };
    count += 1;
    bytes += file.bytes;
    return { file, status: 'selected', reason: 'selected; bytes not yet processed' };
  });
}

export function parseFileDescriptors(value: unknown, sourceTs: string): SlackFileDescriptorDto[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > FILE_INVENTORY_LIMIT)
    throw new Error('file inventory exceeds 200 entries');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('invalid file descriptor');
    const file = raw as Record<string, unknown>;
    if (typeof file.id !== 'string' || !/^F[A-Z0-9]+$/.test(file.id))
      throw new Error('invalid Slack file ID');
    return {
      id: file.id,
      sourceTs,
      name:
        typeof file.name === 'string'
          ? file.name.replace(/[\p{Cc}/\\]/gu, '_').slice(0, 160)
          : 'attachment',
      mime: typeof file.mime === 'string' ? file.mime.slice(0, 100) : 'application/octet-stream',
      bytes: typeof file.bytes === 'number' && Number.isSafeInteger(file.bytes) ? file.bytes : 0,
      revision: typeof file.revision === 'string' ? file.revision.slice(0, 200) : '',
      hosted: file.hosted === true,
    };
  });
}
