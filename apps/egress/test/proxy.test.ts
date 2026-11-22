import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { policyFromEnv } from '../src/policy.js';
import { createProxyServer, parseTarget, type ProxyServer } from '../src/proxy.js';

const LOCAL_ENV: Record<string, string> = {
  SUPPORT_AGENT_FRONTEND_SUBNET: '127.0.0.0/8',
  SUPPORT_AGENT_TOOLS_SUBNET: '10.255.1.0/24',
  SUPPORT_AGENT_WEB_SUBNET: '10.255.2.0/24',
  SUPPORT_AGENT_EGRESS_EXTRA_HOSTS: 'api.extra.example.net',
  GITLAB_HOSTS: 'gitlab.com',
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function echoServer(): Promise<number> {
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        for (const socket of open) socket.destroy();
        server.close(() => r());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

async function proxy(
  overrides: Partial<Parameters<typeof createProxyServer>[0]> & {
    env?: Record<string, string>;
  } = {},
): Promise<{ port: number; proxy: ProxyServer; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const env = { ...LOCAL_ENV, ...(overrides.env ?? {}) };
  const p = createProxyServer({
    policy: policyFromEnv((n) => env[n]),
    log: (line) => lines.push(line),
    ...overrides,
  });
  await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r));
  cleanup.push(() => p.close());
  return { port: (p.server.address() as net.AddressInfo).port, proxy: p, lines };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function read(socket: net.Socket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('read timeout')), timeoutMs);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk.toString('utf8'));
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

