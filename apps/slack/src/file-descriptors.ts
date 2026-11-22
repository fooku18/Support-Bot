import { createHash } from 'node:crypto';
import type { SlackFileDescriptorDto } from './generated/protocol.js';
import { parseFileDescriptors } from './generated/file-inputs.js';

/** Slack represents directly uploaded editable text/CSV files as snippets. */
export function isSlackStoredFile(file: {
  mode?: unknown;
  is_external?: unknown;
  mimetype?: unknown;
}): boolean {
  return (
    file.is_external === false &&
    (file.mode === 'hosted' ||
      (file.mode === 'snippet' &&
        ['text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown'].includes(
          String(file.mimetype),
        )))
  );
}

export function fileDescriptors(
  files: unknown[] | undefined,
  sourceTs: string,
): SlackFileDescriptorDto[] {
  return parseFileDescriptors(
    files?.map((raw) => {
      const file = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      return {
        id: file.id,
        name: file.name,
        mime: file.mimetype,
        bytes: file.size,
        hosted: isSlackStoredFile(file),
        revision: createHash('sha256')
          .update(
            JSON.stringify([
              file.id,
              file.size,
              file.updated ?? file.timestamp,
              file.created,
              file.name,
              file.mimetype,
              file.user,
              file.mode,
              file.is_external,
            ]),
          )
          .digest('hex'),
      };
    }),
    sourceTs,
  );
}
