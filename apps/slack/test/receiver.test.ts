import { describe, expect, it } from 'vitest';
import { createSocketModeReceiver, type ReceiverDeps } from '../src/receiver.js';

describe('Socket Mode receiver lifecycle', () => {
  it('warns about a disconnect while running but not after a clean stop', async () => {
    const warnings: string[] = [];
    const receiver = createSocketModeReceiver({
      appToken: 'xapp-test',
      log: { info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined },
      installations: {} as ReceiverDeps['installations'],
      intake: {} as ReceiverDeps['intake'],
    });
    receiver.client.emit('disconnected');
    expect(warnings).toEqual(['disconnected from Slack Socket Mode (auto-reconnect active)']);
    warnings.length = 0;
    await receiver.stop();
    receiver.client.emit('disconnected');
    expect(warnings).toEqual([]);
  });
});
