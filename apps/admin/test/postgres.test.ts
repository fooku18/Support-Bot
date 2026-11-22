import pg from 'pg';
import { expect, it } from 'vitest';
import { ChannelCommands } from '../src/channel-commands.js';
import { provisionSettingsDatabase } from '../src/database.js';
import { AdminStore } from '../src/store.js';

const ownerUrl = process.env.ADMIN_TEST_POSTGRES_OWNER_URL;
const runtimeUrl = process.env.ADMIN_TEST_POSTGRES_RUNTIME_URL;
const key = Buffer.alloc(32, 7);

function fixtureUrl(value: string | undefined): string {
  if (!value || !/^\/support_agent_settings_test$/.test(new URL(value).pathname)) {
    throw new Error(
      'Both PostgreSQL fixture URLs must name the disposable support_agent_settings_test database',
    );
  }
  return value;
}

it.skipIf(ownerUrl === undefined && runtimeUrl === undefined)(
  'provisions once, commits settings and receipts atomically and reopens encrypted state',
  async () => {
    const owner = new pg.Client({ connectionString: fixtureUrl(ownerUrl) });
    const runtime = new pg.Client({ connectionString: fixtureUrl(runtimeUrl) });
    const config = { connectionString: fixtureUrl(runtimeUrl) };
    const stores: AdminStore[] = [];
    const open = async () => {
      const store = await AdminStore.open(config, key);
      stores.push(store);
      return store;
    };
    try {
      await owner.connect();
      await runtime.connect();
      expect(
        (await owner.query("SELECT to_regclass('config_versions') AS existing")).rows[0]?.existing,
      ).toBeNull();
      await expect(open()).rejects.toThrow(
        'Run provision-postgres and grant the settings runtime access',
      );
      await provisionSettingsDatabase(fixtureUrl(ownerUrl));
      await provisionSettingsDatabase(fixtureUrl(ownerUrl));
      await owner.query(`
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO settings_test_runtime;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO settings_test_runtime;
      `);
      await expect(runtime.query('CREATE TABLE must_be_denied (id int)')).rejects.toMatchObject({
        code: '42501',
      });
      const [store, peer] = await Promise.all([open(), open()]);
      expect((await store.listAudit(10)).map((row) => row.action)).toEqual(['config.initialize']);

      const actor = 'fixture';
      const teamId = 'T1';
      const channelId = 'C1';
      const installation = {
        teamId,
        teamName: 'Test workspace',
        botUserId: 'UBOT',
        botId: 'B1',
        botToken: 'xoxb-settings-fixture',
        scopes: '',
      };
      await Promise.all([store.recordSeen(teamId), peer.recordSeen(teamId)]);
      await store.saveInstallation(actor, installation);
      await store.updateInstallation(actor, teamId, { status: 'whitelisted' });
      await store.setChannel(actor, {
        teamId,
        channelId,
        name: 'test',
        isPrivate: false,
        botMember: true,
        enabled: true,
      });
      const initial = (await store.currentDocument())!;
      const versions = await Promise.all([
        store.setWorkspaceModel(actor, teamId, 'opus', ['opus']),
        peer.setWorkspacePrompt(actor, teamId, 'A retained workspace setting'),
      ]);
      expect(versions.map(({ version }) => version).sort()).toEqual([
        initial.version + 1,
        initial.version + 2,
      ]);

      const configure = new ChannelCommands(store, () => ['opus']);
      const command = {
        teamId,
        channelId,
        userId: 'U1',
        messageTs: (Date.now() / 1000).toFixed(6),
        eventId: 'Ev1',
        text: '<@UBOT> !memory remember retained memory',
      };
      const before = await store.currentDocument();
      const audit = await store.listAudit(100);
      const notices: string[][] = [];
      store.onCommitted = (topics) => notices.push(topics);
      await expect(
        store.transaction(async () => {
          await store.setWorkspacePrompt(actor, teamId, 'rolled back');
          await configure.execute(command);
          throw new Error('forced rollback');
        }),
      ).rejects.toThrow('forced rollback');
      expect(await peer.currentDocument()).toEqual(before);
      expect(await peer.listAudit(100)).toEqual(audit);
      expect(notices).toEqual([]);
      expect((await configure.snapshot(teamId, channelId)).entries).toEqual([]);
      const replay = new ChannelCommands(peer, () => ['opus']);
      const [receipt, duplicate] = await Promise.all([
        configure.execute(command),
        replay.execute(command),
      ]);
      expect(duplicate).toEqual(receipt);
      expect((await replay.snapshot(teamId, channelId)).entries).toMatchObject([
        { id: 1, text: 'retained memory' },
      ]);
      const list = {
        ...command,
        messageTs: (Number(command.messageTs) + 1).toFixed(6),
        eventId: 'Ev2',
        text: '<@UBOT> !memory list',
      };
      await expect(
        store.transaction(async () => {
          await configure.execute(list);
          throw new Error('roll back receipt table');
        }),
      ).rejects.toThrow('roll back receipt table');
      expect(await peer.all('SELECT table_json FROM channel_command_receipt_tables')).toEqual([]);
      const listing = await configure.execute(list);
      const presentation = await peer.get(
        'SELECT table_json FROM channel_command_receipt_tables WHERE receipt_id = ?',
        `${listing.id}:0`,
      );
      expect(JSON.parse(String(presentation?.table_json))).toMatchObject({
        rows: [['#1', 'retained memory', expect.any(String)]],
      });
      const [rememberReceipt, listReceipt] = await Promise.all([
        configure.claimReceipt(),
        replay.claimReceipt(),
      ]);
      expect(new Set([rememberReceipt?.id, listReceipt?.id])).toEqual(
        new Set([`${receipt.id}:0`, `${listing.id}:0`]),
      );
      const listingReceipt = [rememberReceipt, listReceipt].find(
        (claimed) => claimed?.id === `${listing.id}:0`,
      );
      expect(listingReceipt?.table?.rows[0]?.slice(0, 2)).toEqual(['#1', 'retained memory']);
      expect(listingReceipt).toBeDefined();
      await configure.reportReceipt(
        listingReceipt!.id,
        listingReceipt!.lease,
        'delivered',
        '1716234567.111111',
      );
      expect(await store.all('SELECT table_json FROM channel_command_receipt_tables')).toEqual([]);

      const { instance } = await store.createToolInstance(actor, teamId, {
        kind: 'gitlab',
        label: 'Fixture GitLab',
        host: 'gitlab.example.test',
        credential: 'glpat-fixture-original',
      });
      await store.assignTool(actor, teamId, channelId, instance.kind, instance.id);
      await peer.recordToolStatus('fixture-runtime', [
        { instanceId: instance.id, state: 'ready', credentialVersion: 1 },
      ]);
      await store.updateToolInstance(actor, instance.id, { credential: 'glpat-fixture-rotated' });
      await peer.recordToolStatus('fixture-runtime', [
        { instanceId: instance.id, state: 'ready', credentialVersion: 1 },
      ]);
      expect(await store.toolStatus(instance.id)).toBeNull();
      await peer.recordToolStatus('fixture-runtime', [
        { instanceId: instance.id, state: 'ready', credentialVersion: 2 },
      ]);
      expect((await store.toolStatus(instance.id))?.state).toBe('ready');
      expect(
        (
          await runtime.query('SELECT credential_enc FROM tool_instances WHERE id = $1', [
            instance.id,
          ])
        ).rows[0]?.credential_enc,
      ).toMatch(/^v1:/);

      await store.createAdmin(actor, 'operator', 'synthetic-hash');
      const admin = (await store.adminByName('operator'))!;
      const [failed, concurrentFailure] = await Promise.all([
        store.recordLoginFailure(admin.name),
        peer.recordLoginFailure(admin.name),
      ]);
      expect(failed).not.toBe(concurrentFailure);
      await store.clearLoginFailure(failed);
      expect(await peer.recentLoginFailures(admin.name, Date.now() - 60_000)).toBe(1);
      await store.createSession('fixture-session', admin.id, 'csrf', Date.now() + 60_000);
      await peer.setAdminDisabled(actor, admin.id, true);
      expect(await store.session('fixture-session')).toBeNull();
      await store.saveOauthState('fixture-state', Date.now() + 60_000);
      const consumed = await Promise.all([
        store.consumeOauthState('fixture-state'),
        peer.consumeOauthState('fixture-state'),
      ]);
      expect(consumed.filter(Boolean)).toHaveLength(1);

      const completedAt = Date.UTC(2026, 9, 15);
      const batch = {
        requests: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            instance: 'fixture',
            completedAt,
            teamId,
            channelId,
            rootTs: command.messageTs,
            runId: 'fixture-run',
            runSeq: 1,
            attempt: 1,
            mode: 'answer' as const,
            requesterUserId: 'U1',
            model: 'opus',
            route: 'anthropic' as const,
            connection: 'anthropic',
            status: 200,
            durationMs: 300,
            outcome: 'completed' as const,
            inputTokens: 10,
            outputTokens: 5,
          },
        ],
        runs: [
          {
            runId: 'fixture-run',
            attempt: 1,
            instance: 'fixture',
            completedAt,
            teamId,
            channelId,
            rootTs: command.messageTs,
            mode: 'answer' as const,
            model: 'opus',
            requesterUserId: 'U1',
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimateUsd: 0.012,
            costBasis: 'sdk' as const,
            outcome: 'completed' as const,
          },
        ],
      };
      expect(await store.recordCostRows(batch)).toEqual({ requests: 1, runs: 1 });
      expect(await peer.recordCostRows(batch)).toEqual({ requests: 0, runs: 0 });
      const range = { from: '2026-10-15', to: '2026-10-15' };
      expect(await peer.costSums(range, 'day')).toMatchObject([
        { requests: 1, completedRequests: 1, runs: 1, estimateUsd: 0.012 },
      ]);
      expect(await peer.costSums(range, 'route')).toMatchObject([
        { key: { route: 'anthropic', connection: 'anthropic' }, requests: 1, runs: 0 },
      ]);

      const finalDocument = await store.currentDocument();
      expect(JSON.stringify(finalDocument)).not.toContain('glpat-fixture');
      const reopened = await open();
      expect(await reopened.currentDocument()).toEqual(finalDocument);
      expect(await reopened.botToken(teamId)).toBe(installation.botToken);
      expect(await reopened.toolSecret(instance.id)).toEqual({
        credential: 'glpat-fixture-rotated',
        credentialVersion: 2,
      });
    } finally {
      await Promise.all([...stores.map((store) => store.close()), owner.end(), runtime.end()]);
    }
  },
  20_000,
);