function closed(socket: net.Socket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) return resolve();
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('parseTarget', () => {
  it('accepts host:port and bracketed IPv6 forms only', () => {
    expect(parseTarget('slack.com:443')).toEqual({ host: 'slack.com', port: 443 });
    expect(parseTarget('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 });
    expect(parseTarget('slack.com')).toBeNull();
    expect(parseTarget('slack.com:0')).toBeNull();
    expect(parseTarget('slack.com:99999')).toBeNull();
    expect(parseTarget('http://slack.com:443')).toBeNull();
    expect(parseTarget(undefined)).toBeNull();
  });
});

describe('CONNECT proxy', () => {
  it('refuses a gateway DNS answer containing a metadata address before opening a tunnel', async () => {
    const { port } = await proxy({
      env: {
        SUPPORT_AGENT_TOOLS_SUBNET: '127.0.0.0/8',
        SUPPORT_AGENT_FRONTEND_SUBNET: '10.255.1.0/24',
        MODEL_CATALOG: '[{"key":"gemini","route":"vertex-gemini","model":"fixture"}]',
        MODEL_DEFAULT_KEY: 'gemini',
        NATIVE_VERTEX_BASE_URL:
          'https://gateway.example.test/v1/projects/test-project/locations/global/publishers',
      },
      resolve: async () => ['10.1.2.3', '::ffff:169.254.169.254'],
    });
    const client = await connect(port);
    client.write('CONNECT gateway.example.test:443 HTTP/1.1\r\n\r\n');
    expect(await read(client)).toMatch(/^HTTP\/1\.1 403/);
  });

  it('tunnels an admitted pinned host and logs the tunnel', async () => {
    const target = await echoServer();
    const {
      port,
      proxy: p,
      lines,
    } = await proxy({
      resolve: async () => ['127.0.0.1'],
      dial: (address, _port, timeout) => defaultDial(address, target, timeout),
    });
    const client = await connect(port);
    client.write('CONNECT slack.com:443 HTTP/1.1\r\nHost: slack.com:443\r\n\r\n');
    expect(await read(client)).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n$/);
    client.write('ping');
    expect(await read(client)).toBe('ping');
    expect(p.stats().active.frontend).toBe(1);
    client.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(p.stats().active.frontend).toBe(0);
    expect(p.stats().tunnels.frontend).toBe(1);
    expect(lines.find((l) => l.event === 'open')).toEqual({
      event: 'open',
      source: 'frontend',
      host: 'slack.com',
      port: 443,
      mode: 'pinned',
    });
    const tunnel = lines.find((l) => l.event === 'tunnel');
    expect(tunnel).toMatchObject({
      source: 'frontend',
      host: 'slack.com',
      port: 443,
      mode: 'pinned',
    });
    expect(tunnel?.bytesIn).toBe(4);
    expect(tunnel?.bytesOut).toBe(4);
  });

  it('refuses a host outside the source policy with 403 and counts the denial', async () => {
    const { port, proxy: p, lines } = await proxy({ resolve: async () => ['127.0.0.1'] });
    const client = await connect(port);
    client.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n');
    expect(await read(client)).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    await closed(client);
    expect(p.stats().denied.frontend).toBe(1);
    expect(lines.find((l) => l.event === 'denied')).toMatchObject({
      reason: 'host',
      host: 'example.com',
    });
  });

  it('refuses the pinned host on a non-443 port and malformed targets', async () => {
    const { port } = await proxy({ resolve: async () => ['127.0.0.1'] });
    const a = await connect(port);
    a.write('CONNECT slack.com:80 HTTP/1.1\r\n\r\n');
    expect(await read(a)).toMatch(/^HTTP\/1\.1 403 /);
    const b = await connect(port);
    b.write('CONNECT slack.com HTTP/1.1\r\n\r\n');
    expect(await read(b)).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('refuses a web target that resolves to a private address before connecting', async () => {
    let dialed = 0;
    const { port, lines } = await proxy({
      env: {
        SUPPORT_AGENT_FRONTEND_SUBNET: '10.255.0.0/24',
        SUPPORT_AGENT_WEB_SUBNET: '127.0.0.0/8',
      },
      resolve: async () => ['93.184.216.34', '10.0.0.5'],
      dial: async () => {
        dialed += 1;
        throw new Error('must not dial');
      },
    });
    const client = await connect(port);
    client.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n');
    expect(await read(client)).toMatch(/^HTTP\/1\.1 403 /);
    expect(dialed).toBe(0);
    expect(lines.find((l) => l.event === 'denied')).toMatchObject({
      source: 'web',
      reason: 'private-address',
    });
  });

  it('tunnels a public web target on port 80 and 443', async () => {
    const target = await echoServer();
    const { port } = await proxy({
      env: {
        SUPPORT_AGENT_FRONTEND_SUBNET: '10.255.0.0/24',
        SUPPORT_AGENT_WEB_SUBNET: '127.0.0.0/8',
      },
      resolve: async () => ['93.184.216.34'],
      dial: (address, _port, timeout) =>
        defaultDial(address === '93.184.216.34' ? '127.0.0.1' : address, target, timeout),
    });
    for (const p of [80, 443]) {
      const client = await connect(port);
      client.write(`CONNECT example.com:${p} HTTP/1.1\r\n\r\n`);
      expect(await read(client)).toMatch(/^HTTP\/1\.1 200 /);
      client.write('x');
      expect(await read(client)).toBe('x');
      client.destroy();
    }
  });

  it('tools: tunnels GitLab, the registries and the Gateway; refuses anything else', async () => {
    const target = await echoServer();
    const {
      port,
      proxy: p,
      lines,
    } = await proxy({
      env: {
        SUPPORT_AGENT_FRONTEND_SUBNET: '10.255.0.0/24',
        SUPPORT_AGENT_TOOLS_SUBNET: '127.0.0.0/8',
      },
      resolve: async () => ['127.0.0.1'],
      dial: (address, _port, timeout) => defaultDial(address, target, timeout),
    });
    for (const host of ['gitlab.com', 'registry.npmjs.org', 'api.extra.example.net', 'slack.com']) {
      const client = await connect(port);
      client.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
      expect(await read(client), host).toMatch(/^HTTP\/1\.1 200 /);
      client.destroy();
    }
    for (const [line, reason] of [
      ['example.com:443', 'host'],
      ['gitlab.com:80', 'port'],
      ['169.254.169.254:80', 'malformed'],
    ] as const) {
      const client = await connect(port);
      client.write(`CONNECT ${line} HTTP/1.1\r\n\r\n`);
      expect(await read(client), line).toMatch(/^HTTP\/1\.1 403 /);
      await closed(client);
      expect(lines.filter((l) => l.event === 'denied').at(-1)).toMatchObject({
        source: 'tools',
        reason,
      });
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(p.stats().tunnels.tools).toBe(4);
    expect(p.stats().denied.tools).toBe(3);
    expect(p.stats().tunnels.frontend).toBe(0);
  });

  it('denies clients from an unknown network', async () => {
    const { port, proxy: p } = await proxy({
      env: { SUPPORT_AGENT_FRONTEND_SUBNET: '10.255.0.0/24' },
    });
    const client = await connect(port);
    client.write('CONNECT slack.com:443 HTTP/1.1\r\n\r\n');
    expect(await read(client)).toMatch(/^HTTP\/1\.1 403 /);
    expect(p.stats().denied.unknown).toBe(1);
  });

  it('answers 502 when the host does not resolve and 504 on a connect timeout', async () => {
    const { port, lines } = await proxy({
      resolve: async (host) => (host === 'slack.com' ? [] : ['127.0.0.1']),
      dial: () =>
        new Promise((_r, reject) => setTimeout(() => reject(new Error('connect timeout')), 20)),
      connectTimeoutMs: 20,
    });
    const a = await connect(port);
    a.write('CONNECT slack.com:443 HTTP/1.1\r\n\r\n');
    expect(await read(a)).toMatch(/^HTTP\/1\.1 502 /);
    expect(lines.find((l) => l.reason === 'unresolved')?.code).toBe('empty');
    const b = await connect(port);
    b.write('CONNECT api.extra.example.net:443 HTTP/1.1\r\n\r\n');
    expect(await read(b)).toMatch(/^HTTP\/1\.1 504 /);
  });

  it('logs the lookup error code on unresolved and retries EAI_AGAIN once', async () => {
    const calls: Record<string, number> = {};
    const fail = (code: string): never => {
      throw Object.assign(new Error(`getaddrinfo ${code}`), { code });
    };
    const { port, lines } = await proxy({
      resolveRetryMs: 1,
      resolve: async (host) => {
        calls[host] = (calls[host] ?? 0) + 1;
        if (host === 'slack.com') return fail('ENOTFOUND');
        // Extra host: EAI_AGAIN on every attempt.
        return fail('EAI_AGAIN');
      },
    });
    for (const host of ['slack.com', 'api.extra.example.net']) {
      const socket = await connect(port);
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
      expect(await read(socket)).toMatch(/^HTTP\/1\.1 502 /);
    }
    const unresolved = lines.filter((l) => l.reason === 'unresolved');
    expect(unresolved.map((l) => [l.host, l.code, l.port])).toEqual([
      ['slack.com', 'ENOTFOUND', 443],
      ['api.extra.example.net', 'EAI_AGAIN', 443],
    ]);
    expect(calls).toEqual({ 'slack.com': 1, 'api.extra.example.net': 2 });
  });

  it('opens the tunnel when an EAI_AGAIN lookup succeeds on the retry', async () => {
    const target = await echoServer();
    let attempts = 0;
    const { port, lines } = await proxy({
      resolveRetryMs: 1,
      resolve: async () => {
        attempts += 1;
        if (attempts === 1)
          throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
        return ['127.0.0.1'];
      },
      dial: (_address, _port, timeoutMs) =>
        new Promise((resolve, reject) => {
          const socket = net.connect({ host: '127.0.0.1', port: target });
          const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), timeoutMs);
          socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
          });
          socket.once('error', reject);
        }),
    });
    const client = await connect(port);
    client.write('CONNECT api.extra.example.net:443 HTTP/1.1\r\n\r\n');
    expect(await read(client)).toMatch(/^HTTP\/1\.1 200 /);
    expect(attempts).toBe(2);
    expect(lines.some((l) => l.reason === 'unresolved')).toBe(false);
    client.destroy();
  });

  it('falls back to the next address when the first connect fails', async () => {
    const target = await echoServer();
    const tried: string[] = [];
    const { port } = await proxy({
      resolve: async () => ['192.0.2.1', '127.0.0.1'],
      dial: (address, _port, timeout) => {
        tried.push(address);
        if (address === '192.0.2.1') return Promise.reject(new Error('ECONNREFUSED'));
        return defaultDial(address, target, timeout);
      },
    });
    const client = await connect(port);
    client.write('CONNECT slack.com:443 HTTP/1.1\r\n\r\n');
    expect(await read(client)).toMatch(/^HTTP\/1\.1 200 /);
    expect(tried).toEqual(['192.0.2.1', '127.0.0.1']);
  });

  it('ends an idle tunnel and refuses non-CONNECT requests', async () => {
    const target = await echoServer();
    const { port, lines } = await proxy({
      resolve: async () => ['127.0.0.1'],
      dial: (address, _port, timeout) => defaultDial(address, target, timeout),
      idleTimeoutMs: 100,
    });
    const client = await connect(port);
    client.write('CONNECT slack.com:443 HTTP/1.1\r\n\r\n');
    expect(await read(client)).toMatch(/^HTTP\/1\.1 200 /);
    await closed(client, 1500);
    expect(lines.find((l) => l.event === 'tunnel')).toMatchObject({ end: 'idle' });
    const plain = await connect(port);
    plain.write('GET http://slack.com/ HTTP/1.1\r\nHost: slack.com\r\n\r\n');
    expect(await read(plain)).toMatch(/^HTTP\/1\.1 405 /);
  });

  it('limits concurrent tunnels per source', async () => {
    const target = await echoServer();
    const { port } = await proxy({
      resolve: async () => ['127.0.0.1'],
      dial: (address, _port, timeout) => defaultDial(address, target, timeout),
      maxTunnelsPerSource: 1,
    });
    const first = await connect(port);
    first.write('CONNECT slack.com:443 HTTP/1.1\r\n\r\n');
    expect(await read(first)).toMatch(/^HTTP\/1\.1 200 /);
    const second = await connect(port);
    second.write('CONNECT slack.com:443 HTTP/1.1\r\n\r\n');
    expect(await read(second)).toMatch(/^HTTP\/1\.1 503 /);
    first.destroy();
  });
});

function defaultDial(address: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
