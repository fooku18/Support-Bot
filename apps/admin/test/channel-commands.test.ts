import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminStore } from '../src/store.js';
import { ChannelCommands } from '../src/channel-commands.js';
import { classifyChannelCommand } from '../src/generated/channel-commands.js';
const stores: AdminStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
async function setup(dbPath = ':memory:') {
  const store = await AdminStore.open({ path: dbPath }, Buffer.alloc(32, 7));
  stores.push(store);
  await store.saveInstallation('test', {
    teamId: 'T1',
    teamName: 'Team',
    botUserId: 'UBOT',
    botId: 'B1',
    botToken: 'xoxb-fake',
    scopes: '',
  });
  await store.updateInstallation('test', 'T1', { status: 'whitelisted' });
  await store.setChannel('test', {
    teamId: 'T1',
    channelId: 'C1',
    name: 'test',
    isPrivate: false,
    botMember: true,
    enabled: true,
  });
  await store.unblockMember('test', {
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
    displayName: 'User',
  });
  let now = Date.now() + 1000;
  const commands = new ChannelCommands(
    store,
    () => ['sonnet', 'opus'],
    () => now,
  );
  let sequence = 0;
  const source = (text: string) => ({
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
    messageTs: `${Math.floor(now / 1000)}.${String(++sequence).padStart(6, '0')}`,
    eventId: `Ev${sequence}`,
    text: `<@UBOT> ${text}`,
  });
  const open = async () => {
    const grant = (await commands.execute(source('!config'))).grant!;
    return await commands.open(grant, 'T1', 'C1', 'U1');
  };
  const save = async (session: string, model: string | null = 'opus', part1 = 'Use TypeScript.') =>
    await commands.save(
      session,
      'T1',
      'U1',
      { model, part1, part2: '', autoReplies: true },
      now + 1800,
    );
  return {
    store,
    commands,
    source,
    open,
    save,
    tick: (n: number) => {
      now += n;
    },
  };
}
describe('channel command grammar', () => {
  it('only reserves direct bot-leading commands; recognizes malformed/unknown commands without inference', () => {
    for (const text of [
      'example <@UBOT> !memory',
      '> <@UBOT> !help',
      '<@OTHER> !help',
      '<@UBOT> normal !help',
    ])
      expect(classifyChannelCommand(text, 'UBOT')).toBeNull();
    expect(classifyChannelCommand('<@UBOT> !MEMORY replace #2  x\ny ', 'UBOT')).toEqual({
      kind: 'replace',
      id: 2,
      text: ' x\ny ',
    });
    for (const text of ['!unknown', '!memory delete all', '!memory list 0', '!config please'])
      expect(classifyChannelCommand(`<@UBOT> ${text}`, 'UBOT')).toEqual({ kind: 'invalid' });
  });
});
describe('persistent explicit memory', () => {
  it('deduplicates by event and source, including replay of an add after deletion', async () => {
    const { commands, source } = await setup();
    const add = source('!memory remember  literal\n text ');
    const outcome = await commands.execute(add);
    await commands.execute({ ...add, eventId: 'EvAlias' });
    expect((await commands.snapshot('T1', 'C1')).entries[0]?.text).toBe(' literal\n text ');
    await commands.execute(source('!memory delete #1'));
    expect(await commands.execute(add)).toEqual(outcome);
    expect((await commands.snapshot('T1', 'C1')).entries).toEqual([]);
    await commands.execute(source('!memory remember another'));
    expect((await commands.snapshot('T1', 'C1')).entries[0]?.id).toBe(2);
  });
  it('preserves no-op revision/hash/timestamps and serializes literal replacement', async () => {
    const { commands, source, tick } = await setup();
    await commands.execute(source('!memory remember abc'));
    const pin = await commands.snapshot('T1', 'C1');
    tick(2000);
    await commands.execute(source('!memory replace #1 abc'));
    expect(await commands.snapshot('T1', 'C1')).toEqual(pin);
    await commands.execute(source('!memory replace #1 xyz'));
    await commands.execute(source('!memory replace #1 last'));
    expect(await commands.snapshot('T1', 'C1')).toMatchObject({
      revision: 3,
      entries: [{ text: 'last' }],
    });
  });
  it('bounds writes without truncation or config recompilation and omits note bodies from audit', async () => {
    const { commands, source, store } = await setup();
    const version = (await store.currentDocument())!.version;
    for (let i = 0; i < 13; i++)
      await commands.execute(source('!memory remember ' + 'x'.repeat(1000)));
    await commands.execute(source('!memory remember ' + 'x'.repeat(1001)));
    expect((await commands.snapshot('T1', 'C1')).entries).toHaveLength(12);
    expect((await store.currentDocument())!.version).toBe(version);
    expect(JSON.stringify(await store.listAudit(50))).not.toContain('x'.repeat(100));
  });
  it('checks live access even for duplicates; defers disabled receipts, scrubs confirmed content', async () => {
    const { commands, source, store } = await setup();
    const src = source('!memory remember secret note');
    await commands.execute(src);
    await store.updateInstallation('test', 'T1', { status: 'disabled' });
    await expect(commands.execute(src)).rejects.toThrow(/access/);
    expect(await commands.claimReceipt()).toBeNull();
    await store.updateInstallation('test', 'T1', { status: 'whitelisted' });
    const receipt = (await commands.claimReceipt())!;
    expect(receipt.reconcile).toBe(false);
    await commands.reportReceipt(receipt.id, receipt.lease, 'delivered', '1792940000.123456');
    expect(await commands.claimReceipt()).toBeNull();
    expect((await store.get('SELECT body FROM channel_command_receipts'))?.body).toBeNull();
    await commands.execute(src);
    expect(await commands.claimReceipt()).toBeNull();
  });
  it('reconciles expired posting leases and cascades workspace deletion', async () => {
    const { commands, source, tick, store } = await setup();
    await commands.execute(source('!memory remember note'));
    const first = (await commands.claimReceipt())!;
    tick(61000);
    const retry = (await commands.claimReceipt())!;
    expect(retry.id).toBe(first.id);
    expect(retry.reconcile).toBe(true);
    await expect(
      commands.reportReceipt(first.id, first.lease, 'delivered', '1792940000.123456'),
    ).rejects.toThrow(/lease/);
    await store.deleteInstallation('test', 'T1');
    for (const table of [
      'channel_memory',
      'channel_memory_state',
      'channel_commands',
      'channel_command_aliases',
      'channel_command_receipts',
    ])
      expect((await store.get(`SELECT count(*) AS n FROM ${table}`))?.n).toBe(0);
  });
});
describe('atomic shared configuration', () => {
  it.each(['', ' \t\r\n'])(
    'saves text without a mode and restores inheritance when cleared to %j',
    async (empty) => {
      const { store, commands, open } = await setup();
      await store.setWorkspacePrompt('admin', 'T1', 'Workspace instructions');
      const draft = await open();
      expect(draft.prompt).toBeNull();
      const input = {
        model: null,
        part1: ' Answer in pirate ',
        part2: 'language.\r\n ',
        autoReplies: true,
      };
      const saved = await commands.save(draft.session, 'T1', 'U1', input, Date.now() + 10000);
      expect(saved.changed).toBe(true);
      expect((await open()).prompt).toBe('Answer in pirate language.');
      expect(await commands.save(draft.session, 'T1', 'U1', input, Date.now() + 10000)).toEqual(
        saved,
      );
      const clear = await open();
      const cleared = await commands.save(
        clear.session,
        'T1',
        'U1',
        { model: null, part1: empty, part2: '', autoReplies: true },
        Date.now() + 10000,
      );
      expect(cleared.changed).toBe(true);
      expect((await store.channelSettings('T1', 'C1')).prompt).toBeNull();
      expect(await open()).toMatchObject({
        prompt: null,
        workspacePrompt: 'Workspace instructions',
      });
      await expect(
        commands.save(clear.session, 'T1', 'U1', input, Date.now() + 10000),
      ).rejects.toThrow(/already saved/);
    },
  );
  it('saves a continuation-only prompt and preserves the full boundary-sized text', async () => {
    const { commands, open } = await setup();
    const save = async (part1: string, part2: string) =>
      await commands.save(
        (await open()).session,
        'T1',
        'U1',
        { model: null, part1, part2, autoReplies: true },
        Date.now() + 10000,
      );
    await save('', 'Continuation only');
    expect((await open()).prompt).toBe('Continuation only');
    const first = 'a'.repeat(2999),
      second = '😀' + 'b'.repeat(999);
    await save(first, second);
    expect((await open()).prompt).toBe(first + second);
  });

  it('commits both settings once and terminally binds a form to the canonical payload', async () => {
    const { store, open, save, commands } = await setup();
    const draft = await open();
    const v = (await store.currentDocument())!.version;
    const saved = await save(draft.session);
    expect(saved).toEqual({ changed: true, configVersion: v + 1 });
    expect(await store.channelSettings('T1', 'C1')).toMatchObject({
      model: 'opus',
      prompt: 'Use TypeScript.',
    });
    expect(await save(draft.session)).toEqual(saved);
    await expect(save(draft.session, 'sonnet')).rejects.toThrow(/already saved/);
    expect(await commands.claimReceipt()).not.toBeNull();
    expect(await commands.claimReceipt()).toBeNull();
  });
  it('rejects stale admin and Slack editors, but workspace defaults do not stale inherit drafts', async () => {
    const { store, open, save } = await setup();
    const first = await open(),
      second = await open();
    const fingerprint = (await store.channelSettings('T1', 'C1')).fingerprint;
    await save(first.session);
    await expect(save(second.session)).rejects.toThrow(/changed/);
    await expect(
      store.setChannelSettings('admin', 'T1', 'C1', fingerprint, { model: 'sonnet' }, [
        'sonnet',
        'opus',
      ]),
    ).rejects.toThrow(/changed/);
    const third = await open();
    await store.setWorkspacePrompt('admin', 'T1', 'Workspace default');
    expect(await save(third.session, 'sonnet')).toMatchObject({ changed: true });
  });
  it('rolls back settings, session and receipt together, including deadline expiry', async () => {
    const { store, commands, open } = await setup();
    const draft = await open();
    const before = await store.channelSettings('T1', 'C1');
    await expect(
      commands.save(
        draft.session,
        'T1',
        'U1',
        { model: 'opus', part1: 'x'.repeat(3000), part2: 'x'.repeat(1001) },
        Date.now() + 10000,
      ),
    ).rejects.toThrow(/4000/);
    expect(await store.channelSettings('T1', 'C1')).toEqual(before);
    await expect(
      commands.save(
        draft.session,
        'T1',
        'U1',
        { model: 'opus', part1: '', part2: '', autoReplies: true },
        0,
      ),
    ).rejects.toThrow(/deadline/);
    expect(await store.channelSettings('T1', 'C1')).toEqual(before);
  });
  it('consumes no-op saves without a receipt and checks actor, expiry and live authorization', async () => {
    const { commands, open, source, store, tick } = await setup();
    const grant = (await commands.execute(source('!config'))).grant!;
    await store.unblockMember('test', {
      teamId: 'T1',
      channelId: 'C1',
      userId: 'U2',
      displayName: 'Other',
    });
    await expect(commands.open(grant, 'T1', 'C1', 'U2')).rejects.toThrow(/requester/);
    const draft = await open();
    const input = { model: null, part1: '', part2: '', autoReplies: true };
    expect(
      (await commands.save(draft.session, 'T1', 'U1', input, Date.now() + 10000)).changed,
    ).toBe(false);
    expect(await commands.claimReceipt()).toBeNull();
    await expect(
      commands.save(draft.session, 'T1', 'U1', { ...input, model: 'opus' }, Date.now() + 10000),
    ).rejects.toThrow(/already saved/);
    tick(61 * 60000);
    await expect(commands.open(grant, 'T1', 'C1', 'U1')).rejects.toThrow(/expired/);
  });
});

