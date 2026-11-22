import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { nativeExportTool } from '../../src/mastra/tools/native-exports.js';
import { nativeExportBytes, type NativeExport } from '../../src/domain/delivery/native-exports.js';
import { sendNativeExports } from '../../../slack/src/native-exports.js';
import { digest } from '../../src/application/agent-support.js';
import { workspacePaths } from '../../src/infrastructure/storage/workspace-paths.js';
import type { SlackDeps } from '../../../slack/src/slackclient.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const content = Buffer.from('name,value\r\nfox,14\r\n');
const file: NativeExport = {
  id: 'a'.repeat(64),
  name: 'report.csv',
  sha256: sha(content),
  bytes: content.length,
  data: content.toString('base64'),
};
it('uses the real contained Workspace filesystem and freezes the designated bytes', async () => {
  const artifacts = path.resolve('artifacts/native-coding-files-tests');
  await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifacts, 'workspace-'));
  const filesystem = new LocalFilesystem({ basePath: root, contained: true, allowedPaths: [] });
  await filesystem.writeFile('report.csv', content);
  let retained: Buffer | undefined;
  let revoked = false;
  const tool = nativeExportTool({
    filesystem,
    authorize: async () => {
      if (revoked) throw new Error('revoked');
    },
    register: async (f) => {
      retained = f.bytes;
      return { sha256: f.sha256 };
    },
  });
  const result = await tool.execute!({ path: 'report.csv' }, {} as never);
  expect(result).toEqual({ sha256: sha(content) });
  await filesystem.writeFile('report.csv', 'changed');
  expect(retained).toEqual(content);
  await expect(tool.execute!({ path: '../../../../tests/outside' }, {} as never)).rejects.toThrow();
  await fs.symlink('/etc/passwd', `${root}/escape`);
  await expect(tool.execute!({ path: 'escape' }, {} as never)).rejects.toThrow();
  await filesystem.writeFile('large', Buffer.alloc(2 * 1024 ** 2 + 1));
  await expect(tool.execute!({ path: 'large' }, {} as never)).rejects.toThrow('bounds');
  revoked = true;
  await expect(tool.execute!({ path: 'report.csv' }, {} as never)).rejects.toThrow('revoked');
  await fs.writeFile(
    `${root}/evidence.json`,
    JSON.stringify({ sha256: sha(retained!), retained: true }),
  );
});
// Ported from the retained task-files-and-isolation live scenario: a task's
// workspace files survive its later runs and stay out of reach of other tasks.
it('keeps task files across runs of one task and out of reach of another task', async () => {
  const artifacts = path.resolve('artifacts/native-coding-files-tests');
  await fs.mkdir(artifacts, { recursive: true });
  const storage = await fs.mkdtemp(path.join(artifacts, 'storage-'));
  const task = (key: string) => {
    const paths = workspacePaths(storage, digest(key));
    return new LocalFilesystem({ basePath: paths.checkouts, contained: true, allowedPaths: [] });
  };
  const a = 'v1:UBOT:TTEST:CTEST:1792940000.000001';
  const b = 'v1:UBOT:TTEST:CTEST:1792940000.000002';
  expect(digest(a)).not.toBe(digest(b));
  await fs.mkdir(workspacePaths(storage, digest(a)).checkouts, { recursive: true });
  await fs.mkdir(workspacePaths(storage, digest(b)).checkouts, { recursive: true });
  await task(a).writeFile('reports/notes.md', 'task-a-report\n');
  // A later run of the same task builds a new filesystem on the same path.
  expect(String(await task(a).readFile('reports/notes.md'))).toBe('task-a-report\n');
  // Another task sees neither the file nor a path out of its own checkouts.
  await expect(task(b).readFile('reports/notes.md')).rejects.toThrow();
  await expect(task(b).readFile(`../../${digest(a)}/checkouts/reports/notes.md`)).rejects.toThrow();
});
it('refuses corrupted or noncanonical transport bytes', () => {
  expect(nativeExportBytes(file)).toEqual(content);
  for (const change of [
    { data: Buffer.from('changed').toString('base64') },
    { name: '../../../../tests/file' },
    { data: file.data + '\n' },
    { bytes: -1 },
  ])
    expect(() => nativeExportBytes({ ...file, ...change })).toThrow();
});
function peer(stopAt?: string) {
  const calls: string[] = [];
  let revoked = false;
  const hit = (stage: string) => {
    calls.push(stage);
    if (stopAt === stage) revoked = true;
  };
  const slack = {
    botUserId: 'UBOT',
    webClient: {
      conversations: {
        info: async () => ({
          ok: true,
          channel: { is_ext_shared: false, is_pending_ext_shared: false, is_org_shared: false },
        }),
      },
      files: {
        getUploadURLExternal: async () => {
          hit('allocate');
          return {
            ok: true,
            file_id: 'FOUTPUT',
            upload_url: 'https://files.slack.com/upload/test',
          };
        },
        completeUploadExternal: async () => {
          hit('complete');
          return { ok: true, files: [{ id: 'FOUTPUT' }] };
        },
        info: async () => {
          hit('info');
          return {
            ok: true,
            file: {
              id: 'FOUTPUT',
              user: 'UBOT',
              size: content.length,
              permalink: 'https://slack.com/file',
              shares: { private: { CTEST: [{ thread_ts: '1.1' }] } },
            },
          };
        },
      },
    },
  } as unknown as SlackDeps;
  return {
    slack,
    calls,
    authorize: async () => {
      if (revoked) throw new Error('revoked');
    },
    transfer: async (_s: SlackDeps, _url: string, bytes: Buffer) => {
      expect(bytes).toEqual(content);
      hit('transfer');
    },
  };
}
it('confirms exact bytes only after the expected app shares to the exact thread', async () => {
  const p = peer();
  const receipts = await sendNativeExports(
    p.slack,
    { files: [file], channel: 'CTEST', rootTs: '1.1' },
    p.authorize,
    p.transfer,
  );
  expect(p.calls).toEqual(['allocate', 'transfer', 'complete', 'info']);
  expect(receipts).toEqual([
    {
      id: file.id,
      sha256: file.sha256,
      bytes: file.bytes,
      fileId: 'FOUTPUT',
      permalink: 'https://slack.com/file',
    },
  ]);
});
it.each(['allocate', 'transfer', 'complete', 'info'])(
  'stops on authority change after %s without retry',
  async (stage) => {
    const p = peer(stage);
    await expect(
      sendNativeExports(
        p.slack,
        { files: [file], channel: 'CTEST', rootTs: '1.1' },
        p.authorize,
        p.transfer,
      ),
    ).rejects.toThrow('revoked');
    expect(p.calls.at(-1)).toBe(stage);
    expect(new Set(p.calls).size).toBe(p.calls.length);
  },
);
it('does not accept another thread share or retry an unknown completion', async () => {
  const p = peer();
  await expect(
    sendNativeExports(
      p.slack,
      { files: [file], channel: 'CTEST', rootTs: '2.2' },
      p.authorize,
      p.transfer,
    ),
  ).rejects.toThrow('share unconfirmed');
  const q = peer();
  q.slack.webClient.files.completeUploadExternal = async () => {
    q.calls.push('complete');
    throw new Error('ACK lost');
  };
  await expect(
    sendNativeExports(
      q.slack,
      { files: [file], channel: 'CTEST', rootTs: '1.1' },
      q.authorize,
      q.transfer,
    ),
  ).rejects.toThrow('ACK lost');
  expect(q.calls).toEqual(['allocate', 'transfer', 'complete']);
});

