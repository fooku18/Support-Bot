/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic service wire fixtures */
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

/** Actual HTTPS Git transport through the configured CONNECT proxy. Only the
 * designated synthetic project is served; production adapters are not patched. */
/** Scripts the coding thread runs through `execute_typescript` in the image,
 * in this order: two reads combined, the script's missing host access, a write,
 * runaway recursion, memory within and beyond the limit, and a synchronous
 * loop. native-image-vertical.ts asserts each result. */
export const CODE_MODE_PROBES = [
  `const [project, branches] = await Promise.all([
    external_get_project({ project: 'fixture/project' }),
    external_list_branches({ project: 'fixture/project' }),
  ]);
  return { combined: JSON.stringify(project).includes('ASSEMBLED_SERVICE_FACT') && branches.result.ok };`,
  `const exposed = ['require', 'process', 'fetch', 'setTimeout', 'Buffer']
.filter((name) => typeof (globalThis as Record<string, unknown>)[name] !== 'undefined');
  const modules = [];
  for (const name of ['node:fs', 'node:child_process', 'std'])
    try { await import(name); modules.push(name); } catch {}
  return { hostAccess: [...exposed, ...modules].join(',') || 'none' };`,
  `return await external_create_merge_request({ project: 'fixture/project', title: 'probe' });`,
  `const down = (n: number): number => down(n + 1) + 1; return down(0);`,
  `return { allocated: new Uint8Array(32 * 1024 * 1024).length };`,
  `return new Uint8Array(80 * 1024 * 1024).length;`,
  `while (true) {}`,
];