it('revalidates enabled delivery and lease ownership immediately before posting', async () => {
  const { store, commands, source } = await setup();
  await commands.execute(source('!help'));
  const receipt = (await commands.claimReceipt())!;
  expect(await commands.authorizeReceipt(receipt.id, receipt.lease)).toEqual({ ok: true });
  expect(await commands.authorizeReceipt(receipt.id, 'stale')).toEqual({ ok: false });
  await store.setChannel('test', {
    teamId: 'T1',
    channelId: 'C1',
    name: 'test',
    isPrivate: false,
    botMember: true,
    enabled: false,
  });
  expect(await commands.authorizeReceipt(receipt.id, receipt.lease)).toEqual({ ok: false });
  await store.setChannel('test', {
    teamId: 'T1',
    channelId: 'C1',
    name: 'test',
    isPrivate: false,
    botMember: true,
    enabled: true,
  });
  expect(await commands.authorizeReceipt(receipt.id, receipt.lease)).toEqual({ ok: true });
});

it('retains memory tombstones, aliases and settings sessions after reopening the SQLite store', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'channel-commands-store-')), 'admin.sqlite');
  const { store, commands, source, open } = await setup(dbPath);
  const add = source('!memory remember retained');
  const outcome = await commands.execute(add);
  await commands.execute(source('!memory delete #1'));
  const draft = await open();
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = await AdminStore.open({ path: dbPath }, Buffer.alloc(32, 7));
  stores.push(reopened);
  const recovered = new ChannelCommands(reopened, () => ['sonnet', 'opus']);
  expect(await recovered.execute({ ...add, eventId: 'reopened-alias' })).toEqual(outcome);
  expect((await recovered.snapshot('T1', 'C1')).entries).toEqual([]);
  await recovered.execute(source('!memory remember fresh'));
  expect((await recovered.snapshot('T1', 'C1')).entries[0]?.id).toBe(2);
  expect(
    (
      await recovered.save(
        draft.session,
        'T1',
        'U1',
        { model: 'opus', part1: '', part2: '', autoReplies: true },
        Date.now() + 1800,
      )
    ).changed,
  ).toBe(true);
});
it('rechecks People on invocation, open and save, and invalidates editors across re-pairing', async () => {
  const { store, commands, source, open, save } = await setup();
  const src = source('!config');
  const grant = (await commands.execute(src)).grant!;
  const draft = await open();
  await store.blockMember('test', { teamId: 'T1', channelId: 'C1', userId: 'U1', displayName: '' });
  await expect(commands.execute(src)).rejects.toThrow(/access/);
  await expect(commands.open(grant, 'T1', 'C1', 'U1')).rejects.toThrow(/access/);
  await expect(save(draft.session)).rejects.toThrow(/access/);
  await store.unblockMember('test', {
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
    displayName: 'User',
  });
  // A later installation epoch models the durable OAuth re-pair transaction.
  await store.run('UPDATE installations SET installed_at=installed_at+10000 WHERE team_id=?', 'T1');
  await expect(commands.open(grant, 'T1', 'C1', 'U1')).rejects.toThrow(/expired/);
  await expect(save(draft.session)).rejects.toThrow(/expired/);
  await expect(commands.execute(source('!memory remember old'))).rejects.toThrow(/predates/);
  // Already committed commands still deduplicate across the installation epoch.
  expect((await commands.execute(src)).grant).toBe(grant);
});

