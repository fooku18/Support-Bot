import { describe, expect, it } from 'vitest';
import {
  buildContextRebuiltNotice,
  claudeFailureLabel,
  buildClaudeReply,
  buildCodingReply,
  buildClaudeFailureReply,
  buildCodingFailureReply,
  buildCancellationReply,
  buildCompletionReply,
  sanitizeClaudeFailureReason,
} from '../../src/domain/delivery/replies.js';
import {
  buildTaskKey,
  compareTs,
  decodeSummary,
  displayTaskId,
  encodeSummary,
  isClaudeFailureCategory,
  mergeThreadMessages,
  messageId,
  parseTaskKey,
  summaryHasPending,
  TaskKeyError,
} from '../../src/contracts/protocol.js';

/**
 * Golden vectors. The Slack adapter and simulated runner carry mirror copies
 * of these helpers (apps/slack/src/taskkey.ts, runner display ids); both
 * packages assert the same vectors so the derived identities cannot drift.
 */
const GOLDEN_KEYS: Array<{
  identity: { installationId: string; teamId: string; channelId: string; rootTs: string };
  key: string;
  display: string;
}> = [
  {
    identity: {
      installationId: 'B0123456789',
      teamId: 'T0123456789',
      channelId: 'C0123456789',
      rootTs: '1716234567.123456',
    },
    key: 'v1:B0123456789:T0123456789:C0123456789:1716234567.123456',
    display: 'C0123456789:1716234567.123456',
  },
  {
    identity: {
      installationId: 'B0123456789',
      teamId: 'T0123456789',
      channelId: 'G02TEST',
      rootTs: '999.001',
    },
    key: 'v1:B0123456789:T0123456789:G02TEST:999.001',
    display: 'G02TEST:999.001',
  },
];

describe('task identity (golden vectors)', () => {
  for (const vector of GOLDEN_KEYS) {
    it(`builds and displays ${vector.key}`, () => {
      expect(buildTaskKey(vector.identity)).toBe(vector.key);
      expect(displayTaskId(vector.key)).toBe(vector.display);
      expect(parseTaskKey(vector.key)).toEqual(vector.identity);
    });
  }

  it('builds a key that is a valid, unambiguous cell name', () => {
    const key = buildTaskKey(GOLDEN_KEYS[0]!.identity);
    expect(key).toMatch(/^[A-Za-z0-9_.:$-]+$/);
    expect(key.length).toBeLessThanOrEqual(255);
    // Round-trips exactly; no two distinct identities produce one key.
    expect(parseTaskKey(key)).toEqual(GOLDEN_KEYS[0]!.identity);
  });

  it('rejects malformed components with sanitized errors', () => {
    expect(() => buildTaskKey({ ...GOLDEN_KEYS[0]!.identity, installationId: 'bot!' })).toThrow(
      TaskKeyError,
    );
    expect(() => buildTaskKey({ ...GOLDEN_KEYS[0]!.identity, rootTs: '12345' })).toThrow(
      TaskKeyError,
    );
    expect(() => buildTaskKey({ ...GOLDEN_KEYS[0]!.identity, channelId: 'x' })).toThrow(
      TaskKeyError,
    );
    expect(parseTaskKey('v0:B:T:C:1.1')).toBeUndefined();
    expect(parseTaskKey('nonsense')).toBeUndefined();
  });
});

describe('timestamp comparison', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareTs('90.001', '100.001')).toBe(-1);
    expect(compareTs('100.001', '90.001')).toBe(1);
    expect(compareTs('1716234567.123456', '1716234567.12345')).toBe(1);
    expect(compareTs('1716234567.12345', '1716234567.123450')).toBe(0);
    expect(compareTs('100.002', '100.001')).toBe(1);
    expect(compareTs('999.999999', '1000.000001')).toBe(-1);
  });
});

describe('message identity and merge', () => {
  it('deduplicates by channel+ts and merges edits without appending duplicates', () => {
    const first = mergeThreadMessages(
      [],
      [
        { ts: '100.001', userId: 'U1', text: 'root' },
        { ts: '100.002', userId: 'U2', text: 'reply' },
      ],
      { channelId: 'C1' },
    );
    const second = mergeThreadMessages(
      first.merged,
      [
        { ts: '100.001', userId: 'U1', text: 'root' },
        { ts: '100.002', userId: 'U2', text: 'edited reply', editedTs: '100.003' },
        { ts: '100.004', userId: 'U3', text: 'new' },
      ],
      { channelId: 'C1' },
    );
    expect(second.merged.map((m) => m.text)).toEqual(['root', 'edited reply', 'new']);
    expect(second.merged.map((m) => m.messageId)).toEqual([
      'C1:100.001',
      'C1:100.002',
      'C1:100.004',
    ]);
    expect(second.edits).toBe(1);
    expect(messageId('C1', '100.002')).toBe('C1:100.002');
  });

  it('bounds messages by the trigger timestamp and keeps other bots with their author', () => {
    const merged = mergeThreadMessages(
      [],
      [
        { ts: '90.000', userId: 'U1', text: 'before' },
        { ts: '95.000', botId: 'B0ALERT', authorName: 'Opsgenie', text: 'alert fired' },
        { ts: '96.000', botId: 'B0NONAME', text: 'nameless bot' },
        { ts: '97.000', text: 'no author' },
        { ts: '100.001', userId: 'U1', text: 'the mention' },
        { ts: '200.000', userId: 'U2', text: 'after the trigger' },
      ],
      { channelId: 'C1', boundTs: '100.001' },
    );
    expect(merged.merged.map((m) => m.ts)).toEqual(['90.000', '95.000', '96.000', '100.001']);
    expect(merged.merged[1]).toMatchObject({
      userId: null,
      botId: 'B0ALERT',
      authorName: 'Opsgenie',
      text: 'alert fired',
    });
    // A bot without a name is named by its bot ID; a person never carries a bot ID.
    expect(merged.merged[2]).toMatchObject({ botId: 'B0NONAME', authorName: 'B0NONAME' });
    expect(merged.merged[0]).toMatchObject({ userId: 'U1', botId: null, authorName: null });
    expect(merged.skippedAboveBound).toBe(1);
    expect(merged.skippedUnattributed).toBe(1);
  });
});

