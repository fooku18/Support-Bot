/** Settings data, credential encryption and atomic compiled policy updates. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ConfigError } from './config.js';
import { SettingsDatabase, type Row, type SettingsDatabaseConfig } from './database.js';
import {
  compileDocument,
  contentHash,
  type ChannelRow,
  type ChannelToolRow,
  type CompiledDocument,
  type InstallationRow,
  type BlockedMemberRow,
  type ModelAssignmentRow,
  type PromptAssignmentRow,
  type ReplySettingRow,
  type ToolInstanceRow,
  type ToolStatusRow,
  type TrustedBotSender,
} from './compile.js';
import {
  COST_GROUPS,
  utcDay,
  type CostGroup,
  type CostLedgerStatus,
  type CostRequestRow,
  type CostRunRow,
  type CostSums,
} from './costs.js';
import { validModelKey } from './generated/model-catalog.js';
import { ChannelPromptError, normalizeChannelPrompt, promptAuditDetail } from './prompts.js';
import {
  isToolKind,
  parseAtlassianCredential,
  TOOL_INSTANCE_ID,
  validateToolCredential,
  validateToolInstance as validateContractToolInstance,
  ToolKindError,
  type ToolInstanceState,
  type ToolKind,
  type ToolSettings,
} from './generated/tool-kinds.js';

/**
 * The shared contract accepts `host:port` for GitLab, but the egress proxy
 * admits bare host names on port 443 only. Refuse a port here, where an
 * operator enters it, instead of letting the instance fail as unreachable.
 */
function validateToolInstance(input: Parameters<typeof validateContractToolInstance>[0]) {
  const validated = validateContractToolInstance(input);
  if (validated.kind === 'gitlab' && validated.host?.includes(':'))
    throw new ToolKindError(
      'host must be a bare hostname served on port 443, such as gitlab.example.com (no port)',
    );
  return validated;
}

export interface Installation extends InstallationRow {
  scopes: string;
  installedBy: string;
  installedAt: number | null;
  lastSeenAt: number | null;
  hasToken: boolean;
}

export interface Channel extends ChannelRow {
  name: string;
  isPrivate: boolean;
  botMember: boolean;
}

export interface BlockedMember extends BlockedMemberRow {
  displayName: string;
}

/** A stored tool instance; the credential itself is never part of it. */
export interface ToolInstance extends ToolInstanceRow {
  createdAt: number;
  updatedAt: number;
}

export type ToolStatus = ToolStatusRow;

export interface AnswerVote {
  runId: string;
  userId: string;
  teamId: string;
  channelId: string;
  rootTs: string;
  answerTs: string;
  vote: 'up' | 'down';
}

export interface AnswerFeedback {
  channelId: string;
  rootTs: string;
  answerTs: string;
  runId: string;
  up: number;
  down: number;
  lastAt: number;
}
export type ChannelTool = ChannelToolRow;

/** One readiness report from a runtime. */
export interface ToolStatusReport {
  instanceId: string;
  state: ToolInstanceState;
  detail?: string;
  toolsCount?: number | null;
  credentialVersion: number;
}

export const MAX_STATUS_DETAIL_CHARS = 200;