it('lists literal notes in bounded durable tables, reuses snapshot parts and scrubs delivered cells', async () => {
  const { commands, source, store, tick } = await setup();
  const finish = async () => {
    let receipt;
    while ((receipt = await commands.claimReceipt()))
      await commands.reportReceipt(receipt.id, receipt.lease, 'delivered', '1792940000.123456');
  };
  for (let n = 0; n < 10; n++)
    await commands.execute(source('!memory remember ' + '<!channel>\n'.padEnd(1000, 'x')));
  await finish();
  const src = source('!memory list');
  await commands.execute(src);
  const first = (await commands.claimReceipt())!;
  expect(first.table!.rows[0]).toEqual([
    '#1',
    '<!channel>\n'.padEnd(1000, 'x'),
    expect.stringContaining('UTC\nU1'),
  ]);
  expect(first.body).toContain('part 1/2');
  expect(first.table!.rows.flat().join('').length).toBeLessThan(9000);
  tick(61000);
  const retry = (await commands.claimReceipt())!;
  expect(retry.table).toEqual(first.table);
  expect(first.body).toContain('Listed ');
  expect(retry.body).toBe(first.body);
  await commands.reportReceipt(retry.id, retry.lease, 'delivered', '1792940000.123456');
  const second = (await commands.claimReceipt())!;
  expect(second.body).toContain('part 2/2');
  expect(first.table!.rows.length + second.table!.rows.length).toBe(10);
  await commands.reportReceipt(second.id, second.lease, 'delivered', '1792940000.123457');
  expect((await store.get('SELECT count(*) AS n FROM channel_command_receipt_tables'))?.n).toBe(0);
  await commands.execute(src);
  expect(await commands.claimReceipt()).toBeNull();
});