it.each(['unchanged', 'sharing', 'membership', 'revision'])(
  'input boundary retains post-download authority: %s',
  async (change) => {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const { nativeInputHandler } = await import('../../../slack/src/native-inputs.js');
    const { fileDescriptors } = await import('../../../slack/src/file-descriptors.js');
    const identity = {
      installationId: 'UBOT',
      teamId: 'TTEST',
      channelId: 'CTEST',
      rootTs: '1794740000.100001',
      messageTs: '1794740000.100001',
      userId: 'UTEST',
      authorBotId: null,
    };
    const raw = {
      id: 'FTEST',
      name: 'test.csv',
      mimetype: 'text/csv',
      size: content.length,
      updated: 1,
      created: 1,
      user: 'UTEST',
      mode: 'snippet',
      is_external: false,
      url_private_download: 'https://files.slack.com/files/FTEST',
    };
    const descriptor = fileDescriptors([raw], identity.messageTs)[0]!;
    let downloaded = false;
    let channelReads = 0;
    const slack = {
      webClient: {
        conversations: {
          info: async () => {
            channelReads++;
            return {
              ok: true,
              channel: {
                is_ext_shared: downloaded && change === 'sharing',
                is_pending_ext_shared: false,
                is_org_shared: false,
              },
            };
          },
          members: async () => ({
            ok: true,
            members: downloaded && change === 'membership' ? [] : ['UTEST'],
          }),
          replies: async () => ({
            ok: true,
            messages: [
              {
                ts: identity.messageTs,
                user: 'UTEST',
                files: [{ ...raw, updated: downloaded && change === 'revision' ? 2 : 1 }],
              },
            ],
            has_more: false,
          }),
        },
        files: { info: async () => ({ ok: true, file: raw }) },
        users: { info: async () => ({ ok: true, user: { team_id: 'TTEST' } }) },
      },
      downloadFile: async () => {
        downloaded = true;
        return new Response(content);
      },
    };
    const installation = {
      identity: { teamId: 'TTEST', installationId: 'UBOT', botUserId: 'UBOT', botId: 'BBOT' },
      slack: slack as unknown as SlackDeps,
    };
    const handler = nativeInputHandler({
      token: 'synthetic',
      installations: { get: () => installation },
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('port');
      const response = await fetch(`http://127.0.0.1:${address.port}/native-inputs/acquire`, {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
        body: JSON.stringify({ identity, file: descriptor }),
      });
      expect(downloaded).toBe(true);
      expect(response.status).toBe(change === 'unchanged' ? 200 : 403);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        change === 'unchanged' ? content : Buffer.alloc(0),
      );
      if (change !== 'revision') expect(channelReads).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
