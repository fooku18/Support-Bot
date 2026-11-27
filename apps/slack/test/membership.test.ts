import { describe, expect, it, vi } from 'vitest';
import { isChannelMember } from '../src/membership.js';
import { testInstallation } from './helpers/installations.js';
const identity = { teamId: 'TLOCAL', installationId: 'UBOT', botUserId: 'UBOT', botId: 'BBOT' };
describe('installation/channel membership', () => {
  it('finds a guest or external W identity across pages without home-team filtering', async () => {
    const members = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        members: ['UOTHER'],
        response_metadata: { next_cursor: 'next' },
      })
      .mockResolvedValueOnce({ ok: true, members: ['WEXTERNAL'], response_metadata: {} });
    expect(
      await isChannelMember(
        testInstallation(identity, { conversations: { members } }),
        'CSHARED',
        'WEXTERNAL',
      ),
    ).toBe(true);
    expect(members).toHaveBeenLastCalledWith({ channel: 'CSHARED', limit: 1000, cursor: 'next' });
  });
  it('denies an absent actor and fails closed on unavailable or looping rosters', async () => {
    const members = vi.fn().mockResolvedValue({ ok: true, members: [], response_metadata: {} });
    const installation = testInstallation(identity, { conversations: { members } });
    expect(await isChannelMember(installation, 'C1', 'U1')).toBe(false);
    members.mockResolvedValue({ ok: false });
    await expect(isChannelMember(installation, 'C1', 'U1')).rejects.toThrow(/unavailable/);
    members.mockResolvedValue({
      ok: true,
      members: [],
      response_metadata: { next_cursor: 'loop' },
    });
    await expect(isChannelMember(installation, 'C1', 'U1')).rejects.toThrow(/repeated/);
    members.mockRejectedValue(new Error('offline'));
    await expect(isChannelMember(installation, 'C1', 'U1')).rejects.toThrow('offline');
  });
});
