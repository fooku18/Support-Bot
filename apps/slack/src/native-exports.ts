import {
  nativeExportBytes,
  NATIVE_EXPORT_COUNT,
  type NativeExport,
  type NativeExportReceipt,
} from './generated/native-exports.js';
import type { SlackDeps } from './slackclient.js';
import { transferSlackFile, assertPrivateWorkspaceChannel } from './file-upload.js';

/** One admitted delivery, with no retry of any ambiguous external operation.
 * Authority is checked immediately before each external call and after reads.
 * PostgreSQL retains the original bytes even when the final ACK is lost. */
export async function sendNativeExports(
  slack: SlackDeps,
  value: { files: NativeExport[]; channel: string; rootTs: string },
  authorize: () => Promise<void>,
  transfer = transferSlackFile,
  record: (receipt: NativeExportReceipt) => Promise<void> = async () => {},
): Promise<NativeExportReceipt[]> {
  if (
    !Array.isArray(value.files) ||
    value.files.length > NATIVE_EXPORT_COUNT ||
    new Set(value.files.map((f) => f.id)).size !== value.files.length
  )
    throw new Error('export bounds');
  const data = value.files.map((f) => nativeExportBytes(f));
  const check = async () => {
    await assertPrivateWorkspaceChannel(slack, value.channel);
    await authorize();
  };
  const receipts = [];
  for (const [index, file] of value.files.entries()) {
    await check();
    const allocation = await slack.webClient.files.getUploadURLExternal({
      filename: file.name,
      length: file.bytes,
    });
    if (!allocation.ok || !allocation.upload_url || !/^F[A-Z0-9]+$/.test(allocation.file_id ?? ''))
      throw new Error('export allocation unconfirmed');
    const fileId = allocation.file_id!;
    await check();
    await transfer(slack, allocation.upload_url, data[index]!);
    await check();
    const completed = await slack.webClient.files.completeUploadExternal({
      files: [{ id: fileId, title: file.name }],
      channel_id: value.channel,
      thread_ts: value.rootTs,
    });
    if (!completed.ok || !completed.files?.some((f) => f.id === fileId))
      throw new Error('export completion unconfirmed');
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
      f.size !== file.bytes ||
      !f.permalink?.startsWith('https://') ||
      !shares.some((s) => s.thread_ts === value.rootTs)
    )
      throw new Error('export share unconfirmed');
    await check();
    const receipt = {
      id: file.id,
      sha256: file.sha256,
      bytes: file.bytes,
      fileId,
      permalink: f.permalink,
    };
    await record(receipt);
    receipts.push(receipt);
  }
  return receipts;
}
