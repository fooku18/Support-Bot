import { slackFileUrl } from './file-upload.js';

/** Installation-token closure: credentials never leave the adapter or follow redirects. */
export function installationDownload(
  token: string,
): (url: string, signal: AbortSignal) => Promise<Response> {
  return async (url, signal) => {
    let target = slackFileUrl(url);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(target, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        target = slackFileUrl(new URL(response.headers.get('location') ?? '', target).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Slack input is unavailable');
      }
      return response;
    }
    throw new Error('Slack redirect limit exceeded');
  };
}
