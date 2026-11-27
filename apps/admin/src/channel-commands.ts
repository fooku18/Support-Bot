/** Persistent command state lives beside configuration, outside runtime purge stores. */
import { createHash, randomUUID } from 'node:crypto';
import { AdminStore, StoreError } from './store.js';
import { TOOL_HELP_EXAMPLES, TOOL_KIND_TITLES } from './generated/tool-kinds.js';
import {
  evaluateAuthorization,
  parseAuthorizationPolicy,
} from './generated/authorization-policy.js';
import { normalizeChannelPrompt, ChannelPromptError } from './prompts.js';
import {
  CHANNEL_COMMAND_HELP,
  renderChannelMemory,
  classifyChannelCommand,
  type ChannelMemorySnapshot,
  type MemoryEntry,
  type CommandReceiptTable,
} from './generated/channel-commands.js';

type Row = Record<string, string | number | null>;
export interface CommandSource {
  teamId: string;
  channelId: string;
  userId: string;
  messageTs: string;
  threadTs?: string;
  eventId?: string;
  text: string;
}
export interface CommandOutcome {
  id: string;
  kind: 'receipt' | 'configure';
  grant?: string;
}
export interface SettingsDraft {
  session: string;
  model: string | null;
  prompt: string | null;
  /** "Automatic thread replies" (default on). */
  autoReplies: boolean;
  keys: readonly string[];
  workspaceModel: string | null;
  workspacePrompt: string | null;
}
export interface Receipt {
  id: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  body: string;
  table?: CommandReceiptTable;
  reconcile: boolean;
  lease: string;
  committedAt: number;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const slackTs = /^\d{10,16}\.\d{1,6}$/;
function required(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new StoreError(`Invalid ${name}`);
  return value;
}

export class ChannelCommands {
  constructor(
    private readonly store: AdminStore,
    private readonly models: () => readonly string[] | null,
    private readonly now = Date.now,
  ) {}
  private async get(sql: string, ...params: Array<string | number>): Promise<Row | undefined> {
    return (await this.store.get(sql, ...params)) as Row | undefined;
  }
  private async rows(sql: string, ...params: Array<string | number>): Promise<Row[]> {
    return (await this.store.all(sql, ...params)) as Row[];
  }
  async sessionChannel(session: string, team: string, actor: string): Promise<string | null> {
    const row = await this.get(
      'SELECT channel_id FROM channel_config_sessions WHERE id=? AND team_id=? AND actor=? AND expires_at>?',
      session,
      team,
      actor,
      Date.now(),
    );
    return row ? String(row.channel_id) : null;
  }
  private async authorize(team: string, channel: string, actor: string): Promise<number> {
    required(team, /^T[A-Z0-9]+$/, 'workspace');
    required(channel, /^[CG][A-Z0-9]+$/, 'channel');
    required(actor, /^[UW][A-Z0-9]+$/, 'actor');
    const installation = await this.store.installation(team);
    const document = await this.store.currentDocument();
    let allowed = false;
    if (document) {
      try {
        allowed = evaluateAuthorization(
          parseAuthorizationPolicy(JSON.stringify(document.authorizationPolicy)),
          {
            workspace: team,
            channel,
            user: actor,
            action: 'task.start',
          },
        ).allowed;
      } catch {
        /* An invalid persisted document never grants command access. */
      }
    }
    if (
      !installation ||
      installation.status !== 'whitelisted' ||
      !installation.hasToken ||
      !(await this.store.channel(team, channel))?.enabled ||
      !allowed ||
      installation.installedAt === null
    )
      throw new StoreError('You do not currently have access to channel commands.', 403);
    return installation.installedAt;
  }
  private async enabled(team: string, channel: string): Promise<boolean> {
    return (
      (await this.store.installation(team))?.status === 'whitelisted' &&
      (await this.store.channel(team, channel))?.enabled === true
    );
  }
  async snapshot(team: string, channel: string): Promise<ChannelMemorySnapshot> {
    return await this.store.transaction(async () => {
      if (!(await this.enabled(team, channel)))
        throw new StoreError('Channel memory is unavailable for this channel.', 403);
      return await this.readSnapshot(team, channel);
    });
  }
  private async readSnapshot(team: string, channel: string): Promise<ChannelMemorySnapshot> {
    const entries = (
      await this.rows(
        'SELECT entry_json FROM channel_memory WHERE team_id=? AND channel_id=? ORDER BY id',
        team,
        channel,
      )
    ).map((r) => JSON.parse(String(r.entry_json)) as MemoryEntry);
    const rendered = renderChannelMemory(entries);
    const revision = Number(
      (
        await this.get(
          'SELECT revision FROM channel_memory_state WHERE team_id=? AND channel_id=?',
          team,
          channel,
        )
      )?.revision ?? 0,
    );
    return { entries, revision, rendered, hash: hash(rendered) };
  }
  private async receipts(
    id: string,
    team: string,
    channel: string,
    thread: string,
    body: string,
  ): Promise<void> {
    const full = `Committed ${new Date(this.now()).toISOString()}\n${body}`;
    // Plain text blocks prevent note content from creating mentions, links or formatting.
    const points = Array.from(full);
    for (let offset = 0, part = 0; offset < points.length; part++) {
      let text = '';
      while (offset < points.length && text.length + points[offset]!.length <= 2800)
        text += points[offset++];
      await this.store.run(
        'INSERT INTO channel_command_receipts(id,team_id,channel_id,thread_ts,body,committed_at) VALUES(?,?,?,?,?,?)',
        `${id}:${part}`,
        team,
        channel,
        thread,
        text,
        this.now(),
      );
    }
  }
  private async listReceipts(
    id: string,
    team: string,
    channel: string,
    thread: string,
    snapshot: ChannelMemorySnapshot,
    page: number,
    pages: number,
  ): Promise<void> {
    const rows = snapshot.entries
      .slice((page - 1) * 10, page * 10)
      .map((entry): [string, string, string] => [
        `#${entry.id}`,
        entry.text,
        `${new Date(entry.lastConfirmedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC\n${Array.from(
          entry.editor,
        )
          .slice(0, 80)
          .join('')}`,
      ]);
    // Slack allows 10,000 characters across table cells. Keep headroom for headers,
    // never split a note, and persist each part's immutable presentation for retries.
    const parts: CommandReceiptTable[] = [];
    let current: CommandReceiptTable = { rows: [] };
    let chars = 0;
    for (const row of rows) {
      const size = row.reduce((sum, cell) => sum + cell.length, 0);
      if (chars + size > 8500 && current.rows.length) {
        parts.push(current);
        current = { rows: [] };
        chars = 0;
      }
      current.rows.push(row);
      chars += size;
    }
    if (current.rows.length || !parts.length) parts.push(current);
    for (const [part, table] of parts.entries()) {
      const receiptId = `${id}:${part}`;
      const body =
        `Channel memory · revision ${snapshot.revision} · page ${page}/${pages}` +
        (parts.length > 1 ? ` · part ${part + 1}/${parts.length}` : '') +
        `\nListed ${new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ')} UTC` +
        (rows.length ? '' : '\nNo saved notes.');
      await this.store.run(
        'INSERT INTO channel_command_receipts(id,team_id,channel_id,thread_ts,body,committed_at) VALUES(?,?,?,?,?,?)',
        receiptId,
        team,
        channel,
        thread,
        body,
        this.now(),
      );
      await this.store.run(
        'INSERT INTO channel_command_receipt_tables VALUES(?,?)',
        receiptId,
        JSON.stringify(table),
      );
    }
  }
  async execute(source: CommandSource): Promise<CommandOutcome> {
    return await this.store.transaction(async () => {
      const { teamId: team, channelId: channel, userId: actor } = source;
      const epoch = await this.authorize(team, channel, actor);
      required(source.messageTs, slackTs, 'message timestamp');
      const thread =
        source.threadTs === undefined
          ? source.messageTs
          : required(source.threadTs, slackTs, 'thread timestamp');
      if (typeof source.text !== 'string' || source.text.length > 16000)
        throw new StoreError('Invalid command text');
      const aliases = [`message:${channel}:${source.messageTs}`];
      if (source.eventId !== undefined)
        aliases.push(`event:${required(source.eventId, /^[A-Za-z0-9_-]{1,128}$/, 'event ID')}`);
      const existing = (
        await Promise.all(
          aliases.map((alias) =>
            this.get(
              'SELECT c.* FROM channel_command_aliases a JOIN channel_commands c ON c.id=a.command_id WHERE a.team_id=? AND a.alias=?',
              team,
              alias,
            ),
          ),
        )
      ).filter((r): r is Row => r !== undefined);
      if (existing.length) {
        const row = existing[0]!;
        if (
          existing.some((r) => r.id !== row.id) ||
          row.channel_id !== channel ||
          row.actor !== actor ||
          row.source_ts !== source.messageTs
        )
          throw new StoreError('Command identity conflict', 409);
        for (const alias of aliases)
          await this.store.run(
            'INSERT INTO channel_command_aliases VALUES(?,?,?) ON CONFLICT (team_id, alias) DO NOTHING',
            team,
            alias,
            String(row.id),
          );
        return JSON.parse(String(row.outcome_json)) as CommandOutcome;
      }
      if (Number(source.messageTs) * 1000 < epoch)
        throw new StoreError(
          'This command predates the current installation; send a new command.',
          409,
        );
      const command = classifyChannelCommand(
        source.text,
        (await this.store.installation(team))!.botUserId,
      );
      if (command === null) throw new StoreError('Not a channel command');
      const id = randomUUID();
      let outcome: CommandOutcome = { id, kind: 'receipt' };
      let receipt = CHANNEL_COMMAND_HELP;
      if (command.kind === 'configure') {
        const grant = randomUUID();
        await this.store.run(
          'INSERT INTO channel_config_grants VALUES(?,?,?,?,?,?,?)',
          grant,
          team,
          channel,
          actor,
          thread,
          epoch,
          this.now() + 15 * 60000,
        );
        outcome = { id, kind: 'configure', grant };
      } else if (command.kind === 'capabilities') {
        const assignment = (await this.store.currentDocument())?.toolAssignments.find(
          (a) => a.teamId === team && a.channelId === channel,
        );
        const kinds = [
          ...new Set(assignment?.tools.filter((tool) => tool.ready).map((t) => t.kind)),
        ];
        const examples = [
          ...kinds.map((kind) => TOOL_HELP_EXAMPLES[kind]),
          'What did we decide in this thread?',
          'Can you chart these numbers?',
        ].slice(0, 3);
        receipt = [
          'I can summarize this thread and make charts from numbers you share.',
          ...(kinds.length
            ? [`Tools assigned here: ${kinds.map((k) => TOOL_KIND_TITLES[k]).join(', ')}.`]
            : []),
          ...examples.map((q) => `• ${q}`),
        ].join('\n');
      } else if (command.kind !== 'help' && command.kind !== 'invalid') {
        const before = await this.readSnapshot(team, channel);
        if (command.kind === 'list') {
          const pages = Math.max(1, Math.ceil(before.entries.length / 10));
          receipt = `Memory has ${pages} page(s). ${CHANNEL_COMMAND_HELP}`;
          if (command.page <= pages) {
            await this.listReceipts(id, team, channel, thread, before, command.page, pages);
            receipt = '';
          }
        } else {
          // Validation failures become durable public command outcomes, without partial mutation.
          receipt = await this.changeMemory(source, command, before);
        }
      }
      await this.store.run(
        'INSERT INTO channel_commands VALUES(?,?,?,?,?,?,?,?)',
        id,
        team,
        channel,
        actor,
        source.messageTs,
        thread,
        JSON.stringify(outcome),
        this.now(),
      );
      for (const alias of aliases)
        await this.store.run('INSERT INTO channel_command_aliases VALUES(?,?,?)', team, alias, id);
      if (outcome.kind === 'receipt' && receipt)
        await this.receipts(id, team, channel, thread, receipt);
      return outcome;
    });
  }
  private async changeMemory(
    source: CommandSource,
    command: Extract<
      NonNullable<ReturnType<typeof classifyChannelCommand>>,
      { kind: 'remember' | 'replace' | 'delete' }
    >,
    before: ChannelMemorySnapshot,
  ): Promise<string> {
    const { teamId: team, channelId: channel, userId: actor } = source;
    const entries = [...before.entries];
    const old = command.kind === 'remember' ? undefined : entries.find((e) => e.id === command.id);
    if (command.kind !== 'remember' && !old) return `No active note #${command.id}.`;
    if (command.kind === 'replace' && old!.text === command.text)
      return `Note #${command.id} unchanged (revision ${before.revision}).`;
    if (command.kind !== 'delete') {
      // Literal means no trimming/normalization of accepted text.
      if (
        !command.text.trim() ||
        command.text.length > 1000 ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(command.text) ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(command.text)
      )
        return 'A note must contain 1–1,000 UTF-16 units and no control characters except tab/newline.';
    }
    const nextId = Number(
      (
        await this.get(
          'SELECT next_id FROM channel_memory_state WHERE team_id=? AND channel_id=?',
          team,
          channel,
        )
      )?.next_id ?? 1,
    );
    const id = command.kind === 'remember' ? nextId : command.id;
    const now = this.now();
    const entry: MemoryEntry | undefined =
      command.kind === 'delete'
        ? undefined
        : {
            id,
            text: command.text,
            creator: old?.creator ?? actor,
            editor: actor,
            channelId: channel,
            threadTs: source.threadTs ?? source.messageTs,
            messageTs: source.messageTs,
            createdAt: old?.createdAt ?? now,
            lastConfirmedAt: now,
          };
    const candidate = entries.filter((e) => e.id !== id);
    if (entry) candidate.push(entry);
    const rendered = JSON.stringify(
      candidate.map((e) => ({
        id: e.id,
        text: e.text,
        channelId: e.channelId,
        threadTs: e.threadTs,
        messageTs: e.messageTs,
      })),
    );
    if (
      candidate.length > 50 ||
      candidate.reduce((n, e) => n + e.text.length, 0) > 12000 ||
      rendered.length > 24000
    )
      return 'Memory limit exceeded: 50 notes, 12,000 raw units, 24,000 rendered units. Delete or shorten a note explicitly.';
    await this.store.run(
      'INSERT INTO channel_memory_state(team_id,channel_id) VALUES(?,?) ON CONFLICT (team_id, channel_id) DO NOTHING',
      team,
      channel,
    );
    await this.store.run(
      'UPDATE channel_memory_state SET revision=revision+1,next_id=? WHERE team_id=? AND channel_id=?',
      command.kind === 'remember' ? nextId + 1 : nextId,
      team,
      channel,
    );
    if (entry)
      await this.store.run(
        'INSERT INTO channel_memory VALUES(?,?,?,?) ON CONFLICT(team_id,channel_id,id) DO UPDATE SET entry_json=excluded.entry_json',
        team,
        channel,
        id,
        JSON.stringify(entry),
      );
    else
      await this.store.run(
        'DELETE FROM channel_memory WHERE team_id=? AND channel_id=? AND id=?',
        team,
        channel,
        id,
      );
    await this.store.audit(
      `slack:${team}/${actor}`,
      `memory.${command.kind}`,
      `${team}/${channel}/${id}`,
      {
        chars: entry?.text.length ?? 0,
        hash: entry ? hash(entry.text) : null,
        revision: before.revision + 1,
      },
    );
    return `${actor} ${command.kind === 'delete' ? 'deleted' : command.kind === 'replace' ? 'replaced' : 'saved'} note #${id} (revision ${before.revision + 1}).${entry ? '\n' + entry.text : ' Deletion does not remove Slack history, earlier run evidence or backups.'}`;
  }
  async open(
    grantId: string,
    team: string,
    channel: string,
    actor: string,
  ): Promise<SettingsDraft> {
    return await this.store.transaction(async () => {
      const epoch = await this.authorize(team, channel, actor);
      const grant = await this.get('SELECT * FROM channel_config_grants WHERE id=?', grantId);
      if (
        !grant ||
        grant.team_id !== team ||
        grant.channel_id !== channel ||
        grant.actor !== actor ||
        grant.epoch !== epoch ||
        Number(grant.expires_at) <= this.now()
      )
        throw new StoreError(
          'Configure entry expired or belongs to another requester; send !config.',
          403,
        );
      const settings = await this.store.channelSettings(team, channel);
      const session = randomUUID();
      await this.store.run(
        'INSERT INTO channel_config_sessions(id,team_id,channel_id,actor,thread_ts,epoch,expires_at,fingerprint) VALUES(?,?,?,?,?,?,?,?)',
        session,
        team,
        channel,
        actor,
        String(grant.thread_ts),
        epoch,
        this.now() + 60 * 60000,
        settings.fingerprint,
      );
      return {
        session,
        model: settings.model,
        prompt: settings.prompt,
        autoReplies: settings.autoReplies,
        keys: this.models() ?? [],
        workspaceModel: await this.store.modelAssignment(team, null),
        workspacePrompt: await this.store.promptAssignment(team, null),
      };
    });
  }
  async save(
    sessionId: string,
    team: string,
    actor: string,
    input: { model: unknown; part1: unknown; part2: unknown; autoReplies: unknown },
    deadline: number,
  ): Promise<{ changed: boolean; configVersion: number }> {
    return await this.store.transaction(async () => {
      const session = await this.get('SELECT * FROM channel_config_sessions WHERE id=?', sessionId);
      if (!session || session.team_id !== team || session.actor !== actor)
        throw new StoreError('Invalid configuration form.', 403);
      const channel = String(session.channel_id);
      const epoch = await this.authorize(team, channel, actor);
      if (session.epoch !== epoch || Number(session.expires_at) <= this.now())
        throw new StoreError('Configuration form expired; reopen.', 409);
      if (input.model !== null && typeof input.model !== 'string')
        throw new StoreError('Choose a model or Inherit.');
      if (
        typeof input.part1 !== 'string' ||
        typeof input.part2 !== 'string' ||
        input.part1.length > 3000 ||
        input.part2.length > 3000
      )
        throw new StoreError('Each prompt part must be at most 3,000 units.');
      let prompt: string | null;
      try {
        prompt = normalizeChannelPrompt(input.part1 + input.part2);
      } catch (error) {
        if (error instanceof ChannelPromptError) throw new StoreError(error.message);
        throw error;
      }
      if (typeof input.autoReplies !== 'boolean')
        throw new StoreError('Automatic thread replies must be on or off.');
      const autoReplies = input.autoReplies;
      const payloadHash = hash(JSON.stringify([input.model, prompt, autoReplies]));
      if (session.result_json !== null) {
        if (session.payload_hash !== payloadHash)
          throw new StoreError('This form already saved; reopen for another edit.', 409);
        return JSON.parse(String(session.result_json)) as {
          changed: boolean;
          configVersion: number;
        };
      }
      if (!Number.isFinite(deadline) || deadline <= this.now())
        throw new StoreError(
          'Save deadline expired; outcome unknown. Check the public receipt or retry this form.',
          503,
        );
      const result = await this.store.setChannelSettings(
        `slack:${team}/${actor}`,
        team,
        channel,
        session.fingerprint,
        { model: input.model as string | null, prompt, autoReplies },
        this.models(),
      );
      const outcome = { changed: result.changed, configVersion: result.document.version };
      await this.store.run(
        'UPDATE channel_config_sessions SET payload_hash=?,result_json=? WHERE id=?',
        payloadHash,
        JSON.stringify(outcome),
        sessionId,
      );
      if (result.changed)
        await this.receipts(
          sessionId,
          team,
          channel,
          String(session.thread_ts),
          `${actor} saved channel settings.\nModel: ${input.model ?? `Inherit (${(await this.store.modelAssignment(team, null)) ?? 'deployment default'})`}\nAutomatic thread replies: ${(await this.store.autoReplies(team, channel)) ? 'On' : 'Off'}\nPrompt: ${prompt === null ? 'Inherit' : `Override\n${prompt}`}`,
        );
      if (deadline <= this.now())
        throw new StoreError('Save deadline expired; retry this form.', 503);
      return outcome;
    });
  }
  async claimReceipt(): Promise<Receipt | null> {
    return await this.store.transaction(async () => {
      const row = await this.get(
        `SELECT r.* FROM channel_command_receipts r JOIN installations i ON i.team_id=r.team_id JOIN channels c ON c.team_id=r.team_id AND c.channel_id=r.channel_id WHERE i.status='whitelisted' AND c.enabled=1 AND r.state IN ('pending','posting','uncertain') AND r.lease_until<=? ORDER BY r.committed_at,r.id LIMIT 1`,
        this.now(),
      );
      if (!row) return null;
      const lease = randomUUID();
      await this.store.run(
        "UPDATE channel_command_receipts SET state='posting',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?",
        lease,
        this.now() + 60000,
        String(row.id),
      );
      const presentation = await this.get(
        'SELECT table_json FROM channel_command_receipt_tables WHERE receipt_id=?',
        String(row.id),
      );
      return {
        ...(presentation
          ? { table: JSON.parse(String(presentation.table_json)) as CommandReceiptTable }
          : {}),
        id: String(row.id),
        teamId: String(row.team_id),
        channelId: String(row.channel_id),
        threadTs: String(row.thread_ts),
        body: String(row.body),
        reconcile: row.state !== 'pending',
        lease,
        committedAt: Number(row.committed_at),
      };
    });
  }
  async authorizeReceipt(id: string, lease: string): Promise<{ ok: boolean }> {
    return await this.store.transaction(async () => {
      const row = await this.get(
        `SELECT * FROM channel_command_receipts WHERE id=? AND lease=? AND lease_until>? AND state='posting'`,
        id,
        lease,
        this.now(),
      );
      if (!row || !(await this.enabled(String(row.team_id), String(row.channel_id))))
        return { ok: false };
      // Renew only while still owned and enabled, immediately before each network operation.
      await this.store.run(
        'UPDATE channel_command_receipts SET lease_until=? WHERE id=? AND lease=?',
        this.now() + 60000,
        id,
        lease,
      );
      return { ok: true };
    });
  }
  async reportReceipt(
    id: string,
    lease: string,
    state: 'delivered' | 'uncertain' | 'failed',
    ts?: string,
    retryAfterMs = 30000,
  ): Promise<void> {
    await this.store.transaction(async () => {
      const row = await this.get(
        'SELECT * FROM channel_command_receipts WHERE id=? AND lease=? AND lease_until>?',
        id,
        lease,
        this.now(),
      );
      if (!row) throw new StoreError('Receipt lease expired', 409);
      if (!['delivered', 'uncertain', 'failed'].includes(state))
        throw new StoreError('Invalid receipt outcome');
      if (state === 'delivered') {
        required(ts, slackTs, 'receipt timestamp');
        await this.store.run('DELETE FROM channel_command_receipt_tables WHERE receipt_id=?', id);
      }
      await this.store.run(
        "UPDATE channel_command_receipts SET state=?,slack_ts=?,body=CASE WHEN ?='delivered' THEN NULL ELSE body END,lease=NULL,lease_until=?,last_error=? WHERE id=?",
        state,
        ts ?? null,
        state,
        this.now() + Math.max(30000, Number.isFinite(retryAfterMs) ? retryAfterMs : 30000),
        state === 'delivered' ? null : state,
        id,
      );
    });
  }
}
