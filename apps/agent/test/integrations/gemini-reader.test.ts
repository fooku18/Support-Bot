import { describe, expect, it } from 'vitest';
import {
  publicWebUrl,
  readWebPage,
  WebReadError,
  webReaderFromEnv,
  type WebReader,
} from '../../src/integrations/web/gemini-reader.js';

const KEY = 'reader-secret-key';
const TARGET = new URL('https://docs.example.com/page');
const SUCCESS = 'URL_RETRIEVAL_STATUS_SUCCESS';

const answer = (
  text: string,
  retrieved: Array<[string, string]> = [[TARGET.href, SUCCESS]],
  finishReason = 'STOP',
) => ({
  candidates: [
    {
      finishReason,
      content: { parts: [{ text: 'private reasoning', thought: true }, { text }] },
      urlContextMetadata: {
        urlMetadata: retrieved.map(([retrievedUrl, urlRetrievalStatus]) => ({
          retrievedUrl,
          urlRetrievalStatus,
        })),
      },
    },
  ],
});

function reader(respond: (init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const value: WebReader = {
    baseUrl: 'https://models.example.test/v1beta',
    model: 'gemini-test-flash',
    apiKey: KEY,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return respond(init);
    }) as unknown as typeof fetch,
  };
  return { value, seen };
}

const read = (r: WebReader, signal = new AbortController().signal) =>
  readWebPage(r, TARGET, 'What is the port?', signal);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('web reader configuration', () => {
  const env = { NATIVE_WEB_FETCH_MODEL: 'gemini-test-flash', NATIVE_WEB_FETCH_API_KEY: KEY };
  it('is off without settings, and otherwise complete', () => {
    expect(webReaderFromEnv({}, fetch)).toBeUndefined();
    expect(webReaderFromEnv({ NATIVE_WEB_FETCH_MODEL: '  ' }, fetch)).toBeUndefined();
    expect(webReaderFromEnv(env, fetch)).toMatchObject({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-test-flash',
      apiKey: KEY,
    });
    expect(
      webReaderFromEnv(
        { ...env, NATIVE_WEB_FETCH_BASE_URL: 'https://gateway.example.test/v1beta/' },
        fetch,
      )?.baseUrl,
    ).toBe('https://gateway.example.test/v1beta');
  });

  it('refuses incomplete, unsafe or conflicting settings without showing the key', () => {
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
      [{ NATIVE_WEB_FETCH_API_KEY: KEY }, /NATIVE_WEB_FETCH_MODEL/],
      [{ ...env, NATIVE_WEB_FETCH_MODEL: '../x' }, /NATIVE_WEB_FETCH_MODEL/],
      [{ NATIVE_WEB_FETCH_MODEL: 'm' }, /NATIVE_WEB_FETCH_API_KEY/],
      [{ ...env, WEB_RUNTIME_URL: 'http://web' }, /not both/],
      ...[
        'http://gateway.example.test',
        'https://user:pw@gateway.example.test',
        'https://gateway.example.test/?key=x',
        'https://127.0.0.1/v1beta',
        'https://gateway/v1beta',
        'nonsense',
      ].map((url): [NodeJS.ProcessEnv, RegExp] => [
        { ...env, NATIVE_WEB_FETCH_BASE_URL: url },
        /NATIVE_WEB_FETCH_BASE_URL/,
      ]),
    ];
    for (const [value, pattern] of cases) {
      let message = '';
      try {
        webReaderFromEnv(value, fetch);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(pattern);
      expect(message).not.toContain(KEY);
    }
  });
});

describe('public web URLs', () => {
  it('accepts public pages and drops the fragment', () => {
    for (const url of ['https://example.com/a?b=c#d', 'http://example.com:80/', 'https://a.b.co'])
      expect(publicWebUrl(url).hash).toBe('');
  });

  it('refuses other schemes, credentials, ports, addresses and private names', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/',
      'javascript:alert(1)',
      'https://user:pw@example.com/',
      'https://example.com:8443/',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://8.8.8.8/',
      'http://[::1]/',
      'http://localhost/',
      'http://localhost./',
      'http://api.localhost/',
      'http://admin-app:9883/',
      'http://admin-app/',
      'http://metadata.google.internal/',
      'http://printer.local/',
      'http://host.home.arpa/',
      `https://example.com/${'x'.repeat(3_000)}`,
      'not a url',
      undefined,
      42,
    ])
      expect(() => publicWebUrl(url), String(url)).toThrow(WebReadError);
  });
});

