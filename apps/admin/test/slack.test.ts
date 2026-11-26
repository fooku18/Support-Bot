import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SlackApi, SlackDirectory } from '../src/slack.js';

describe('Slack listings', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  const endlessSlack = async (): Promise<{ url: string; calls: string[] }> => {
    const calls: string[] = [];
    server = http.createServer((req, res) => {
      const method = (req.url ?? '').split('/').pop() ?? '';
      calls.push(method);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          members: [{ id: `U0USER${calls.length}`, name: `user${calls.length}` }],
          channels: [{ id: `C0CHAN${calls.length}`, name: `chan${calls.length}` }],
          response_metadata: { next_cursor: `cursor-${calls.length}` },
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`, calls };
  };

  it('reports a listing that still has pages after the page limit instead of a partial one', async () => {
    const { url, calls } = await endlessSlack();
    const slack = new SlackApi({ apiUrl: url });
    await expect(slack.listUsers('xoxb-token')).rejects.toMatchObject({
      method: 'users.list',
      code: 'pagination_limit',
    });
    await expect(slack.listChannels('xoxb-token')).rejects.toMatchObject({
      method: 'users.conversations',
      code: 'pagination_limit',
    });
    expect(calls).toHaveLength(40);
    const directory = new SlackDirectory(slack);
    const listing = await directory.users('T0TEAM1', 'xoxb-token');
    expect(listing).toMatchObject({ rows: null, error: 'pagination_limit' });
    expect(calls).toHaveLength(60);
    expect(await directory.users('T0TEAM1', 'xoxb-token')).toMatchObject({
      rows: null,
      error: 'pagination_limit',
    });
    expect(calls).toHaveLength(60);
  });
});