describe('automatic thread replies setting', () => {
  it('defaults on, saves off explicitly, keeps it across other edits and compiles it', async () => {
    const { store, commands, open, tick } = await setup();
    expect((await open()).autoReplies).toBe(true);
    expect((await store.currentDocument())?.toolAssignments[0]?.autoReplies ?? true).toBe(true);
    const session = (await open()).session;
    const saved = await commands.save(
      session,
      'T1',
      'U1',
      { model: null, part1: '', part2: '', autoReplies: false },
      Date.now() + 1800 + 1000,
    );
    expect(saved.changed).toBe(true);
    expect(await store.autoReplies('T1', 'C1')).toBe(false);
    expect((await store.currentDocument())?.toolAssignments[0]).toMatchObject({
      channelId: 'C1',
      autoReplies: false,
    });
    // A later edit of another field keeps the saved choice.
    tick(1000);
    const next = await open();
    expect(next.autoReplies).toBe(false);
    await commands.save(
      next.session,
      'T1',
      'U1',
      { model: 'opus', part1: '', part2: '', autoReplies: false },
      Date.now() + 1800 + 2000,
    );
    expect(await store.autoReplies('T1', 'C1')).toBe(false);
    // The public receipt names the setting.
    const receipt = await commands.claimReceipt();
    expect(receipt?.body).toContain('Automatic thread replies: Off');
    // Turning it back on stores the explicit choice.
    tick(1000);
    const again = await open();
    await commands.save(
      again.session,
      'T1',
      'U1',
      { model: 'opus', part1: '', part2: '', autoReplies: true },
      Date.now() + 1800 + 3000,
    );
    expect(await store.autoReplies('T1', 'C1')).toBe(true);
    expect(await store.listReplySettings()).toEqual([
      { teamId: 'T1', channelId: 'C1', autoReplies: true },
    ]);
  });

  it('refuses a value that is not a boolean', async () => {
    const { commands, open } = await setup();
    const session = (await open()).session;
    await expect(
      commands.save(
        session,
        'T1',
        'U1',
        { model: null, part1: '', part2: '', autoReplies: 'yes' },
        Date.now() + 1800 + 1000,
      ),
    ).rejects.toThrow(/Automatic thread replies/);
  });
});