export async function codingDeploymentFixture(root: string) {
  const host = 'gitlab.synthetic.invalid';
  const credential = 'synthetic-coding-transport-only';
  const dir = `${root}/git-${Date.now()}`;
  const git = (args: string[], cwd = dir) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    }).trim();
  await fs.mkdir(`${dir}/fixture`, { recursive: true });
  git(['init', '-b', 'main', 'seed']);
  await fs.writeFile(`${dir}/seed/value.txt`, 'seed\n');
  git(['add', '.'], `${dir}/seed`);
  git(
    ['-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed'],
    `${dir}/seed`,
  );
  const remote = `${dir}/fixture/project.git`;
  git(['clone', '--bare', 'seed', remote]);
  git(['config', 'http.receivepack', 'true'], remote);
  const transfers: string[] = [];
  const uploaded = new Map<string, Buffer>();
  const inputBytes = Buffer.from('name,value\r\nfox,14\r\n');
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  );
  const tls = https.createServer(
    {
      key: await fs.readFile(`${root}/tls/key.pem`),
      cert: await fs.readFile(`${root}/tls/cert.pem`),
    },
    (req, res) => {
      if (req.headers.host === 'files.slack.com') {
        if (req.method === 'GET' && req.url === '/files/FIMAGE') {
          res.writeHead(200).end(imageBytes);
          return;
        }
        if (req.method === 'GET' && req.url === '/files/FINPUT') {
          res.writeHead(200).end(inputBytes);
          return;
        }
        if (req.method === 'POST' && req.url?.startsWith('/upload/')) {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            uploaded.set(req.url!.slice('/upload/'.length), Buffer.concat(chunks));
            res.writeHead(200).end('OK');
          });
          return;
        }
        res.writeHead(404).end();
        return;
      }
      if (
        req.headers.authorization !==
        `Basic ${Buffer.from(`oauth2:${credential}`).toString('base64')}`
      ) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url!, `https://${host}`);
      if (!url.pathname.startsWith('/fixture/project.git/')) {
        res.writeHead(403).end();
        return;
      }
      transfers.push(url.pathname);
      const child = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: dir,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: req.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          REMOTE_USER: 'synthetic',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      req.pipe(child.stdin);
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.resume();
      child.on('close', (code) => {
        const data = Buffer.concat(chunks),
          boundary = data.indexOf('\r\n\r\n');
        if (code !== 0 || boundary < 0) {
          res.writeHead(502).end();
          return;
        }
        let status = 200;
        for (const line of data.subarray(0, boundary).toString().split('\r\n')) {
          const i = line.indexOf(':');
          const name = line.slice(0, i),
            value = line.slice(i + 1).trim();
          if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
          else res.setHeader(name, value);
        }
        res.writeHead(status).end(data.subarray(boundary + 4));
      });
    },
  );
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  const sockets = new Set<net.Socket>();
  let peerPort: number | undefined;
  proxy.on('connect', (req, client, head) => {
    const local = peerPort !== undefined && req.url === `127.0.0.1:${peerPort}`;
    if (req.url !== `${host}:443` && req.url !== 'files.slack.com:443' && !local) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(
      local ? peerPort! : (tls.address() as net.AddressInfo).port,
      '127.0.0.1',
    );
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  let mr: any;
  const apiCalls: any[] = [];
  const sequences = new Map<string, number>();
  const file = 'fixture__project/value.txt';
  const tool = (name: string, input: unknown) => ({
    type: 'tool_use',
    id: `coding-${sequences.size}-${apiCalls.length}-${Math.random().toString(16).slice(2)}`,
    name,
    input,
  });
  const verify = tool('verify', {
    project: 'fixture/project',
    argv: [
      'node',
      '-e',
      "const f=require('fs');if(!f.readFileSync('value.txt','utf8').startsWith('native '))process.exit(1);if(!/^0+$/.test(f.readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s*(\\w+)/m)[1])||f.existsSync('/app')||f.existsSync('/run/secrets'))process.exit(2);console.log('VERIFIED_NATIVE');",
    ],
    timeoutMs: 5000,
  });
  return {
    uploaded,
    inputBytes,
    imageBytes,
    allowPeer(port: number) {
      peerPort = port;
    },
    proxyUrl: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
    secret: {
      id: 'ti_1150000000000001',
      kind: 'gitlab',
      teamId: 'TASSEMBLED',
      credentialVersion: 1,
      credential,
    },
    api(request: any) {
      apiCalls.push(request);
      const op = request.operationArgs;
      assert.equal(request.instanceId, 'ti_1150000000000001');
      assert.equal(request.teamId, 'TASSEMBLED');
      // Read tools (direct and in Code Mode) do not pin a credential version.
      if (!['get_project', 'list_branches'].includes(request.operation))
        assert.equal(request.credentialVersion, 1);
      let data: unknown;
      switch (request.operation) {
        case 'get_project':
          data = {
            id: 115,
            path_with_namespace: 'fixture/project',
            default_branch: 'main',
            description: 'ASSEMBLED_SERVICE_FACT',
          };
          break;
        case 'list_branches':
          data = [{ name: 'main', default: true }];
          break;
        case 'get_current_user':
          data = { name: 'Synthetic', email: 'test@example.invalid' };
          break;
        case 'list_merge_requests':
          data = mr ? [mr] : [];
          break;
        case 'get_merge_request':
          data = mr;
          break;
        case 'create_merge_request':
          assert.equal(mr, undefined);
          data = mr = {
            ...op,
            iid: 7,
            project_id: 115,
            web_url: `https://${host}/fixture/project/-/merge_requests/7`,
            state: 'opened',
          };
          break;
        case 'update_merge_request':
          data = mr = { ...mr, description: op.description };
          break;
        default:
          throw new Error(`unplanned synthetic GitLab operation ${request.operation}`);
      }
      return { status: 'completed', exitCode: 0, output: JSON.stringify(data), truncated: false };
    },
    response(body: any) {
      if (JSON.stringify(body.messages).includes('CODING_FILES')) {
        const n = sequences.get('FILES') ?? 0;
        sequences.set('FILES', n + 1);
        const text = JSON.stringify(body.messages);
        const input = text.match(/\.slack-inputs\/[a-f0-9-]+\/FINPUT\/input.csv/)?.[0];
        const image = text.match(/\.slack-inputs\/[a-f0-9-]+\/FIMAGE\/pixel.png/)?.[0];
        assert(input, 'native working copy supplied');
        assert(image, 'native image working copy supplied');
        const files = [
          tool('mastra_workspace_read_file', { path: input }),
          tool('mastra_workspace_write_file', {
            path: 'report.csv',
            content: 'name,doubled\r\nfox,28\r\n',
          }),
          tool('export_file', { path: 'report.csv' }),
          tool('mastra_workspace_write_file', {
            path: 'report.csv',
            content: 'edited after designation',
          }),
          tool('export_file', { path: input, name: 'original.csv' }),
          tool('export_file', { path: image, name: 'pixel.png' }),
        ];
        return (
          files[n] ?? {
            type: 'text',
            text: '',
          }
        );
      }
      const tags = [...JSON.stringify(body.messages).matchAll(/CODING_(FIRST|FOLLOW)/g)];
      const tag = tags.at(-1)?.[1];
      if (!tag) return undefined;
      const n = sequences.get(tag) ?? 0;
      sequences.set(tag, n + 1);
      const steps =
        tag === 'FIRST'
          ? [
              tool('clone_repository', { project: 'fixture/project' }),
              tool('mastra_workspace_read_file', { path: file }),
              tool('mastra_workspace_write_file', { path: file, content: 'native first\n' }),
              tool('search_tools', { query: 'execute_typescript' }),
              ...CODE_MODE_PROBES.map((code) => tool('execute_typescript', { code })),
              verify,
              tool('publish', {
                project: 'fixture/project',
                title: 'assembled native publication',
              }),
            ]
          : [
              tool('mastra_workspace_read_file', { path: file }),
              tool('mastra_workspace_edit_file', {
                path: file,
                old_string: 'first',
                new_string: 'follow',
              }),
              verify,
              tool('publish', {
                project: 'fixture/project',
                title: 'assembled native follow-up',
              }),
            ];
      return steps[n] ?? { type: 'text', text: 'Native coding complete; see publication receipt.' };
    },
    async assertPublished(expected: string) {
      assert(mr?.source_branch);
      assert.equal(git(['show', `${mr.source_branch}:value.txt`], remote), expected);
      assert.equal(apiCalls.filter((c) => c.operation === 'create_merge_request').length, 1);
      assert(transfers.some((p) => p.endsWith('git-receive-pack')));
      await fs.writeFile(
        `${root}/coding-transport-evidence.json`,
        JSON.stringify({ mr, apiCalls, transfers }, null, 2),
      );
      return {
        mrIid: mr.iid,
        branch: mr.source_branch,
        commit: git(['rev-parse', mr.source_branch], remote),
        content: expected,
      };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [proxy, tls].map((server) => new Promise<void>((r) => server.close(() => r()))),
      );
    },
  };
}
