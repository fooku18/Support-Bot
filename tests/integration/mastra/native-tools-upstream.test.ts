import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  ATLASSIAN_CLOUD_ID,
  ATLASSIAN_EMAIL,
  GITLAB_BINARY_BYTES,
  GITLAB_BINARY_PATH,
  GITLAB_FILE_PATH,
  gitlabFileContent,
  GITLAB_PROJECT,
  GITLAB_RELEASE_BRANCH,
  createUpstreamHandler,
  credentialsIn,
  misroutedCredentials,
  type ToolCredentials,
  type UpstreamRecord,
} from './native-tools-upstream.js';
// @ts-expect-error operational module is JavaScript
import { credentialForms, credentialHits, TOOLS_SUITE_EMAIL } from '../native-tools-evidence.mjs';

const credentials: ToolCredentials = {
  gitlab: 'gitlab-synthetic-0001',
  gitlabUnapproved: 'gitlab-synthetic-0002',
  gitlabBlocked: 'gitlab-synthetic-0003',
  jira: 'jira-synthetic-0004',
  confluence: 'confluence-synthetic-0005',
  datadog: 'datadog-synthetic-0006',
  cloudflare: 'cloudflare-synthetic-0007',
  slack: 'xoxb-synthetic-0008',
};

async function upstream() {
  const records: UpstreamRecord[] = [];
  const server = http.createServer(
    (req, res) => void createUpstreamHandler(credentials, (r) => records.push(r))(req, res),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const request = (host: string, target: string, headers: Record<string, string>, body?: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: target,
          method: body === undefined ? 'GET' : 'POST',
          headers: { host, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (p) => parts.push(p));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { records, request, close: () => server.close() };
}

describe('native tools suite harness', () => {
  it('records which credential each request carried, never the value', async () => {
    const u = await upstream();
    try {
      const verify = await u.request('api.cloudflare.com', '/client/v4/user/tokens/verify', {
        authorization: `Bearer ${credentials.cloudflare}`,
      });
      expect(verify.status).toBe(200);
      expect(JSON.parse(verify.body).result.status).toBe('active');
      const basic = Buffer.from(`${ATLASSIAN_EMAIL}:${credentials.jira}`).toString('base64');
      // A Jira token sent to a Confluence path is misrouted.
      await u.request(
        'api.atlassian.com',
        `/ex/confluence/${ATLASSIAN_CLOUD_ID}/wiki/api/v2/spaces`,
        {
          authorization: `Basic ${basic}`,
        },
      );
      // A GitLab token sent to Slack is misrouted; an unknown path has no fixture.
      await u.request('slack.com', '/api/auth.test', { 'private-token': credentials.gitlab });
      const missing = await u.request('api.cloudflare.com', '/client/v4/accounts', {});
      expect(missing.status).toBe(404);
      expect(u.records.map((r) => r.credentials)).toEqual([
        ['cloudflare'],
        ['jira'],
        ['gitlab'],
        [],
      ]);
      expect(misroutedCredentials(u.records).map((r) => `${r.host}${r.path}`)).toEqual([
        `api.atlassian.com/ex/confluence/${ATLASSIAN_CLOUD_ID}/wiki/api/v2/spaces`,
        'slack.com/api/auth.test',
      ]);
      expect(JSON.stringify(u.records)).not.toContain('synthetic-000');
      expect(JSON.stringify(u.records)).not.toContain(basic);
    } finally {
      u.close();
    }
  });

  it('serves the GitLab and Slack fixtures with the echoed credential the runtime must redact', async () => {
    const u = await upstream();
    try {
      const project = await u.request('gitlab.example.com', '/api/v4/projects/fixture%2Fproject', {
        'private-token': credentials.gitlab,
      });
      expect(credentialsIn(project.body, credentials)).toEqual(['gitlab']);
      const user = await u.request('slack.com', '/api/users.info?user=U0FIXTURE1', {
        authorization: `Bearer ${credentials.slack}`,
      });
      expect(credentialsIn(user.body, credentials)).toEqual(['slack']);
      expect(misroutedCredentials(u.records)).toEqual([]);
    } finally {
      u.close();
    }
  });

  it('serves the GitLab list and file fixtures and records each query', async () => {
    const u = await upstream();
    try {
      const auth = { 'private-token': credentials.gitlab };
      const projects = await u.request('gitlab.example.com', '/api/v4/projects?page=2', auth);
      expect(JSON.parse(projects.body).map((p: { id: number }) => p.id)).toEqual([4242, 4243]);
      expect(credentialsIn(projects.body, credentials)).toEqual(['gitlab']);
      const base = `/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT)}`;
      const branches = await u.request('gitlab.example.com', `${base}/repository/branches`, auth);
      expect(JSON.parse(branches.body)[0].name).toBe(GITLAB_RELEASE_BRANCH);
      const mrs = await u.request('gitlab.example.com', `${base}/merge_requests`, auth);
      expect(JSON.parse(mrs.body)[0].iid).toBe(17);
      const file = `${base}/repository/files/${encodeURIComponent(GITLAB_FILE_PATH)}`;
      const ref = `?ref=${encodeURIComponent(GITLAB_RELEASE_BRANCH)}`;
      const found = JSON.parse((await u.request('gitlab.example.com', `${file}${ref}`, auth)).body);
      expect(found.encoding).toBe('base64');
      expect(Buffer.from(found.content, 'base64').toString('utf8')).toBe(
        gitlabFileContent(credentials.gitlab),
      );
      const png = `${base}/repository/files/${encodeURIComponent(GITLAB_BINARY_PATH)}${ref}`;
      const binary = JSON.parse((await u.request('gitlab.example.com', png, auth)).body);
      expect(Buffer.from(binary.content, 'base64')).toEqual(GITLAB_BINARY_BYTES);
      // Like GitLab: another ref has no such file.
      const otherRef = await u.request('gitlab.example.com', `${file}?ref=main`, auth);
      expect(otherRef.status).toBe(404);
      expect(u.records.map((r) => [r.status, r.query])).toEqual([
        [200, '?page=2'],
        [200, ''],
        [200, ''],
        [200, ref],
        [200, ref],
        [404, '?ref=main'],
      ]);
      expect(misroutedCredentials(u.records)).toEqual([]);
    } finally {
      u.close();
    }
  });

  it('lists a Datadog write tool without readOnlyHint and answers MCP notifications with 202', async () => {
    const u = await upstream();
    try {
      const auth = { authorization: `Bearer ${credentials.datadog}`, accept: 'application/json' };
      const init = await u.request('mcp.datadoghq.eu', '/v1/mcp?toolsets=all', auth, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      });
      expect(JSON.parse(init.body).result.protocolVersion).toBe('2025-06-18');
      const note = await u.request('mcp.datadoghq.eu', '/v1/mcp', auth, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      expect(note.status).toBe(202);
      const list = JSON.parse(
        (
          await u.request('mcp.datadoghq.eu', '/v1/mcp', auth, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
        ).body,
      );
      const tools = list.result.tools as Array<{ name: string; annotations?: unknown }>;
      expect(tools.map((t) => [t.name, t.annotations ?? null])).toEqual([
        ['search_datadog_logs', { readOnlyHint: true }],
        ['create_datadog_notebook', null],
      ]);
      expect(u.records.map((r) => r.rpc)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    } finally {
      u.close();
    }
  });

  it('finds every credential form in retained files and skips private files and links', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-evidence-'));
    try {
      fs.mkdirSync(path.join(dir, 'private'));
      fs.mkdirSync(path.join(dir, 'logs'));
      fs.writeFileSync(path.join(dir, 'private/credentials.json'), JSON.stringify(credentials));
      fs.writeFileSync(path.join(dir, 'clean.log'), 'nothing here [redacted]');
      const [raw, base64, basic] = credentialForms(credentials.jira);
      expect(basic).toBe(
        Buffer.from(`${TOOLS_SUITE_EMAIL}:${credentials.jira}`).toString('base64'),
      );
      fs.writeFileSync(path.join(dir, 'logs/a.log'), `x ${raw} y`);
      fs.writeFileSync(path.join(dir, 'b.json'), `{"h":"${base64}"}`);
      fs.writeFileSync(path.join(dir, 'c.txt'), `Basic ${basic}`);
      fs.symlinkSync(path.join(dir, 'private/credentials.json'), path.join(dir, 'link.json'));
      const scan = credentialHits(dir, credentials, [path.join(dir, 'private')]);
      expect(scan.files).toBe(4);
      expect(
        scan.hits.sort((a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file)),
      ).toEqual([
        { file: 'b.json', credential: 'jira' },
        { file: 'c.txt', credential: 'jira' },
        { file: path.join('logs', 'a.log'), credential: 'jira' },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