describe('storage_pressure failure category', () => {
  const ADMISSION =
    'aggregate storage reservation ceiling reached (100 + 200 > 250); pause new allocations rather than evicting active work';

  it('is a known category with a distinct thread-visible label', () => {
    expect(isClaudeFailureCategory('storage_pressure')).toBe(true);
    expect(claudeFailureLabel('storage_pressure')).toBe(
      'Storage capacity is full — new work paused',
    );
    expect(claudeFailureLabel('storage_pressure')).not.toBe(claudeFailureLabel('config'));
  });

  it('appends the scrubbed admission detail for storage_pressure only', () => {
    const text = sanitizeClaudeFailureReason('storage_pressure', ADMISSION);
    expect(text).toContain('Storage capacity is full — new work paused');
    expect(text).toContain('aggregate storage reservation ceiling reached');
    const redacted = sanitizeClaudeFailureReason(
      'storage_pressure',
      `${ADMISSION} sk-SECRETKEY123 xoxb-fake-token`,
    );
    expect(redacted).not.toContain('sk-SECRETKEY123');
    expect(redacted).not.toContain('xoxb-fake-token');
    expect(sanitizeClaudeFailureReason('storage_pressure', '')).toBe(
      'Storage capacity is full — new work paused',
    );
  });

  it('discards detail for every other category', () => {
    expect(sanitizeClaudeFailureReason('config', ADMISSION)).toBe(
      'Model execution is misconfigured',
    );
    expect(sanitizeClaudeFailureReason('provider_auth', '401 with sk-SECRETKEY123')).toBe(
      'Model provider authentication or access failed',
    );
  });
});

describe('registry summary', () => {
  it('round-trips and reports pending flags', () => {
    const summary = { ctx: 1, queued: 2, running: 0, outbox: 3, replies: 0 };
    expect(decodeSummary(encodeSummary(summary))).toEqual(summary);
    expect(decodeSummary('garbage')).toEqual({
      ctx: 0,
      queued: 0,
      running: 0,
      outbox: 0,
      replies: 0,
    });
    expect(decodeSummary(null)).toEqual({ ctx: 0, queued: 0, running: 0, outbox: 0, replies: 0 });
    expect(summaryHasPending(summary, ['ctx'])).toBe(true);
    expect(summaryHasPending(summary, ['queued'])).toBe(true);
    expect(summaryHasPending(summary, ['outbox'])).toBe(true);
    expect(
      summaryHasPending({ ctx: 0, queued: 0, running: 0, outbox: 0, replies: 0 }, [
        'ctx',
        'queued',
        'outbox',
      ]),
    ).toBe(false);
  });
});