export interface AdminUser {
  id: number;
  name: string;
  passwordHash: string;
  disabled: boolean;
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: unknown;
  configVersion: number | null;
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export class AdminStore {
  onCommitted: ((topics: string[]) => void) | null = null;
  onSessionsRevoked: ((scope: { sessionId?: string; adminId?: number }) => void) | null = null;

  private notify(topics: string[]): void {
    const listener = this.onCommitted;
    if (listener) this.database.afterCommit(() => listener(topics));
  }

  private revoked(scope: { sessionId?: string; adminId?: number }): void {
    const listener = this.onSessionsRevoked;
    if (listener) this.database.afterCommit(() => listener(scope));
  }

  private constructor(
    private readonly database: SettingsDatabase,
    private readonly storeKey: Buffer,
  ) {}

  static async open(config: SettingsDatabaseConfig, storeKey: Buffer): Promise<AdminStore> {
    const database = new SettingsDatabase(config);
    const store = new AdminStore(database, storeKey);
    try {
      if ('connectionString' in config) {
        try {
          await store.all(
            'SELECT id, route, model, connection, outcome, input_tokens, output_tokens FROM provider_requests LIMIT 0',
          );
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === '42P01' || error.code === '42703' || error.code === '42501')
          )
            throw new ConfigError(
              'Provider request ledger unavailable. Run provision-postgres and grant the settings runtime access to provider_requests.',
            );
          throw error;
        }
      }
      await store.transaction(async () => {
        await store.removeUnknownToolKinds();
        if ((await store.currentDocument()) === null) {
          // An unconfigured service denies requests until an operator pairs a workspace.
          await store.mutate('system', 'config.initialize', 'config', {}, () => undefined);
        } else if ((await store.compileCandidate()).changed) {
          await store.mutate(
            'system',
            'config.recompile',
            'config',
            { reason: 'startup' },
            () => undefined,
          );
        }
      });
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  /** Drops assignments and instances of tool kinds this version no longer has. */
  private async removeUnknownToolKinds(): Promise<void> {
    const instances = (await this.all('SELECT id, kind FROM tool_instances')).filter(
      (row) => !isToolKind(row.kind),
    );
    const assignments = (
      await this.all('SELECT team_id, channel_id, kind FROM channel_tools')
    ).filter((row) => !isToolKind(row.kind));
    if (instances.length === 0 && assignments.length === 0) return;
    await this.mutate(
      'system',
      'tool.kind.remove',
      'tools',
      {
        kinds: [...new Set([...instances, ...assignments].map((row) => String(row.kind)))].sort(),
        instances: instances.map((row) => String(row.id)).sort(),
        assignments: assignments.length,
      },
      async () => {
        for (const row of assignments)
          await this.run(
            'DELETE FROM channel_tools WHERE team_id = ? AND channel_id = ? AND kind = ?',
            String(row.team_id),
            String(row.channel_id),
            String(row.kind),
          );
        for (const row of instances) {
          await this.run('DELETE FROM channel_tools WHERE instance_id = ?', String(row.id));
          await this.run('DELETE FROM tool_instance_status WHERE instance_id = ?', String(row.id));
          await this.run('DELETE FROM tool_instances WHERE id = ?', String(row.id));
        }
      },
    );
  }

  async all(sql: string, ...params: Array<string | number | null>): Promise<Row[]> {
    return (await this.database.query(sql, ...params)).rows;
  }

  async get(sql: string, ...params: Array<string | number | null>): Promise<Row | undefined> {
    return (await this.all(sql, ...params))[0];
  }

  async run(sql: string, ...params: Array<string | number | null>): Promise<number> {
    return (await this.database.query(sql, ...params)).changes;
  }

  /**
   * Runs one audited configuration mutation: change, recompile, store a new
   * version when the content changed, audit. Any error rolls back all of it.
   */
  async mutate<T>(
    actor: string,
    action: string,
    target: string,
    detail: Record<string, unknown>,
    change: () => T | Promise<T>,
  ): Promise<{ result: T; document: CompiledDocument }> {
    return await this.transaction(async () => {
      const result = await change();
      const document = await this.recompile(actor);
      await this.run(
        `INSERT INTO audit (at, actor, action, target, detail_json, config_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        Date.now(),
        actor,
        action,
        target,
        JSON.stringify(detail),
        document.version,
        Date.now(),
      );
      this.notify(['audit', 'config']);
      return { result, document };
    });
  }

  /** Audit row for an action that changes no configuration (logins, token reads). */
  async audit(
    actor: string,
    action: string,
    target: string,
    detail: Record<string, unknown> = {},
    configVersion: number | null = null,
  ): Promise<void> {
    await this.run(
      `INSERT INTO audit (at, actor, action, target, detail_json, config_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      actor,
      action,
      target,
      JSON.stringify(detail),
      configVersion,
      Date.now(),
    );
    this.notify(['audit']);
  }

  /** The document the current tables compile to, and whether it differs from the stored one. */
  private async compileCandidate(): Promise<{
    current: CompiledDocument | null;
    candidate: CompiledDocument;
    hash: string;
    changed: boolean;
  }> {
    const current = await this.currentDocument();
    const rows = {
      installations: await this.listInstallations(),
      channels: await this.listChannels(),
      blockedMembers: await this.listBlockedMembers(),
      toolInstances: await this.listToolInstances(),
      toolStatuses: await this.listToolStatuses(),
      channelTools: await this.listChannelTools(),
      modelAssignments: await this.listModelAssignments(),
      promptAssignments: await this.listPromptAssignments(),
      replySettings: await this.listReplySettings(),
    };
    const candidate = compileDocument((current?.version ?? 0) + 1, rows);
    const hash = contentHash(candidate);
    // The content hash covers only the sections this version compiles; a
    // stored document with a removed or added section has changed too.
    const sections = (document: object) => Object.keys(document).sort().join();
    return {
      current,
      candidate,
      hash,
      changed:
        current === null ||
        contentHash(current) !== hash ||
        sections(current) !== sections(candidate),
    };
  }

  private async recompile(actor: string): Promise<CompiledDocument> {
    const { current, candidate, hash, changed } = await this.compileCandidate();
    if (!changed && current !== null) return current;
    await this.run(
      `INSERT INTO config_versions (version, compiled_json, hash, content_hash, created_at, actor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      candidate.version,
      JSON.stringify(candidate),
      candidate.hash,
      hash,
      Date.now(),
      actor,
      Date.now(),
    );
    return candidate;
  }

  async currentDocument(): Promise<CompiledDocument | null> {
    const row = await this.get(
      'SELECT compiled_json FROM config_versions ORDER BY version DESC LIMIT 1',
    );
    return row === undefined ? null : (JSON.parse(String(row.compiled_json)) as CompiledDocument);
  }

  // -- installations -------------------------------------------------------

  async listInstallations(): Promise<Installation[]> {
    return (await this.all('SELECT * FROM installations ORDER BY team_id')).map(
      installationFromRow,
    );
  }

  async installation(teamId: string): Promise<Installation | null> {
    const row = await this.get('SELECT * FROM installations WHERE team_id = ?', teamId);
    return row === undefined ? null : installationFromRow(row);
  }

  /** Stores (or refreshes) a paired installation; a new one starts pending (D7). */
  async saveInstallation(
    actor: string,
    install: {
      teamId: string;
      teamName: string;
      botUserId: string;
      botId: string;
      botToken: string;
      scopes: string;
    },
  ): Promise<Installation> {
    await this.mutate(
      actor,
      'installation.paired',
      install.teamId,
      { teamName: install.teamName },
      async () => {
        const now = Date.now();
        const encrypted = this.encryptToken(install.teamId, install.botToken);
        const existing = await this.installation(install.teamId);
        if (existing === null) {
          await this.run(
            `INSERT INTO installations (team_id, team_name, bot_user_id, bot_id, bot_token_enc, scopes,
             installed_by, installed_at, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            install.teamId,
            install.teamName,
            install.botUserId,
            install.botId,
            encrypted,
            install.scopes,
            actor,
            now,
            now,
          );
        } else {
          // A reinstall replaces the token and identity, never the admin's
          // whitelisting decision.
          await this.run(
            `UPDATE installations SET team_name = ?, bot_user_id = ?, bot_id = ?, bot_token_enc = ?,
             scopes = ?, installed_by = ?, installed_at = ?, updated_at = ? WHERE team_id = ?`,
            install.teamName,
            install.botUserId,
            install.botId,
            encrypted,
            install.scopes,
            actor,
            now,
            now,
            install.teamId,
          );
        }
      },
    );
    return (await this.installation(install.teamId)) as Installation;
  }

  /** The adapter saw an event from a team that is not whitelisted. */
  async recordSeen(teamId: string): Promise<void> {
    await this.transaction(async () => {
      const now = Date.now();
      const existing = await this.installation(teamId);
      if (existing === null) {
        await this.mutate('adapter', 'installation.seen', teamId, {}, async () => {
          await this.run(
            `INSERT INTO installations (team_id, status, last_seen_at, updated_at)
             VALUES (?, 'pending', ?, ?)`,
            teamId,
            now,
            now,
          );
        });
        return;
      }
      await this.run(
        'UPDATE installations SET last_seen_at = ?, updated_at = ? WHERE team_id = ?',
        now,
        now,
        teamId,
      );
    });
  }

  async setInstallationStatus(
    actor: string,
    teamId: string,
    status: Installation['status'],
  ): Promise<CompiledDocument> {
    return await this.updateInstallation(actor, teamId, { status });
  }

  async setTrustedBotSender(
    actor: string,
    teamId: string,
    sender: TrustedBotSender | null,
  ): Promise<CompiledDocument> {
    return await this.updateInstallation(actor, teamId, { trustedBotSender: sender });
  }

  /**
   * Changes an installation's status and/or trusted bot sender in one
   * audited transaction: either every requested change is stored or none.
   */
  async updateInstallation(
    actor: string,
    teamId: string,
    change: { status?: Installation['status']; trustedBotSender?: TrustedBotSender | null },
  ): Promise<CompiledDocument> {
    const action =
      change.status !== undefined && change.trustedBotSender !== undefined
        ? 'installation.update'
        : change.status !== undefined
          ? 'installation.status'
          : 'installation.trustedBotSender';
    const detail = {
      ...(change.status === undefined ? {} : { status: change.status }),
      ...(change.trustedBotSender === undefined ? {} : { sender: change.trustedBotSender }),
    };
    return (
      await this.mutate(actor, action, teamId, detail, async () => {
        const existing = await this.requireInstallation(teamId);
        const { status, trustedBotSender: sender } = change;
        if (status === 'whitelisted' && !existing.hasToken) {
          throw new StoreError('the workspace has not completed pairing (no bot token)', 409);
        }
        if (
          sender !== undefined &&
          sender !== null &&
          (sender.botId === existing.botId || sender.userId === existing.botUserId)
        ) {
          throw new StoreError('the trusted bot sender must not be the application itself');
        }
        if (status !== undefined) {
          await this.run(
            'UPDATE installations SET status = ?, updated_at = ? WHERE team_id = ?',
            status,
            Date.now(),
            teamId,
          );
        }
        if (sender !== undefined) {
          await this.run(
            'UPDATE installations SET trusted_bot_sender_json = ?, updated_at = ? WHERE team_id = ?',
            sender === null ? null : JSON.stringify(sender),
            Date.now(),
            teamId,
          );
        }
      })
    ).document;
  }

  async deleteInstallation(actor: string, teamId: string): Promise<CompiledDocument> {
    return (
      await this.mutate(actor, 'installation.delete', teamId, {}, async () => {
        await this.requireInstallation(teamId);
        await this.run('DELETE FROM channel_tools WHERE team_id = ?', teamId);
        await this.run('DELETE FROM model_assignments WHERE team_id = ?', teamId);
        await this.run('DELETE FROM prompt_assignments WHERE team_id = ?', teamId);
        await this.run('DELETE FROM channel_reply_settings WHERE team_id = ?', teamId);
        await this.run(
          'DELETE FROM tool_instance_status WHERE instance_id IN (SELECT id FROM tool_instances WHERE team_id = ?)',
          teamId,
        );
        await this.run('DELETE FROM tool_instances WHERE team_id = ?', teamId);
        await this.run('DELETE FROM blocked_members WHERE team_id = ?', teamId);
        await this.run('DELETE FROM channels WHERE team_id = ?', teamId);
        await this.run('DELETE FROM installations WHERE team_id = ?', teamId);
      })
    ).document;
  }

  async botToken(teamId: string): Promise<string | null> {
    const row = await this.get('SELECT bot_token_enc FROM installations WHERE team_id = ?', teamId);
    if (row === undefined || row.bot_token_enc === null) return null;
    return this.decryptToken(teamId, String(row.bot_token_enc));
  }

  private async requireInstallation(teamId: string): Promise<Installation> {
    const existing = await this.installation(teamId);
    if (existing === null) throw new StoreError('unknown workspace', 404);
    return existing;
  }

  // -- channels and blocked members -------------------------------------------------

  async listChannels(teamId?: string): Promise<Channel[]> {
    const rows =
      teamId === undefined
        ? await this.all('SELECT * FROM channels ORDER BY team_id, name, channel_id')
        : await this.all(
            'SELECT * FROM channels WHERE team_id = ? ORDER BY name, channel_id',
            teamId,
          );
    return rows.map(channelFromRow);
  }

  async channel(teamId: string, channelId: string): Promise<Channel | null> {
    const row = await this.get(
      'SELECT * FROM channels WHERE team_id = ? AND channel_id = ?',
      teamId,
      channelId,
    );
    return row === undefined ? null : channelFromRow(row);
  }

  /**
   * Enables or disables a channel. Enabling requires the bot's membership,
   * which the caller verified against Slack just before.
   */
  async setChannel(
    actor: string,
    channel: {
      teamId: string;
      channelId: string;
      name: string;
      isPrivate: boolean;
      botMember: boolean;
      enabled: boolean;
    },
  ): Promise<CompiledDocument> {
    return (
      await this.mutate(
        actor,
        channel.enabled ? 'channel.enable' : 'channel.disable',
        `${channel.teamId}/${channel.channelId}`,
        { name: channel.name },
        async () => {
          await this.requireInstallation(channel.teamId);
          if (channel.enabled && !channel.botMember) {
            throw new StoreError('invite the bot to the channel before enabling it', 409);
          }
          await this.run(
            `INSERT INTO channels (team_id, channel_id, name, is_private, enabled, bot_member, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (team_id, channel_id) DO UPDATE SET name = excluded.name,
             is_private = excluded.is_private, enabled = excluded.enabled,
             bot_member = excluded.bot_member, updated_at = excluded.updated_at`,
            channel.teamId,
            channel.channelId,
            channel.name,
            channel.isPrivate ? 1 : 0,
            channel.enabled ? 1 : 0,
            channel.botMember ? 1 : 0,
            Date.now(),
          );
        },
      )
    ).document;
  }

  async listBlockedMembers(teamId?: string, channelId?: string): Promise<BlockedMember[]> {
    const rows =
      teamId === undefined
        ? await this.all('SELECT * FROM blocked_members ORDER BY team_id, channel_id, user_id')
        : channelId === undefined
          ? await this.all(
              'SELECT * FROM blocked_members WHERE team_id = ? ORDER BY channel_id, display_name, user_id',
              teamId,
            )
          : await this.all(
              'SELECT * FROM blocked_members WHERE team_id = ? AND channel_id = ? ORDER BY display_name, user_id',
              teamId,
              channelId,
            );
    return rows.map((row) => ({
      teamId: String(row.team_id),
      channelId: String(row.channel_id),
      userId: String(row.user_id),
      displayName: String(row.display_name),
    }));
  }

  /**
   * Blocks a member in one channel; blocking someone already blocked
   * keeps them and updates a non-empty display name.
   */
  async blockMember(
    actor: string,
    user: { teamId: string; channelId: string; userId: string; displayName: string },
  ): Promise<CompiledDocument> {
    if (
      !/^T[A-Z0-9]+$/.test(user.teamId) ||
      !/^[CG][A-Z0-9]+$/.test(user.channelId) ||
      !/^[UW][A-Z0-9]+$/.test(user.userId)
    )
      throw new StoreError('invalid blocked identity', 400);
    return (
      await this.mutate(
        actor,
        'channel.member.block',
        `${user.teamId}/${user.channelId}/${user.userId}`,
        {},
        async () => {
          await this.requireInstallation(user.teamId);
          if ((await this.channel(user.teamId, user.channelId)) === null) {
            throw new StoreError('enable or register the channel before blocking members', 409);
          }
          await this.run(
            `INSERT INTO blocked_members (team_id, channel_id, user_id, display_name, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (team_id, channel_id, user_id) DO UPDATE SET
             display_name = CASE WHEN excluded.display_name = '' THEN blocked_members.display_name
                                 ELSE excluded.display_name END,
             updated_at = excluded.updated_at`,
            user.teamId,
            user.channelId,
            user.userId,
            user.displayName,
            Date.now(),
          );
        },
      )
    ).document;
  }

  /** Unblocks a member in one channel (no-op when absent). */
  async unblockMember(
    actor: string,
    user: { teamId: string; channelId: string; userId: string },
  ): Promise<CompiledDocument> {
    return (
      await this.mutate(
        actor,
        'channel.member.unblock',
        `${user.teamId}/${user.channelId}/${user.userId}`,
        {},
        async () => {
          await this.requireInstallation(user.teamId);
          await this.run(
            'DELETE FROM blocked_members WHERE team_id = ? AND channel_id = ? AND user_id = ?',
            user.teamId,
            user.channelId,
            user.userId,
          );
        },
      )
    ).document;
  }

  // -- tool instances (credentials are write-only) ----------------------------

  async listToolInstances(teamId?: string): Promise<ToolInstance[]> {
    const rows =
      teamId === undefined
        ? await this.all(`${TOOL_INSTANCE_SELECT} ORDER BY t.team_id, t.kind, t.label, t.id`)
        : await this.all(
            `${TOOL_INSTANCE_SELECT} WHERE t.team_id = ? ORDER BY t.kind, t.label, t.id`,
            teamId,
          );
    return rows.map(toolInstanceFromRow);
  }

  async toolInstance(id: string): Promise<ToolInstance | null> {
    if (!TOOL_INSTANCE_ID.test(id)) return null;
    const row = await this.get(`${TOOL_INSTANCE_SELECT} WHERE t.id = ?`, id);
    return row === undefined ? null : toolInstanceFromRow(row);
  }

  async listToolStatuses(): Promise<ToolStatus[]> {
    return (await this.all('SELECT * FROM tool_instance_status ORDER BY instance_id')).map(
      toolStatusFromRow,
    );
  }

  async toolStatus(id: string): Promise<ToolStatus | null> {
    const row = await this.get('SELECT * FROM tool_instance_status WHERE instance_id = ?', id);
    return row === undefined ? null : toolStatusFromRow(row);
  }

  async listChannelTools(teamId?: string, channelId?: string): Promise<ChannelTool[]> {
    const rows =
      teamId === undefined
        ? await this.all('SELECT * FROM channel_tools ORDER BY team_id, channel_id, kind')
        : channelId === undefined
          ? await this.all(
              'SELECT * FROM channel_tools WHERE team_id = ? ORDER BY channel_id, kind',
              teamId,
            )
          : await this.all(
              'SELECT * FROM channel_tools WHERE team_id = ? AND channel_id = ? ORDER BY kind',
              teamId,
              channelId,
            );
    return rows.map((row) => ({
      teamId: String(row.team_id),
      channelId: String(row.channel_id),
      kind: String(row.kind) as ToolKind,
      instanceId: String(row.instance_id),
    }));
  }

  async createToolInstance(
    actor: string,
    teamId: string,
    input: {
      kind: unknown;
      label: unknown;
      host?: unknown;
      settings?: unknown;
      credential?: unknown;
    },
  ): Promise<{ instance: ToolInstance; document: CompiledDocument }> {
    const validated = validateToolInstance(input);
    const credential =
      input.credential === undefined
        ? null
        : validateToolCredential(validated.kind, input.credential);
    const id = `ti_${randomBytes(8).toString('hex')}`;
    const { document } = await this.mutate(
      actor,
      'tool.create',
      id,
      {
        teamId,
        kind: validated.kind,
        label: validated.label,
        host: validated.host,
        credentialChanged: credential !== null,
      },
      async () => {
        await this.requireInstallation(teamId);
        const now = Date.now();
        await this.run(
          `INSERT INTO tool_instances (id, team_id, kind, label, host, settings_json, credential_enc,
             credential_ver, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?)`,
          id,
          teamId,
          validated.kind,
          validated.label,
          validated.host,
          JSON.stringify(validated.settings),
          credential === null ? null : this.encryptToken(id, credential),
          credential === null ? 0 : 1,
          now,
          now,
        );
      },
    );
    return { instance: (await this.toolInstance(id)) as ToolInstance, document };
  }

  /**
   * Changes an instance. `settings` is merged over the stored settings; a
   * settings, host or credential change drops the runtime's readiness report,
   * so the instance is not ready again until a runtime has probed it.
   */
  async updateToolInstance(
    actor: string,
    id: string,
    change: {
      label?: unknown;
      host?: unknown;
      settings?: unknown;
      credential?: unknown;
      keepStoredTokens?: boolean;
      status?: unknown;
    },
  ): Promise<{ instance: ToolInstance; document: CompiledDocument }> {
    return this.transaction(async () => {
      const existing = await this.requireToolInstance(id);
      const settings =
        change.settings === undefined || change.settings === null
          ? existing.settings
          : typeof change.settings === 'object' && !Array.isArray(change.settings)
            ? { ...existing.settings, ...(change.settings as Record<string, unknown>) }
            : change.settings;
      const validated = validateToolInstance({
        kind: existing.kind,
        label: change.label ?? existing.label,
        host: change.host !== undefined ? change.host : existing.host,
        settings,
      });
      if (
        change.status !== undefined &&
        change.status !== 'enabled' &&
        change.status !== 'disabled'
      ) {
        throw new StoreError('status must be enabled or disabled');
      }
      const status = (change.status as ToolInstance['status'] | undefined) ?? existing.status;
      let credentialInput = change.credential;
      if (
        change.keepStoredTokens === true &&
        existing.kind === 'atlassian' &&
        typeof credentialInput === 'object' &&
        credentialInput !== null &&
        !('jira' in credentialInput && 'confluence' in credentialInput)
      ) {
        const row = await this.get('SELECT credential_enc FROM tool_instances WHERE id = ?', id);
        if (row !== undefined && row.credential_enc !== null)
          credentialInput = {
            ...parseAtlassianCredential(this.decryptToken(id, String(row.credential_enc))),
            ...credentialInput,
          };
      }
      const credential =
        credentialInput === undefined
          ? null
          : validateToolCredential(existing.kind, credentialInput);
      const settingsChanged =
        validated.host !== existing.host ||
        JSON.stringify(validated.settings) !== JSON.stringify(existing.settings);
      const { document } = await this.mutate(
        actor,
        'tool.update',
        id,
        {
          teamId: existing.teamId,
          kind: existing.kind,
          label: validated.label,
          host: validated.host,
          status,
          settingsChanged,
          credentialChanged: credential !== null,
        },
        async () => {
          await this.run(
            `UPDATE tool_instances SET label = ?, host = ?, settings_json = ?, status = ?, updated_at = ?
             WHERE id = ?`,
            validated.label,
            validated.host,
            JSON.stringify(validated.settings),
            status,
            Date.now(),
            id,
          );
          if (credential !== null) {
            await this.run(
              `UPDATE tool_instances SET credential_enc = ?, credential_ver = credential_ver + 1
               WHERE id = ?`,
              this.encryptToken(id, credential),
              id,
            );
          }
          if (settingsChanged || credential !== null) {
            await this.run('DELETE FROM tool_instance_status WHERE instance_id = ?', id);
          }
        },
      );
      return { instance: (await this.toolInstance(id)) as ToolInstance, document };
    });
  }

  /** Deletes an instance; refused while any channel uses it. */
  async deleteToolInstance(actor: string, id: string): Promise<CompiledDocument> {
    return this.transaction(async () => {
      const existing = await this.requireToolInstance(id);
      return (
        await this.mutate(
          actor,
          'tool.delete',
          id,
          { teamId: existing.teamId, kind: existing.kind, label: existing.label },
          async () => {
            const users = (
              await this.all(
                'SELECT channel_id FROM channel_tools WHERE instance_id = ? ORDER BY channel_id',
                id,
              )
            ).map((row) => String(row.channel_id));
            if (users.length > 0) {
              throw new StoreError(
                `the instance is assigned to ${users.length} channel(s) (${users.slice(0, 5).join(', ')}); unassign it first`,
                409,
              );
            }
            await this.run('DELETE FROM tool_instance_status WHERE instance_id = ?', id);
            await this.run('DELETE FROM tool_instances WHERE id = ?', id);
          },
        )
      ).document;
    });
  }

  /** Assigns an instance to a channel, replacing another instance of the same kind (D3). */
  async assignTool(
    actor: string,
    teamId: string,
    channelId: string,
    kind: string,
    instanceId: string,
  ): Promise<CompiledDocument> {
    if (!isToolKind(kind)) throw new StoreError('unknown tool kind');
    return (
      await this.mutate(
        actor,
        'tool.assign',
        `${teamId}/${channelId}/${kind}`,
        { instanceId },
        async () => await this.assignInTransaction(teamId, channelId, kind, instanceId),
      )
    ).document;
  }

  async unassignTool(
    actor: string,
    teamId: string,
    channelId: string,
    kind: string,
  ): Promise<CompiledDocument> {
    if (!isToolKind(kind)) throw new StoreError('unknown tool kind');
    return (
      await this.mutate(actor, 'tool.unassign', `${teamId}/${channelId}/${kind}`, {}, async () => {
        await this.requireInstallation(teamId);
        await this.unassignInTransaction(teamId, channelId, kind);
      })
    ).document;
  }

  /**
   * Sets several kinds of a channel at once (the channel Tools form): an
   * instance ID assigns, `null` unassigns; one transaction, one version.
   */
  async setChannelTools(
    actor: string,
    teamId: string,
    channelId: string,
    change: Partial<Record<ToolKind, string | null>>,
  ): Promise<CompiledDocument> {
    for (const kind of Object.keys(change))
      if (!isToolKind(kind)) throw new StoreError('unknown tool kind');
    return (
      await this.mutate(
        actor,
        'tool.assignments',
        `${teamId}/${channelId}`,
        { change },
        async () => {
          await this.requireInstallation(teamId);
          for (const [kind, instanceId] of Object.entries(change) as Array<
            [ToolKind, string | null]
          >) {
            if (instanceId === null) await this.unassignInTransaction(teamId, channelId, kind);
            else await this.assignInTransaction(teamId, channelId, kind, instanceId);
          }
        },
      )
    ).document;
  }

  private async assignInTransaction(
    teamId: string,
    channelId: string,
    kind: ToolKind,
    instanceId: string,
  ): Promise<void> {
    await this.requireInstallation(teamId);
    const instance = await this.toolInstance(instanceId);
    if (instance === null || instance.teamId !== teamId) {
      throw new StoreError('the tool instance does not belong to this workspace', 404);
    }
    if (instance.kind !== kind) {
      throw new StoreError(`the tool instance is a ${instance.kind} instance, not ${kind}`);
    }
    if (instance.status !== 'enabled') {
      throw new StoreError('enable the tool instance before assigning it', 409);
    }
    if ((await this.channel(teamId, channelId)) === null) {
      throw new StoreError('enable or register the channel before assigning tools', 409);
    }
    await this.run(
      `INSERT INTO channel_tools (team_id, channel_id, kind, instance_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (team_id, channel_id, kind) DO UPDATE SET instance_id = excluded.instance_id,
         updated_at = excluded.updated_at`,
      teamId,
      channelId,
      kind,
      instanceId,
      Date.now(),
    );
  }

  private async unassignInTransaction(
    teamId: string,
    channelId: string,
    kind: ToolKind,
  ): Promise<void> {
    await this.run(
      'DELETE FROM channel_tools WHERE team_id = ? AND channel_id = ? AND kind = ?',
      teamId,
      channelId,
      kind,
    );
  }

  // -- models ----------------------------------------------------------------

  /** Admin model choices; `channel_id = ''` stores the workspace default. */
  async listModelAssignments(teamId?: string): Promise<ModelAssignmentRow[]> {
    const rows =
      teamId === undefined
        ? await this.all('SELECT * FROM model_assignments ORDER BY team_id, channel_id')
        : await this.all(
            'SELECT * FROM model_assignments WHERE team_id = ? ORDER BY channel_id',
            teamId,
          );
    return rows.map((row) => ({
      teamId: String(row.team_id),
      channelId: row.channel_id === '' ? null : String(row.channel_id),
      modelKey: String(row.model_key),
    }));
  }

  /** The stored choice of a channel, or with `channelId` null the workspace default. */
  async modelAssignment(teamId: string, channelId: string | null): Promise<string | null> {
    const row = await this.get(
      'SELECT model_key FROM model_assignments WHERE team_id = ? AND channel_id = ?',
      teamId,
      channelId ?? '',
    );
    return row === undefined ? null : String(row.model_key);
  }

  /** Sets (or with null clears) a workspace's default model. */
  async setWorkspaceModel(
    actor: string,
    teamId: string,
    key: string | null,
    allowed: readonly string[] | null,
  ): Promise<CompiledDocument> {
    checkModelKey(key, allowed);
    return (
      await this.mutate(actor, 'workspace.model', teamId, { key }, async () => {
        await this.requireInstallation(teamId);
        await this.storeModelAssignment(teamId, '', key);
      })
    ).document;
  }

  /** Fingerprint only the channel overrides: changing inherited defaults does not stale a draft. */
  async channelSettings(
    teamId: string,
    channelId: string,
  ): Promise<{
    model: string | null;
    prompt: string | null;
    autoReplies: boolean;
    fingerprint: string;
  }> {
    const row = await this.get(
      `SELECT
        (SELECT model_key FROM model_assignments WHERE team_id = ? AND channel_id = ?) AS model,
        (SELECT text FROM prompt_assignments WHERE team_id = ? AND channel_id = ?) AS prompt,
        (SELECT auto_replies FROM channel_reply_settings WHERE team_id = ? AND channel_id = ?) AS replies`,
      teamId,
      channelId,
      teamId,
      channelId,
      teamId,
      channelId,
    );
    const model = typeof row?.model === 'string' ? row.model : null;
    const prompt = typeof row?.prompt === 'string' ? row.prompt : null;
    const autoReplies = row?.replies == null ? true : row.replies === 1;
    return {
      model,
      prompt,
      autoReplies,
      fingerprint: createHash('sha256')
        .update(JSON.stringify([model, prompt, autoReplies]))
        .digest('hex'),
    };
  }

  /** One compare-and-set for both surfaces; omitted fields remain unchanged inside the transaction. */
  async setChannelSettings(
    actor: string,
    teamId: string,
    channelId: string,
    expected: unknown,
    change: { model?: string | null; prompt?: unknown; autoReplies?: boolean },
    allowed: readonly string[] | null,
  ): Promise<{ document: CompiledDocument; changed: boolean }> {
    return await this.transaction(async () => {
      await this.requireInstallation(teamId);
      if ((await this.channel(teamId, channelId)) === null)
        throw new StoreError('register the channel before changing settings', 409);
      const before = await this.channelSettings(teamId, channelId);
      if (typeof expected !== 'string' || expected !== before.fingerprint) {
        throw new StoreError(
          'Channel settings changed or the fingerprint is missing; reopen the editor.',
          409,
        );
      }
      const model = change.model === undefined ? before.model : change.model;
      const prompt = change.prompt === undefined ? before.prompt : checkPrompt(change.prompt);
      const autoReplies = change.autoReplies ?? before.autoReplies;
      if (typeof autoReplies !== 'boolean')
        throw new StoreError('Automatic thread replies must be on or off.');
      if (model !== before.model) checkModelKey(model, allowed);
      if (model === before.model && prompt === before.prompt && autoReplies === before.autoReplies)
        return { document: (await this.currentDocument())!, changed: false };
      if (model !== before.model) await this.storeModelAssignment(teamId, channelId, model);
      if (prompt !== before.prompt) await this.storePromptAssignment(teamId, channelId, prompt);
      // An explicit save stores the choice, so a later default change never flips it.
      if (autoReplies !== before.autoReplies)
        await this.run(
          `INSERT INTO channel_reply_settings (team_id, channel_id, auto_replies, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (team_id, channel_id) DO UPDATE SET auto_replies = excluded.auto_replies,
             updated_at = excluded.updated_at`,
          teamId,
          channelId,
          autoReplies ? 1 : 0,
          Date.now(),
        );
      const document = await this.recompile(actor);
      if (autoReplies !== before.autoReplies)
        await this.audit(
          actor,
          'channel.autoReplies',
          `${teamId}/${channelId}`,
          { autoReplies },
          document.version,
        );
      if (model !== before.model)
        await this.audit(
          actor,
          'channel.model',
          `${teamId}/${channelId}`,
          { key: model },
          document.version,
        );
      if (prompt !== before.prompt)
        await this.audit(
          actor,
          'channel.prompt',
          `${teamId}/${channelId}`,
          promptAuditDetail(prompt),
          document.version,
        );
      return { document, changed: true };
    });
  }

  /** Nested callers participate in the same atomic commit (settings + session + receipt). */
  transaction<T>(change: () => T | Promise<T>): Promise<T> {
    return this.database.transaction(change);
  }

  private async storeModelAssignment(
    teamId: string,
    channelId: string,
    key: string | null,
  ): Promise<void> {
    if (key === null) {
      await this.run(
        'DELETE FROM model_assignments WHERE team_id = ? AND channel_id = ?',
        teamId,
        channelId,
      );
      return;
    }
    await this.run(
      `INSERT INTO model_assignments (team_id, channel_id, model_key, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id, channel_id) DO UPDATE SET model_key = excluded.model_key,
         updated_at = excluded.updated_at`,
      teamId,
      channelId,
      key,
      Date.now(),
    );
  }

  // -- automatic thread replies -------------------------------------

  /** Channels that saved the setting; a channel without a row has it on. */
  async listReplySettings(): Promise<ReplySettingRow[]> {
    return (
      await this.all('SELECT * FROM channel_reply_settings ORDER BY team_id, channel_id')
    ).map((row) => ({
      teamId: String(row.team_id),
      channelId: String(row.channel_id),
      autoReplies: Number(row.auto_replies) === 1,
    }));
  }

  /** The channel's "Automatic thread replies" setting (default on). */
  async autoReplies(teamId: string, channelId: string): Promise<boolean> {
    const row = await this.get(
      'SELECT auto_replies FROM channel_reply_settings WHERE team_id = ? AND channel_id = ?',
      teamId,
      channelId,
    );
    return row === undefined ? true : Number(row.auto_replies) === 1;
  }

  // -- prompts ---------------------------------------------------------------

  /** Admin channel prompts; `channel_id = ''` stores the workspace default. */
  async listPromptAssignments(teamId?: string): Promise<PromptAssignmentRow[]> {
    const rows =
      teamId === undefined
        ? await this.all('SELECT * FROM prompt_assignments ORDER BY team_id, channel_id')
        : await this.all(
            'SELECT * FROM prompt_assignments WHERE team_id = ? ORDER BY channel_id',
            teamId,
          );
    return rows.map((row) => ({
      teamId: String(row.team_id),
      channelId: row.channel_id === '' ? null : String(row.channel_id),
      text: String(row.text),
    }));
  }

  /** The stored prompt of a channel, or with `channelId` null the workspace default. */
  async promptAssignment(teamId: string, channelId: string | null): Promise<string | null> {
    const row = await this.get(
      'SELECT text FROM prompt_assignments WHERE team_id = ? AND channel_id = ?',
      teamId,
      channelId ?? '',
    );
    return row === undefined ? null : String(row.text);
  }

  /** Sets (or with null or whitespace clears) a workspace's default prompt. */
  async setWorkspacePrompt(
    actor: string,
    teamId: string,
    value: unknown,
  ): Promise<CompiledDocument> {
    const text = checkPrompt(value);
    return (
      await this.mutate(actor, 'workspace.prompt', teamId, promptAuditDetail(text), async () => {
        await this.requireInstallation(teamId);
        await this.storePromptAssignment(teamId, '', text);
      })
    ).document;
  }

  private async storePromptAssignment(
    teamId: string,
    channelId: string,
    text: string | null,
  ): Promise<void> {
    if (text === null) {
      await this.run(
        'DELETE FROM prompt_assignments WHERE team_id = ? AND channel_id = ?',
        teamId,
        channelId,
      );
      return;
    }
    await this.run(
      `INSERT INTO prompt_assignments (team_id, channel_id, text, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id, channel_id) DO UPDATE SET text = excluded.text,
         updated_at = excluded.updated_at`,
      teamId,
      channelId,
      text,
      Date.now(),
    );
  }

  /**
   * The decrypted credential of an enabled instance, for the internal secret
   * endpoint only (the caller audits the read). Null for unknown or disabled
   * instances and instances without a credential.
   */
  async toolSecret(id: string): Promise<{ credential: string; credentialVersion: number } | null> {
    if (!TOOL_INSTANCE_ID.test(id)) return null;
    const row = await this.get(`${TOOL_INSTANCE_SELECT} WHERE t.id = ?`, id);
    if (row === undefined || row.status !== 'enabled') return null;
    // A Slack instance reads its workspace's bot token (never a stored credential).
    if (row.kind === 'slack') {
      const instance = toolInstanceFromRow(row);
      if (!instance.hasCredential) return null;
      return {
        credential: this.decryptToken(instance.teamId, String(row.ws_token_enc)),
        credentialVersion: instance.credentialVersion,
      };
    }
    if (row.credential_enc === null) return null;
    return {
      credential: this.decryptToken(id, String(row.credential_enc)),
      credentialVersion: Number(row.credential_ver),
    };
  }

  /**
   * Stores runtime readiness reports. Reports for unknown instances or for a
   * credential version other than the current one (stale probes) are
   * ignored. A report that changes the effective readiness recompiles the
   * document (audited as `tool.status`); a repeat only refreshes its time.
   */
  async recordToolStatus(reporter: string, statuses: ToolStatusReport[]): Promise<void> {
    await this.transaction(async () => {
      for (const report of statuses) {
        const instance = await this.toolInstance(report.instanceId);
        if (instance === null || report.credentialVersion !== instance.credentialVersion) continue;
        const detail = sanitizeDetail(report.detail ?? '');
        const toolsCount = report.toolsCount ?? null;
        const existing = await this.toolStatus(instance.id);
        const now = Date.now();
        const effective = (state: string, text: string, version: number): string =>
          `${state === 'ready' ? 'ready' : `${state}:${text}`}@${version}`;
        if (
          existing !== null &&
          effective(existing.state, existing.detail, existing.credentialVersion) ===
            effective(report.state, detail, report.credentialVersion)
        ) {
          await this.run(
            `UPDATE tool_instance_status SET detail = ?, tools_count = ?, reporter = ?, reported_at = ?
             WHERE instance_id = ?`,
            detail,
            toolsCount,
            reporter,
            now,
            instance.id,
          );
          continue;
        }
        await this.mutate(
          reporter,
          'tool.status',
          instance.id,
          { state: report.state, credentialVersion: report.credentialVersion },
          async () => {
            await this.run(
              `INSERT INTO tool_instance_status (instance_id, state, detail, tools_count, credential_ver,
                 reporter, reported_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (instance_id) DO UPDATE SET state = excluded.state, detail = excluded.detail,
                 tools_count = excluded.tools_count, credential_ver = excluded.credential_ver,
                 reporter = excluded.reporter, reported_at = excluded.reported_at`,
              instance.id,
              report.state,
              detail,
              toolsCount,
              report.credentialVersion,
              reporter,
              now,
            );
          },
        );
      }
    });
  }

  private async requireToolInstance(id: string): Promise<ToolInstance> {
    const existing = await this.toolInstance(id);
    if (existing === null) throw new StoreError('unknown tool instance', 404);
    return existing;
  }

  // -- cost ledger -----------------

  /**
   * Stores one validated batch from the runner in one transaction. Rows
   * already stored (a retried post) are ignored, so nothing is counted
   * twice. Telemetry, not configuration: no audit row.
   */
  async recordCostRows(batch: { requests: CostRequestRow[]; runs: CostRunRow[] }): Promise<{
    requests: number;
    runs: number;
  }> {
    const now = Date.now();
    const insertRequest = `INSERT INTO provider_requests (id, instance, day, completed_at, received_at, team_id,
         channel_id, root_ts, run_id, run_seq, attempt, mode, requester_user_id, model, route,
         connection, status, duration_ms, outcome, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`;
    const insertRun = `INSERT INTO cost_runs (run_id, attempt, instance, day, completed_at, received_at,
         team_id, channel_id, root_ts, mode, model, requester_user_id, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, estimate_usd, cost_basis, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, attempt) DO NOTHING`;
    return await this.transaction(async () => {
      let requests = 0;
      let runs = 0;
      for (const row of batch.requests) {
        requests += await this.run(
          insertRequest,
          row.id,
          row.instance,
          utcDay(row.completedAt),
          row.completedAt,
          now,
          row.teamId,
          row.channelId,
          row.rootTs,
          row.runId,
          row.runSeq,
          row.attempt,
          row.mode,
          row.requesterUserId,
          row.model,
          row.route,
          row.connection,
          row.status,
          row.durationMs,
          row.outcome,
          row.inputTokens,
          row.outputTokens,
        );
      }
      for (const row of batch.runs) {
        runs += await this.run(
          insertRun,
          row.runId,
          row.attempt,
          row.instance,
          utcDay(row.completedAt),
          row.completedAt,
          now,
          row.teamId,
          row.channelId,
          row.rootTs,
          row.mode,
          row.model,
          row.requesterUserId,
          row.inputTokens,
          row.outputTokens,
          row.cacheReadTokens,
          row.cacheCreationTokens,
          row.estimateUsd,
          row.costBasis,
          row.outcome,
        );
      }
      if (requests + runs > 0) this.notify(['costs']);
      return { requests, runs };
    });
  }

  /**
   * Sums per group over the UTC days `from`..`to` (inclusive), computed by
   * query (D6). Request sums and run sums are grouped separately and joined
   * on the group key.
   */
  async costSums(range: { from: string; to: string }, group: CostGroup): Promise<CostSums[]> {
    const columns = COST_GROUPS[group];
    const keyOf = (row: Row): string => columns.map((column) => String(row[column])).join('\u0000');
    const select = columns.join(', ');
    const merged = new Map<string, CostSums>();
    const entry = (row: Row): CostSums => {
      const key = keyOf(row);
      let sums = merged.get(key);
      if (sums === undefined) {
        sums = {
          key: Object.fromEntries(
            columns.map((column) => [column, row[column] === null ? null : row[column]]),
          ) as CostSums['key'],
          requests: 0,
          completedRequests: 0,
          failedRequests: 0,
          interruptedRequests: 0,
          runs: 0,
          runsWithEstimate: 0,
          estimateUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        merged.set(key, sums);
      }
      return sums;
    };
    for (const row of await this.all(
      `SELECT ${select}, COUNT(*) AS requests,
         SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN outcome = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM provider_requests WHERE day BETWEEN ? AND ? GROUP BY ${select}`,
      range.from,
      range.to,
    )) {
      const sums = entry(row);
      sums.requests = Number(row.requests);
      sums.completedRequests = Number(row.completed);
      sums.failedRequests = Number(row.failed);
      sums.interruptedRequests = Number(row.interrupted);
      sums.inputTokens = Number(row.input_tokens);
      sums.outputTokens = Number(row.output_tokens);
    }
    if (group !== 'route' && group !== 'model') {
      for (const row of await this.all(
        `SELECT ${select}, COUNT(*) AS runs,
           SUM(CASE WHEN estimate_usd IS NOT NULL THEN 1 ELSE 0 END) AS with_estimate,
           COALESCE(SUM(estimate_usd), 0) AS estimate_usd,
           COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation
         FROM cost_runs WHERE day BETWEEN ? AND ? GROUP BY ${select}`,
        range.from,
        range.to,
      )) {
        const sums = entry(row);
        sums.runs = Number(row.runs);
        sums.runsWithEstimate = Number(row.with_estimate);
        sums.estimateUsd = Number(row.estimate_usd);
        sums.cacheReadTokens = Number(row.cache_read);
        sums.cacheCreationTokens = Number(row.cache_creation);
      }
    }
    return [...merged.values()];
  }

  /** Deletes ledger rows of UTC days older than `retentionDays`; audited when it deleted any. */
  async pruneCosts(
    retentionDays: number,
    now = Date.now(),
  ): Promise<{ requests: number; runs: number }> {
    return this.transaction(async () => {
      const before = utcDay(now - retentionDays * 86_400_000);
      const requests = await this.run('DELETE FROM provider_requests WHERE day < ?', before);
      const runs = await this.run('DELETE FROM cost_runs WHERE day < ?', before);
      if (requests > 0 || runs > 0) {
        await this.audit('system', 'costs.prune', 'costs', { before, requests, runs });
      }
      return { requests, runs };
    });
  }

  async recordFeedback(vote: AnswerVote): Promise<void> {
    await this.run(
      `INSERT INTO answer_feedback (run_id, user_id, team_id, channel_id, root_ts, answer_ts, vote, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, user_id) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`,
      vote.runId,
      vote.userId,
      vote.teamId,
      vote.channelId,
      vote.rootTs,
      vote.answerTs,
      vote.vote,
      Date.now(),
    );
  }

  async answerFeedback(limit = 50): Promise<AnswerFeedback[]> {
    const rows = await this.all(
      `SELECT channel_id, root_ts, answer_ts, run_id,
         SUM(CASE WHEN vote = 'up' THEN 1 ELSE 0 END) AS up,
         SUM(CASE WHEN vote = 'down' THEN 1 ELSE 0 END) AS down,
         MAX(updated_at) AS last
       FROM answer_feedback GROUP BY channel_id, root_ts, answer_ts, run_id
       ORDER BY last DESC LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      channelId: String(row.channel_id),
      rootTs: String(row.root_ts),
      answerTs: String(row.answer_ts),
      runId: String(row.run_id),
      up: Number(row.up),
      down: Number(row.down),
      lastAt: Number(row.last),
    }));
  }

  /** Upstream attempts grouped by the route and connection that executed each one. */
  async costRequestsForRun(runId: string) {
    const rows = await this.all(
      `SELECT route, model, connection, COUNT(*) AS n FROM provider_requests WHERE run_id = ?
       GROUP BY route, model, connection ORDER BY route, model, connection`,
      runId,
    );
    return rows.map((row) => ({
      route: row.route,
      model: row.model,
      connection: row.connection,
      requests: Number(row.n),
    }));
  }

  /** Ledger health for the page: last row received, row counts, instances seen. */
  async costLedgerStatus(): Promise<CostLedgerStatus> {
    const requests = await this.get(
      'SELECT COUNT(*) AS n, MAX(received_at) AS last, MIN(day) AS first FROM provider_requests',
    );
    const runs = await this.get(
      'SELECT COUNT(*) AS n, MAX(received_at) AS last, MIN(day) AS first FROM cost_runs',
    );
    const last = [requests?.last, runs?.last]
      .filter((value) => value !== null && value !== undefined)
      .map(Number);
    const first = [requests?.first, runs?.first]
      .filter((value) => value !== null && value !== undefined)
      .map(String)
      .sort();
    return {
      requestRows: Number(requests?.n ?? 0),
      runRows: Number(runs?.n ?? 0),
      lastReceivedAt: last.length === 0 ? null : Math.max(...last),
      firstDay: first[0] ?? null,
      instances: (
        await this.all(
          'SELECT instance FROM provider_requests UNION SELECT instance FROM cost_runs ORDER BY instance',
        )
      ).map((row) => String(row.instance)),
    };
  }

  // -- admin accounts, sessions, tokens ---------------------------------------

  async adminCount(): Promise<number> {
    return Number((await this.get('SELECT COUNT(*) AS n FROM admin_users'))?.n ?? 0);
  }

  async adminByName(name: string): Promise<AdminUser | null> {
    const row = await this.get('SELECT * FROM admin_users WHERE name = ?', name);
    return row === undefined ? null : adminFromRow(row);
  }

  async adminById(id: number): Promise<AdminUser | null> {
    const row = await this.get('SELECT * FROM admin_users WHERE id = ?', id);
    return row === undefined ? null : adminFromRow(row);
  }

  async listAdmins(): Promise<AdminUser[]> {
    return (await this.all('SELECT * FROM admin_users ORDER BY name')).map(adminFromRow);
  }

  async createAdmin(actor: string, name: string, passwordHash: string): Promise<void> {
    await this.transaction(async () => {
      if ((await this.adminByName(name)) !== null)
        throw new StoreError('an admin with that name exists', 409);
      const now = Date.now();
      await this.run(
        'INSERT INTO admin_users (name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
        name,
        passwordHash,
        now,
        now,
      );
      await this.audit(actor, 'admin.create', name);
    });
  }

  async setAdminPassword(actor: string, name: string, passwordHash: string): Promise<void> {
    await this.transaction(async () => {
      await this.run(
        'UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE name = ?',
        passwordHash,
        Date.now(),
        name,
      );
      await this.run(
        'DELETE FROM sessions WHERE user_id = (SELECT id FROM admin_users WHERE name = ?)',
        name,
      );
      const changed = await this.get('SELECT id FROM admin_users WHERE name = ?', name);
      if (changed !== undefined && changed !== null) this.revoked({ adminId: Number(changed.id) });
      await this.audit(actor, 'admin.password', name);
    });
  }

  async setAdminDisabled(actor: string, id: number, disabled: boolean): Promise<void> {
    await this.transaction(async () => {
      const admin = await this.adminById(id);
      if (admin === null) throw new StoreError('unknown admin', 404);
      await this.run(
        'UPDATE admin_users SET disabled = ?, updated_at = ? WHERE id = ?',
        disabled ? 1 : 0,
        Date.now(),
        id,
      );
      if (disabled) {
        await this.run('DELETE FROM sessions WHERE user_id = ?', id);
        this.revoked({ adminId: id });
      }
      await this.audit(actor, disabled ? 'admin.disable' : 'admin.enable', admin.name);
    });
  }

  async recentLoginFailures(name: string, sinceMs: number): Promise<number> {
    return Number(
      (
        await this.get(
          'SELECT COUNT(*) AS n FROM login_failures WHERE name = ? AND at >= ?',
          name,
          sinceMs,
        )
      )?.n ?? 0,
    );
  }

  /** Records a (provisional) failed attempt; returns its row ID. */
  async recordLoginFailure(name: string): Promise<number> {
    const now = Date.now();
    await this.run('DELETE FROM login_failures WHERE at < ?', now - 24 * 3_600_000);
    const result = await this.get(
      `INSERT INTO login_failures (name, at) VALUES (?, ?) RETURNING ${this.database.loginFailureId} AS id`,
      name,
      now,
    );
    return Number(result?.id);
  }

  /** Withdraws a provisional failure after a successful sign-in. */
  async clearLoginFailure(id: number): Promise<void> {
    await this.run(`DELETE FROM login_failures WHERE ${this.database.loginFailureId} = ?`, id);
  }

  async createSession(id: string, userId: number, csrf: string, expiresAt: number): Promise<void> {
    await this.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    await this.run(
      'INSERT INTO sessions (id, user_id, csrf, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      userId,
      csrf,
      expiresAt,
      Date.now(),
    );
  }

  async session(id: string): Promise<{ admin: AdminUser; csrf: string } | null> {
    const row = await this.get(
      `SELECT u.*, s.csrf FROM sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at >= ? AND u.disabled = 0`,
      id,
      Date.now(),
    );
    return row === undefined ? null : { admin: adminFromRow(row), csrf: String(row.csrf) };
  }

  async deleteSession(id: string): Promise<void> {
    await this.run('DELETE FROM sessions WHERE id = ?', id);
    this.revoked({ sessionId: id });
  }

  async createApiToken(actor: string, name: string, hash: string): Promise<void> {
    await this.transaction(async () => {
      await this.run(
        'INSERT INTO api_tokens (name, hash, created_by, updated_at) VALUES (?, ?, ?, ?)',
        name,
        hash,
        actor,
        Date.now(),
      );
      await this.audit(actor, 'token.create', name);
    });
  }

  async apiTokenByHash(hash: string): Promise<{ id: number; name: string } | null> {
    const row = await this.get('SELECT id, name FROM api_tokens WHERE hash = ?', hash);
    return row === undefined ? null : { id: Number(row.id), name: String(row.name) };
  }

  async listApiTokens(): Promise<
    Array<{ id: number; name: string; createdBy: string; createdAt: number }>
  > {
    return (await this.all('SELECT * FROM api_tokens ORDER BY id')).map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      createdBy: String(row.created_by),
      createdAt: Number(row.updated_at),
    }));
  }

  async deleteApiToken(actor: string, id: number): Promise<void> {
    await this.transaction(async () => {
      const row = await this.get('SELECT name FROM api_tokens WHERE id = ?', id);
      if (row === undefined) throw new StoreError('unknown token', 404);
      await this.run('DELETE FROM api_tokens WHERE id = ?', id);
      await this.audit(actor, 'token.delete', String(row.name));
    });
  }

  async saveOauthState(nonce: string, expiresAt: number): Promise<void> {
    await this.run('DELETE FROM oauth_states WHERE expires_at < ?', Date.now());
    await this.run(
      'INSERT INTO oauth_states (nonce, expires_at, updated_at) VALUES (?, ?, ?)',
      nonce,
      expiresAt,
      Date.now(),
    );
  }

  /** Single use: true once for a known, unexpired nonce. */
  async consumeOauthState(nonce: string): Promise<boolean> {
    const row = await this.get(
      'DELETE FROM oauth_states WHERE nonce = ? RETURNING expires_at',
      nonce,
    );
    return row !== undefined && Number(row.expires_at) >= Date.now();
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    return (await this.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', limit)).map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      actor: String(row.actor),
      action: String(row.action),
      target: String(row.target),
      detail: JSON.parse(String(row.detail_json)) as unknown,
      configVersion: row.config_version === null ? null : Number(row.config_version),
    }));
  }

  // -- secret encryption (bot tokens: AAD = team ID; tool credentials: AAD = instance ID)

  private encryptToken(aad: string, token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.storeKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
      .join(':');
  }

  private decryptToken(aad: string, stored: string): string {
    const [version, iv, tag, ciphertext] = stored.split(':');
    if (version !== 'v1' || iv === undefined || tag === undefined || ciphertext === undefined) {
      throw new StoreError('stored secret has an unknown format', 500);
    }
    const decipher = createDecipheriv('aes-256-gcm', this.storeKey, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/**
 * A new choice must be a valid key of the deployment allowlist (when one is
 * configured). Stored keys are never re-checked: a key the operator removes
 * later stays visible and falls back per run (D3).
 */
function checkModelKey(key: string | null, allowed: readonly string[] | null): void {
  if (key === null) return;
  if (!validModelKey(key)) {
    throw new StoreError('the model key must match ^[a-z][a-z0-9-]{0,23}$ and not be "default"');
  }
  if (allowed === null) {
    throw new StoreError('this deployment has no model allowlist (MODEL_CATALOG)', 409);
  }
  if (!allowed.includes(key)) {
    throw new StoreError(`unknown model ${key}; choose one of ${allowed.join(', ')}`);
  }
}

/** A prompt body value, normalized; a malformed one is a 400. */
function checkPrompt(value: unknown): string | null {
  try {
    return normalizeChannelPrompt(value);
  } catch (err) {
    if (err instanceof ChannelPromptError) throw new StoreError(err.message);
    throw err;
  }
}

function installationFromRow(row: Row): Installation {
  return {
    teamId: String(row.team_id),
    teamName: String(row.team_name),
    botUserId: String(row.bot_user_id),
    botId: String(row.bot_id),
    status: String(row.status) as Installation['status'],
    trustedBotSender:
      row.trusted_bot_sender_json === null
        ? null
        : (JSON.parse(String(row.trusted_bot_sender_json)) as TrustedBotSender),
    scopes: String(row.scopes),
    installedBy: String(row.installed_by),
    installedAt: row.installed_at === null ? null : Number(row.installed_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
    hasToken: row.bot_token_enc !== null,
  };
}

function channelFromRow(row: Row): Channel {
  return {
    teamId: String(row.team_id),
    channelId: String(row.channel_id),
    name: String(row.name),
    isPrivate: Number(row.is_private) === 1,
    enabled: Number(row.enabled) === 1,
    botMember: Number(row.bot_member) === 1,
  };
}

/**
 * Tool instances with their workspace's installation: a Slack instance's
 * credential is the workspace's bot token, so its presence and version come
 * from the installation (a reinstall rotates the token and bumps the version).
 */
const TOOL_INSTANCE_SELECT = `SELECT t.*, i.status AS ws_status, i.bot_token_enc AS ws_token_enc,
  i.installed_at AS ws_installed_at
  FROM tool_instances t LEFT JOIN installations i ON i.team_id = t.team_id`;

function toolInstanceFromRow(row: Row): ToolInstance {
  const kind = String(row.kind) as ToolKind;
  const slack = kind === 'slack';
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    kind,
    label: String(row.label),
    host: row.host === null ? null : String(row.host),
    settings: JSON.parse(String(row.settings_json)) as ToolSettings,
    hasCredential: slack
      ? row.ws_status === 'whitelisted' &&
        row.ws_token_enc !== null &&
        row.ws_token_enc !== undefined
      : row.credential_enc !== null,
    credentialVersion: slack
      ? row.ws_installed_at === null || row.ws_installed_at === undefined
        ? 0
        : Number(row.ws_installed_at)
      : Number(row.credential_ver),
    status: String(row.status) as ToolInstance['status'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toolStatusFromRow(row: Row): ToolStatus {
  return {
    instanceId: String(row.instance_id),
    state: String(row.state) as ToolInstanceState,
    detail: String(row.detail),
    toolsCount: row.tools_count === null ? null : Number(row.tools_count),
    credentialVersion: Number(row.credential_ver),
    reporter: String(row.reporter),
    reportedAt: Number(row.reported_at),
  };
}

/** Readiness details come from runtimes: printable text, bounded. */
export function sanitizeDetail(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- control characters are what is stripped
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .trim()
      .slice(0, MAX_STATUS_DETAIL_CHARS)
  );
}

function adminFromRow(row: Row): AdminUser {
  return {
    id: Number(row.id),
    name: String(row.name),
    passwordHash: String(row.password_hash),
    disabled: Number(row.disabled) === 1,
    createdAt: Number(row.created_at),
  };
}
