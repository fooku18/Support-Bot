import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InstallationLookup } from './installations.js';
import { isChannelMember } from './membership.js';
import { fetchRepliesPage } from './slackclient.js';
import { fileDescriptors } from './file-descriptors.js';
import { authorizedFileUrl } from './file-authority.js';
import { assertPrivateWorkspaceChannel, slackFileUrl } from './file-upload.js';
import { buildTaskKey } from './taskkey.js';
import {
  nativeInputFiles,
  NATIVE_INPUT_BYTES,
  NATIVE_INPUT_COUNT,
  type NativeInputIdentity,
  type NativeInputReceipt,
} from './generated/native-inputs.js';

/** Private adapter byte boundary. All URLs and installation credentials stay in
 * this process. Mount alongside the native transport, never the legacy file API. */
export function nativeInputHandler(options: { token: string; installations: InstallationLookup }) {
  if (!options.token) throw new Error('native inputs require service authentication');
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!['/native-inputs/acquire', '/native-inputs/check'].includes(req.url ?? '')) return false;
    const expected = Buffer.from(`Bearer ${options.token}`);
    const given = Buffer.from(req.headers.authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.writeHead(401).end();
      return true;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]);
    const disconnected = () => abort.abort();
    res.on('close', disconnected);
    try {
      if (req.method !== 'POST') throw new Error('method refused');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 32000) throw new Error('input request bounds');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const identity = body.identity as NativeInputIdentity;
      const installation = resolve(identity);
      const receipts: NativeInputReceipt[] = req.url?.endsWith('/acquire')
        ? [{ identity, file: nativeInputFiles([body.file], identity.messageTs)[0]!, sha256: '' }]
        : body.receipts;
      if (!Array.isArray(receipts) || !receipts.length || receipts.length > NATIVE_INPUT_COUNT)
        throw new Error('input receipt bounds');
      let total = 0;
      const seen = new Set<string>();
      for (const receipt of receipts) {
        if (buildTaskKey(receipt.identity) !== buildTaskKey(identity))
          throw new Error('input belongs to another thread');
        nativeInputFiles([receipt.file], receipt.identity.messageTs);
        const key = `${receipt.file.id}:${receipt.file.sourceTs}`;
        if (seen.has(key) || (total += receipt.file.bytes) > NATIVE_INPUT_BYTES)
          throw new Error('input receipt bounds');
        seen.add(key);
        if (req.url?.endsWith('/check') && !/^[a-f0-9]{64}$/.test(receipt.sha256))
          throw new Error('input hash required');
      }
      async function authority() {
        signal.throwIfAborted();
        if (resolve(identity) !== installation) throw new Error('installation replaced');
        await assertPrivateWorkspaceChannel(installation.slack, identity.channelId);
        for (const user of new Set([identity.userId, ...receipts.map((r) => r.identity.userId)]))
          if (!(await isChannelMember(installation, identity.channelId, user)))
            throw new Error('requester no longer belongs to channel');
        signal.throwIfAborted();
      }
      async function sources() {
        const observed = new Map<string, string>();
        const matched = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const history = await fetchRepliesPage(installation.slack, {
            channel: identity.channelId,
            rootTs: identity.rootTs,
            limit: 100,
            cursor,
          });
          if (history.isLimited) throw new Error('source history limited');
          for (const message of history.messages) {
            for (const r of receipts.filter((r) => r.file.sourceTs === message.ts)) {
              if (
                message.user !== r.identity.userId ||
                (message.bot_id ?? null) !== (r.identity.authorBotId ?? null)
              )
                throw new Error('source author changed');
              const file = fileDescriptors(message.files, message.ts).find(
                (f) => f.id === r.file.id,
              );
              if (
                !file ||
                (Object.keys(file) as Array<keyof typeof file>).some((k) => file[k] !== r.file[k])
              )
                throw new Error('input source changed');
              const key = `${file.id}:${file.sourceTs}`;
              if (matched.has(key)) throw new Error('source identity ambiguous');
              matched.add(key);
              observed.set(key, file.revision);
            }
          }
          cursor = history.nextCursor;
          if (!cursor) break;
          if (page === 9) throw new Error('source history exceeds bounds');
        }
        if (matched.size !== receipts.length) throw new Error('source inaccessible');
        const urls = [];
        for (const r of receipts) {
          const url = await authorizedFileUrl(
            installation.slack,
            identity.teamId,
            r.file,
            observed,
          );
          urls.push(slackFileUrl(url).href);
        }
        return urls;
      }
      await authority();
      const urls = await sources();
      const acquired: Buffer[] = [];
      for (let index = 0; index < receipts.length; index++) {
        if (!installation.slack.downloadFile) throw new Error('input downloader unavailable');
        const response = await installation.slack.downloadFile(urls[index]!, signal);
        if (!response.ok || !response.body) throw new Error('input download refused');
        const parts: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          size += chunk.length;
          if (size > receipts[index]!.file.bytes) throw new Error('input byte bounds changed');
          parts.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(parts);
        if (size !== receipts[index]!.file.bytes) throw new Error('input byte bounds changed');
        if (
          receipts[index]!.sha256 &&
          createHash('sha256').update(bytes).digest('hex') !== receipts[index]!.sha256
        )
          throw new Error('input bytes changed');
        acquired.push(bytes);
      }
      // No bytes leave the adapter until every source and both original/current
      // requester identities have passed the post-download checks.
      await sources();
      await authority();
      signal.throwIfAborted();
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(req.url?.endsWith('/acquire') ? acquired[0] : undefined);
    } catch {
      if (!res.headersSent) res.writeHead(403).end();
      else res.destroy();
    } finally {
      res.off('close', disconnected);
    }
    return true;
  };
  function resolve(i: NativeInputIdentity) {
    buildTaskKey(i);
    if (!/^[UW][A-Z0-9]+$/.test(i.userId) || !/^[0-9]+\.[0-9]+$/.test(i.messageTs))
      throw new Error('invalid input identity');
    const current = options.installations.get(i.teamId);
    if (
      !current ||
      current.identity.installationId !== i.installationId ||
      current.identity.teamId !== i.teamId
    )
      throw new Error('input installation unavailable');
    return current;
  }
}
