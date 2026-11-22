import { afterEach, expect, it, vi } from 'vitest';
import { installationDownload } from '../src/file-download.js';
import { authorizedFileUrl } from '../src/file-authority.js';
import { fileDescriptors } from '../src/file-descriptors.js';
import { assertPrivateWorkspaceChannel } from '../src/file-upload.js';
import type { SlackDeps } from '../src/slackclient.js';
afterEach(() => vi.restoreAllMocks());

it('never forwards the installation credential to a redirect outside Slack', async () => {
  const calls = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response('', { status: 302, headers: { location: 'https://attacker.invalid/input' } }),
    );
  await expect(
    installationDownload('synthetic-only')('https://files.slack.com/a', AbortSignal.timeout(1000)),
  ).rejects.toThrow('untrusted');
  expect(calls).toHaveBeenCalledTimes(1);
});
it.each([true, undefined])('refuses shared or unverifiable channel state (%s)', async (shared) => {
  const slack = {
    webClient: {
      conversations: {
        info: async () => ({
          ok: true,
          channel: { is_ext_shared: shared, is_pending_ext_shared: false, is_org_shared: false },
        }),
      },
    },
  } as unknown as SlackDeps;
  await expect(assertPrivateWorkspaceChannel(slack, 'C1')).rejects.toThrow('sharing');
});
it.each(['hosted', 'snippet'])(
  'requires current thread presence, pinned revision, and uploading-team provenance for %s files',
  async (mode) => {
    const raw = {
      id: 'F123',
      user: 'U1',
      name: 'a.csv',
      mimetype: 'text/csv',
      size: 12,
      updated: 1,
      mode,
      is_external: false,
      url_private: 'https://files.slack.com/a',
    };
    const file = fileDescriptors([raw], '1.1')[0]!;
    const uploader = vi.fn(async () => ({ ok: true, user: { team_id: 'FOREIGN' } }));
    const slack = {
      webClient: {
        files: { info: async () => ({ ok: true, file: raw }) },
        users: { info: uploader },
      },
    } as unknown as SlackDeps;
    await expect(authorizedFileUrl(slack, 'T1', file, new Map())).rejects.toThrow('revoked');
    await expect(
      authorizedFileUrl(slack, 'T1', file, new Map([['F123:1.1', file.revision]])),
    ).rejects.toThrow('foreign');
    uploader.mockResolvedValue({ ok: true, user: { team_id: 'T1' } });
    await expect(
      authorizedFileUrl(slack, 'T1', file, new Map([['F123:1.1', file.revision]])),
    ).resolves.toBe(raw.url_private);
  },
);
it.each([
  { mode: 'snippet', mimetype: 'image/png', is_external: false },
  { mode: 'snippet', mimetype: 'text/plain', is_external: true },
  { mode: 'external', mimetype: 'text/plain', is_external: false },
])('refuses foreign or non-text snippet representations: %j', (fields) => {
  expect(
    fileDescriptors([{ id: 'F123', name: 'file.txt', size: 12, ...fields }], '1.1')[0]?.hosted,
  ).toBe(false);
});