describe('page reads', () => {
  it('sends one fixed request and returns the answer with its retrieved URLs', async () => {
    const f = reader(() => json(answer('The port is 8123: "default port is 8123".')));
    const out = await read(f.value);
    expect(out).toContain(`Retrieved: ${TARGET.href}\n`);
    expect(out).toContain('Untrusted data.');
    expect(out).toContain('The port is 8123');
    expect(out).not.toContain('private reasoning');
    expect(f.seen).toHaveLength(1);
    const { url, init } = f.seen[0]!;
    expect(url).toBe('https://models.example.test/v1beta/models/gemini-test-flash:generateContent');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'x-goog-api-key': KEY },
    });
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual([{ urlContext: {} }]);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: `Page: ${TARGET.href}\nQuestion: What is the port?` }] },
    ]);
    expect(String(init.body)).not.toContain(KEY);
  });

  it('accepts a redirected page and reports both URLs', async () => {
    const f = reader(() =>
      json(
        answer('Fact.', [
          [TARGET.href, SUCCESS],
          ['https://www.example.org/moved', SUCCESS],
        ]),
      ),
    );
    expect(await read(f.value)).toContain(
      `Retrieved: ${TARGET.href}, https://www.example.org/moved`,
    );
  });

  it.each([
    [
      'no metadata',
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x' }] } }] },
    ],
    ['no retrieval', answer('Invented.', [])],
    ['a failed retrieval', answer('Invented.', [[TARGET.href, 'URL_RETRIEVAL_STATUS_ERROR']])],
    ['an unsafe page', answer('Invented.', [[TARGET.href, 'URL_RETRIEVAL_STATUS_UNSAFE']])],
    ['a paywall', answer('Invented.', [[TARGET.href, 'URL_RETRIEVAL_STATUS_PAYWALL']])],
    ['another page only', answer('Invented.', [['https://other.example.net/', SUCCESS]])],
    [
      'one failed of two',
      answer('Invented.', [
        [TARGET.href, SUCCESS],
        ['https://other.example.net/', 'URL_RETRIEVAL_STATUS_ERROR'],
      ]),
    ],
    ['too many pages', answer('Invented.', Array(6).fill([TARGET.href, SUCCESS]))],
    ['the failure word', answer('RETRIEVAL_FAILED')],
    ['no candidate', { candidates: [] }],
  ])('never returns text without a confirmed retrieval: %s', async (_name, body) => {
    const f = reader(() => json(body));
    await expect(read(f.value)).rejects.toThrow('the page could not be retrieved');
  });

  it.each([
    ['a recitation stop', answer('', undefined, 'RECITATION')],
    ['a safety stop', answer('partial', undefined, 'SAFETY')],
    ['an empty answer', answer('  ')],
  ])('refuses %s', async (_name, body) => {
    const f = reader(() => json(body));
    await expect(read(f.value)).rejects.toThrow('gave no answer');
  });

  it('marks a cut answer and bounds its length', async () => {
    const cut = reader(() => json(answer('Partial', undefined, 'MAX_TOKENS')));
    expect(await read(cut.value)).toMatch(/Partial\n\[…truncated\]$/);
    const long = reader(() => json(answer('y'.repeat(50_000))));
    const out = await read(long.value);
    expect(out.length).toBeLessThan(12_300);
    expect(out).toMatch(/truncated\]$/);
  });

  it('reports failures with fixed messages that carry no upstream text or key', async () => {
    const cases: Array<[() => Response, RegExp]> = [
      [() => json({ error: { message: `bad key ${KEY}` } }, 401), /HTTP 401/],
      [() => json({ error: { message: `quota ${KEY}` } }, 429), /HTTP 429/],
      [() => new Response(`<html>${KEY}`), /invalid answer/],
      [() => new Response('x'.repeat(1_100_000)), /answered too much/],
      [
        () => {
          throw new Error(`connect ${KEY}`);
        },
        /could not be reached/,
      ],
    ];
    for (const [respond, pattern] of cases) {
      const error = await read(reader(respond).value).catch((e: Error) => e);
      expect(error).toBeInstanceOf(WebReadError);
      expect((error as Error).message).toMatch(pattern);
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it('stops when the run is cancelled', async () => {
    const controller = new AbortController();
    const f = reader(
      (init) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error)),
        ),
    );
    const pending = read(f.value, controller.signal);
    controller.abort(new Error('canceled'));
    await expect(pending).rejects.toThrow('canceled');
  });
});
