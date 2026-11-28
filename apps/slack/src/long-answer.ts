import {
  answerFileBytes,
  type AnswerFileReceipt,
  type NativeAnswerFile,
} from './generated/long-answer.js';
import { assertPrivateWorkspaceChannel, transferSlackFile } from './file-upload.js';
import type { SlackDeps } from './slackclient.js';

/** Current authority was refused: nothing more may be sent for this delivery. */
export class AnswerAuthorityRefused extends Error {
  constructor() {
    super('answer file authority refused');
  }
}

/**
 * Uploads the full answer of a long answer to the thread as one file. It checks
 * the private workspace channel and current delivery
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
  const data = answerFileBytes(value.file, value.preview);
  const check = async () => {
    await assertPrivateWorkspaceChannel(slack, value.channel);
    try {
      await authorize();
    } catch {
      throw new AnswerAuthorityRefused();
    }
  };
  const { name, bytes, sha256 } = value.file;
  try {
    await check();
    const allocation = await slack.webClient.files.getUploadURLExternal({
      filename: name,
      length: bytes,
    });
    if (!allocation.ok || !allocation.upload_url || !/^F[A-Z0-9]+$/.test(allocation.file_id ?? ''))
      return { attached: false };
    const fileId = allocation.file_id!;
    await check();
    await transfer(slack, allocation.upload_url, data);
    await check();
    const completed = await slack.webClient.files.completeUploadExternal({
      files: [{ id: fileId, title: name }],
      channel_id: value.channel,
      thread_ts: value.rootTs,
    });
    if (!completed.ok || !completed.files?.some((f) => f.id === fileId)) return { attached: false };
    await check();
    const info = await slack.webClient.files.info({ file: fileId });
    const f = info.file;
    const shares = [
      ...(f?.shares?.public?.[value.channel] ?? []),
      ...(f?.shares?.private?.[value.channel] ?? []),
    ];
    if (
      !info.ok ||
      !slack.botUserId ||
      f?.id !== fileId ||
      f.user !== slack.botUserId ||
      f.size !== bytes ||
      !f.permalink?.startsWith('https://') ||
      !shares.some((s) => s.thread_ts === value.rootTs)
    )
      return { attached: false };
    await check();
    return { attached: true, fileId, permalink: f.permalink, sha256, bytes };
  } catch (error) {
    if (error instanceof AnswerAuthorityRefused) throw error;
    return { attached: false };
  }
}