describe('user-facing reply text', () => {
  const internal = /\[(op|rev):|Task C|coding run|support-agent\//;

  it('delivers the Claude answer without markers or a technical footer', () => {
    const reply = buildClaudeReply({
      answerText: '  Answer body with [brackets] kept.  ',
      maxChars: 3000,
    });
    expect(reply).toEqual({
      text: 'Answer body with [brackets] kept.',
      persistedAnswerText: 'Answer body with [brackets] kept.',
      truncated: false,
    });
  });

  it('bounds a long Claude answer with a truncation notice', () => {
    const reply = buildClaudeReply({ answerText: 'x'.repeat(500), maxChars: 200 });
    expect(reply.truncated).toBe(true);
    expect(reply.text.length).toBeLessThanOrEqual(200);
    expect(reply.text).toBe('The result is available as a downloadable file.');
    expect(reply.persistedAnswerText).toBe('x'.repeat(500));
  });

  it('renders tool answers and clarifications as the summary alone', () => {
    const summaryText = 'The project contains a single file `hello`.';
    for (const outcome of [{ discovery: true }, { clarification: true }]) {
      expect(
        buildCodingReply({
          changedFiles: 0,
          verification: 'passed',
          recoveryNeeded: false,
          summaryText,
          maxChars: 3000,
          ...outcome,
        }),
      ).toBe(summaryText);
    }
  });

  it('links the merge requests a tool answer published', () => {
    expect(
      buildCodingReply({
        changedFiles: 0,
        verification: 'not_run',
        recoveryNeeded: false,
        summaryText: 'Published both merge requests.',
        discovery: true,
        maxChars: 3000,
        mergeRequests: [
          { project: 'g/p', mrUrl: 'https://gitlab.example/g/p/-/merge_requests/1', mrIid: 1 },
          { project: 'g/q', mrUrl: 'https://gitlab.example/g/q/-/merge_requests/2', mrIid: 2 },
        ],
      }),
    ).toBe(
      'Published both merge requests.\n\n[Merge request g/p !1](https://gitlab.example/g/p/-/merge_requests/1) · [Merge request g/q !2](https://gitlab.example/g/q/-/merge_requests/2)',
    );
  });

  it('ends a coding change with one short status line', () => {
    const text = buildCodingReply({
      changedFiles: 2,
      verification: 'passed (`npm test`)',
      recoveryNeeded: false,
      summaryText: 'Added greet().',
      maxChars: 3000,
      mergeRequests: [{ project: 'group/app', mrUrl: 'https://gitlab.example/mr/1', mrIid: 1 }],
    });
    expect(text).toBe(
      'Added greet().\n\n✅ 2 files changed · verification passed (`npm test`) · [Merge request !1](https://gitlab.example/mr/1)',
    );
    expect(text).not.toMatch(internal);
    expect(
      buildCodingReply({
        changedFiles: 1,
        verification: 'passed',
        recoveryNeeded: true,
        partial: true,
        summaryText: 'Kept the draft.',
        maxChars: 3000,
      }),
    ).toBe(
      'Kept the draft.\n\n⚠️ Partial result · 1 file changed · not verified · recovery needed before follow-up work',
    );
  });

  it('keeps the status line when the summary must be shortened', () => {
    const text = buildCodingReply({
      changedFiles: 3,
      verification: 'passed',
      recoveryNeeded: false,
      summaryText: 'y'.repeat(1000),
      maxChars: 300,
      mergeRequests: [{ project: 'group/app', mrUrl: 'https://gitlab.example/mr/7', mrIid: 7 }],
    });
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain(
      `The result is available as a downloadable file.\n\n✅ 3 files changed · verification passed · [Merge request !7]`,
    );
  });

  it('states failures and cancellations without task identifiers', () => {
    const texts = [
      buildClaudeFailureReply({ reason: 'Model inference timed out' }),
      buildCodingFailureReply({ reason: 'verification failed (exit 1)' }),
      buildCancellationReply({ outcome: 'confirmed', mrUrl: 'https://gitlab.example/mr/2' }),
      buildCompletionReply({ contextRevision: 1, acceptedMessageCount: 2 }),
    ];
    expect(texts[0]).toBe('❌ The request failed: Model inference timed out.');
    expect(texts[1]).toBe('❌ The coding request failed: verification failed (exit 1).');
    expect(texts[2]).toBe(
      '🛑 Cancelled. The active request was stopped before further work started.\nMerge request: https://gitlab.example/mr/2',
    );
    for (const text of texts) {
      expect(text).not.toMatch(internal);
    }
  });

  it('lists every merge request of a coding reply and keeps the links when truncating', () => {
    const text = buildCodingReply({
      changedFiles: 2,
      verification: 'passed',
      recoveryNeeded: false,
      summaryText: 'x'.repeat(5000),
      maxChars: 600,
      mergeRequests: [
        {
          project: 'group/app',
          mrUrl: 'https://gitlab.example/group/app/-/merge_requests/1',
          mrIid: 1,
        },
        {
          project: 'group/lib',
          mrUrl: 'https://gitlab.example/group/lib/-/merge_requests/2',
          mrIid: 2,
        },
      ],
    });
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain(`The result is available as a downloadable file.\n\n✅`);
    expect(text).toMatch(
      /\n\n✅ 2 files changed · verification passed · \[Merge request group\/app !1\]\(https:\/\/gitlab\.example\/group\/app\/-\/merge_requests\/1\) · \[Merge request group\/lib !2\]\(https:\/\/gitlab\.example\/group\/lib\/-\/merge_requests\/2\)$/,
    );
    expect(text).not.toMatch(internal);
  });
});

describe('buildContextRebuiltNotice', () => {
  it('names the cause of a rebuilt context in one short footer line', () => {
    expect(buildContextRebuiltNotice('reset', null)).toBe(
      'Context rebuilt from this thread after a service reset',
    );
    expect(buildContextRebuiltNotice('rotation', 'model_changed')).toBe(
      'Context rebuilt from this thread after a model change',
    );
    expect(buildContextRebuiltNotice('rotation', 'prompt_changed')).toBe(
      'Context rebuilt from this thread after a channel prompt change',
    );
    expect(buildContextRebuiltNotice('rotation', 'policy_changed')).toBe(
      'Context rebuilt from this thread after a tool change',
    );
    expect(buildContextRebuiltNotice('rotation', 'storage_expired')).toBe(
      "Context rebuilt from this thread after the thread's workspace expired",
    );
  });
});
