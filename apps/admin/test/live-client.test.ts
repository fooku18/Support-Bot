import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { LIVE_CLIENT_JS } from '../src/views/live-client.js';

function browser() {
  const attrs: Record<string, string> = {
    'data-live-topics': 'config',
    'data-live-versions': '{"config":2}',
    'data-live-epoch': 'old',
  };
  const notice = { hidden: true, getAttribute: (name: string) => attrs[name] };
  const status = { textContent: '', setAttribute: () => undefined };
  const events = new Map<string, () => void>();
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    sent: string[] = [];
    onopen!: () => void;
    onmessage!: (message: { data: string }) => void;
    onclose!: (event: { code: number }) => void;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(message: string) {
      this.sent.push(message);
    }
  }
  runInNewContext(LIVE_CLIENT_JS, {
    document: {
      querySelectorAll: () => [notice],
      getElementById: () => status,
      addEventListener: (name: string, cb: () => void) => events.set(name, cb),
      hidden: false,
    },
    window: {
      WebSocket: Socket,
      addEventListener: (name: string, cb: () => void) => events.set(name, cb),
    },
    WebSocket: Socket,
    location: { protocol: 'https:', host: 'admin.example.test' },
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
  });
  const socket = sockets[0]!;
  const message = (body: unknown) => socket.onmessage({ data: JSON.stringify(body) });
  return { notice, status, sockets, socket, events, message };
}

describe('settings change notices', () => {
  it('offers reload on newer versions or a new server epoch without fetching or replacing form content', () => {
    const { socket, notice, message } = browser();
    expect(socket.url).toBe('wss://admin.example.test/live');
    socket.onopen();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'subscribe', topics: ['config'] });
    message({ type: 'hello', epoch: 'old' });
    message({ type: 'versions', epoch: 'old', versions: { config: 2 } });
    expect(notice.hidden).toBe(true);
    message({ type: 'changed', epoch: 'old', versions: { audit: 3 } });
    expect(notice.hidden).toBe(true);
    message({ type: 'changed', epoch: 'old', versions: { config: 3 } });
    expect(notice.hidden).toBe(false);
    notice.hidden = true;
    message({ type: 'versions', epoch: 'new', versions: { config: 0 } });
    expect(notice.hidden).toBe(false);
  });

  it('stays signed out when a revoked session goes online again', () => {
    const { socket, sockets, status, events } = browser();
    socket.onclose({ code: 4401 });
    events.get('online')!();
    events.get('visibilitychange')!();
    expect(sockets).toHaveLength(1);
    expect(status.textContent).toContain('signed out');
  });
});
