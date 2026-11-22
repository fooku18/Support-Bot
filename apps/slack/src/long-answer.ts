import {
  answerFileBytes,
  type AnswerFileReceipt,
  type NativeAnswerFile,
} from './generated/long-answer.js';
import { sendNativeExports } from './native-exports.js';
import { transferSlackFile } from './file-upload.js';
import type { SlackDeps } from './slackclient.js';

/** Current authority was refused: nothing more may be sent for this delivery. */
export class AnswerAuthorityRefused extends Error {
  constructor() {
    super('answer file authority refused');
  }
}

/**
 * Uploads the full answer of a long answer to the thread as one file, with
 * the export path's checks: private workspace channel and current delivery
 * authority before each external call, then share verification. A refused
 * authority throws, so the caller sends nothing more. Any upload failure,
 * including an unknown outcome, returns `attached: false` and is never
 * retried; the caller still posts the preview and says the file is missing.
 */
export async function sendAnswerFile(
  slack: SlackDeps,
  value: { file: NativeAnswerFile; preview: string; channel: string; rootTs: string },
  authorize: () => Promise<void>,
  transfer = transferSlackFile,
): Promise<AnswerFileReceipt> {
  answerFileBytes(value.file, value.preview);
  const guarded = async () => {
    try {
      await authorize();
    } catch {
      throw new AnswerAuthorityRefused();
    }
  };
  try {
    const [receipt] = await sendNativeExports(
      slack,
      {
        files: [{ ...value.file, id: value.file.sha256 }],
        channel: value.channel,
        rootTs: value.rootTs,
      },
      guarded,
      transfer,
    );
    return receipt
      ? {
          attached: true,
          fileId: receipt.fileId,
          permalink: receipt.permalink,
          sha256: receipt.sha256,
          bytes: receipt.bytes,
        }
      : { attached: false };
  } catch (error) {
    if (error instanceof AnswerAuthorityRefused) throw error;
    return { attached: false };
  }
}
