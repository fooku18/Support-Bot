import type { SlackDeps } from './slackclient.js';
import { fileDescriptors } from './file-descriptors.js';
import type { SlackFileDescriptorDto } from './generated/protocol.js';

/** Resolve a private URL only after current thread membership and uploader checks. */
export async function authorizedFileUrl(
  slack: SlackDeps,
  teamId: string,
  file: SlackFileDescriptorDto,
  observed: Map<string, string>,
): Promise<string> {
  if (observed.get(`${file.id}:${file.sourceTs}`) !== file.revision)
    throw new Error('input dependency revoked or changed');
  const response = await slack.webClient.files.info({ file: file.id });
  const fresh = fileDescriptors(response.file ? [response.file] : [], file.sourceTs)[0];
  if (!response.ok || !fresh?.hosted || fresh.revision !== file.revision || !response.file?.user)
    throw new Error('input dependency unavailable');
  const uploader = await slack.webClient.users.info({ user: response.file.user });
  if (!uploader.ok || uploader.user?.team_id !== teamId)
    throw new Error('uploading workspace foreign or unverifiable');
  const url = response.file.url_private_download ?? response.file.url_private;
  if (!url) throw new Error('input bytes unavailable');
  return url;
}
