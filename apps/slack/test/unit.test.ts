import { describe, expect, it } from 'vitest';
import { isApplicationIdentity } from '../src/generated/trusted-bot-sender.js';
import { decideMention, type BotIdentity, type MentionEvent } from '../src/intake.js';

const identity: BotIdentity = {
  teamId: 'T0123456789',
  installationId: 'UBOTSELF',
  botUserId: 'UBOTSELF',
  botId: 'BSELF',
};

describe('decideMention', () => {
  const base: MentionEvent = {
    type: 'app_mention',
    user: 'UHUMAN1',
    channel: 'C0123456789',
    ts: '1716234567.111111',
    text: 'please do the thing',
  };

  it('accepts a human mention in a public channel', () => {
    const decision = decideMention(base, identity);
    expect(decision.kind).toBe('accept');
    if (decision.kind === 'accept') {
      expect(decision.request.channelId).toBe('C0123456789');
      expect(decision.request.rootTs).toBe('1716234567.111111');
      expect(decision.request.messageTs).toBe('1716234567.111111');
    }
  });

  it('uses thread_ts as the root for thread replies and keeps timestamps strings', () => {
    const decision = decideMention(
      { ...base, ts: '1716234600.000001', thread_ts: '1716234567.111111' },
      identity,
    );
    expect(decision.kind).toBe('accept');
    if (decision.kind === 'accept') {
      expect(decision.request.rootTs).toBe('1716234567.111111');
      expect(decision.request.messageTs).toBe('1716234600.000001');
    }
  });

  it('ignores bot-generated events, self events, DM channels, and events without timestamps', () => {
    expect(decideMention({ ...base, bot_id: 'BOTHER' }, identity).kind).toBe('ignore');
    expect(decideMention({ ...base, user: 'UBOTSELF' }, identity).kind).toBe('ignore');
    expect(decideMention({ ...base, bot_id: 'BSELF' }, identity).kind).toBe('ignore');
    expect(decideMention({ ...base, user: undefined }, identity).kind).toBe('ignore');
    expect(decideMention({ ...base, channel: 'D0123456789' }, identity).kind).toBe('ignore');
    expect(decideMention({ ...base, ts: undefined }, identity).kind).toBe('ignore');
    expect(decideMention({ ...base, type: 'message' }, identity).kind).toBe('ignore');
  });
});

const trustedBotSender = {
  teamId: identity.teamId,
  channelId: 'CTEST',
  botId: 'BTEST',
  userId: 'UTEST',
};
const automationMention: MentionEvent = {
  type: 'app_mention',
  channel: 'CTEST',
  user: 'UTEST',
  bot_id: 'BTEST',
  ts: '1716234567.111111',
  text: '<@UBOTSELF> test',
};

describe('configured trusted bot sender', () => {
  it('accepts only the exact bot/user pair in its workspace and channel', () => {
    const configured = { ...identity, trustedBotSender };
    expect(decideMention(automationMention, configured).kind).toBe('accept');
    expect(decideMention(automationMention, identity).kind).toBe('ignore');
    for (const change of [
      { bot_id: 'BOTHER' },
      { user: 'UOTHER' },
      { user: undefined },
      { channel: 'COTHER' },
      { type: 'message' },
      { user: 'UBOTSELF' },
      { bot_id: identity.botId },
    ]) {
      expect(decideMention({ ...automationMention, ...change }, configured).kind).toBe('ignore');
    }
    expect(decideMention(automationMention, { ...configured, teamId: 'TOTHER' }).kind).toBe(
      'ignore',
    );
    expect(
      decideMention(
        { ...automationMention, user: 'UBOTSELF' },
        { ...configured, trustedBotSender: { ...trustedBotSender, userId: 'UBOTSELF' } },
      ).kind,
    ).toBe('ignore');
    expect(
      decideMention(
        { ...automationMention, bot_id: identity.botId },
        {
          ...configured,
          trustedBotSender: { ...trustedBotSender, botId: identity.botId },
        },
      ).kind,
    ).toBe('ignore');
  });

  it('refuses a configured sender that is the application itself', () => {
    expect(isApplicationIdentity(trustedBotSender, identity)).toBe(false);
    expect(isApplicationIdentity({ ...trustedBotSender, botId: identity.botId }, identity)).toBe(
      true,
    );
    expect(isApplicationIdentity({ ...trustedBotSender, userId: 'UBOTSELF' }, identity)).toBe(true);
  });
});
