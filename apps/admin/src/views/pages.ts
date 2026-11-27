/** Application settings pages. Each returns a complete HTML document. */

import { isLegacyWebSearch, LEGACY_WEB_SEARCH_DETAIL, type CompiledDocument } from '../compile.js';
import {
  costPresets,
  utcDay,
  type CostAggregate,
  type CostGroup,
  type CostRow,
  type CostsView,
} from '../costs.js';
import type { Listing, SlackChannel, SlackUser } from '../slack.js';
import type {
  AdminUser,
  AuditEntry,
  Channel,
  ChannelTool,
  BlockedMember,
  Installation,
  ToolInstance,
  ToolStatus,
} from '../store.js';
import {
  ATLASSIAN_READ_OPERATIONS,
  CREDENTIAL_KINDS,
  kindNeedsProbe,
  TOOL_KIND_TITLES,
  TOOL_KINDS,
  type AtlassianSettings,
  type ChannelToolAssignment,
  type CloudflareSettings,
  type DatadogSettings,
  type FilesSettings,
  type ToolKind,
} from '../generated/tool-kinds.js';
import {
  confirmButton,
  count,
  csrfField,
  html,
  icon,
  iconAttrs,
  initials,
  lamp,
  page,
  postButton,
  raw,
  sparkline,
  time,
  type IconName,
  type PageContext,
  type PageOptions,
  type Raw,
} from './html.js';

const DAY_MS = 86_400_000;

export function loginPage(context: PageContext, bootstrap: boolean): string {
  return page(
    'Sign in',
    context,
    html`<form class="card" method="post" action="/login">
        <div class="card-b stack">
          <label class="field"
            >Name <input name="name" autocomplete="username" required autofocus
          /></label>
          <label class="field"
            >Password
            <input name="password" type="password" autocomplete="current-password" required
          /></label>
          <div><button type="submit">${icon('login')}Sign in</button></div>
        </div>
      </form>
      ${bootstrap
        ? html`<p class="muted small">
            No admin exists yet. Create the first one inside the container:
            <code>node dist/cli.js create-admin &lt;name&gt;</code>
          </p>`
        : html``}`,
    { narrow: true },
  );
}

export function messagePage(title: string, context: PageContext, text: string): string {
  return page(
    title,
    context,
    html`<div class="card">
      <div class="card-b">
        <p>${text}</p>
        <p><a href="/workspaces">Back to workspaces</a></p>
      </div>
    </div>`,
    { narrow: true },
  );
}

/** The display name of a workspace (its team ID until Slack named it). */
function teamName(row: Installation): string {
  return row.teamName || row.teamId;
}

function workspaceLamp(row: Installation, detail = true): Raw {
  if (!row.hasToken) {
    return lamp(
      'off',
      'Not paired',
      detail ? 'No bot token: add the bot to this workspace with Add to Slack.' : undefined,
    );
  }
  if (row.status === 'whitelisted') return lamp('live', 'Whitelisted');
  if (row.status === 'disabled')
    return lamp('idle', 'Disabled', detail ? 'The bot ignores this workspace.' : undefined);
  return lamp(
    'wait',
    'Pending',
    detail ? 'The bot tells people it is not enabled here yet.' : undefined,
  );
}

/** The workspace pages share a header: name, status and the two tabs. */
function workspaceOptions(
  installation: Installation,
  current: 'channels' | 'tools',
  windowTitle: string,
): PageOptions {
  const base = `/workspaces/${installation.teamId}`;
  return {
    section: 'workspaces',
    windowTitle,
    workspace: { installation, page: current },
    crumbs: [['Workspaces', '/workspaces']],
    badge: workspaceLamp(installation, false),
    sub: html`<span class="id">${installation.teamId}</span>`,
    tabs: [
      ['Channels', `${base}/channels`, current === 'channels'],
      ['Tools, model and prompt', `${base}/tools`, current === 'tools'],
    ],
  };
}

function workspaceRow(row: Installation, actions: Raw): Raw {
  const name = teamName(row);
  return html`<div class="row">
    <span class="row-ic">${initials(name)}</span>
    <div class="row-main">
      <div class="row-title">
        ${row.hasToken
          ? html`<a href="/workspaces/${row.teamId}/channels">${name}</a>`
          : html`<span>${name}</span>`}
      </div>
      <div class="row-meta">
        <span class="id">${row.teamId}</span>
        ${row.hasToken ? html`<span class="id">Bot ${row.botUserId} ${row.botId}</span>` : ''}
        <span
          >Added ${time(row.installedAt)}${row.installedBy ? ` by ${row.installedBy}` : ''}</span
        >
        <span>Last event ${time(row.lastSeenAt)}</span>
      </div>
    </div>
    <div class="row-side">${workspaceLamp(row)}</div>
    <div class="row-actions">${actions}</div>
  </div>`;
}

export function workspacesPage(
  context: PageContext,
  installations: Installation[],
  document: CompiledDocument,
): string {
  const rows = installations.map((row) =>
    workspaceRow(
      row,
      html`${row.hasToken
        ? html`<a href="/workspaces/${row.teamId}/tools" ${iconAttrs('Tools')}>${icon('tools')}</a>`
        : html``}
      ${row.status !== 'whitelisted' && row.hasToken
        ? postButton(
            `/workspaces/${row.teamId}/status`,
            'Whitelist',
            context.csrf,
            { status: 'whitelisted' },
            'primary',
            { icon: 'check', iconOnly: true, tone: 'go' },
          )
        : html``}
      ${row.status === 'whitelisted'
        ? postButton(
            `/workspaces/${row.teamId}/status`,
            'Disable',
            context.csrf,
            { status: 'disabled' },
            'quiet',
            { icon: 'disable', iconOnly: true, tone: 'stop' },
          )
        : html``}
      ${confirmButton(
        `/workspaces/${row.teamId}/delete`,
        'Remove',
        'Deletes the bot token and every channel and person of this workspace. Adding it again starts from scratch.',
        context.csrf,
      )}`,
    ),
  );
  const senders = installations
    .filter((row) => row.hasToken)
    .map(
      (row) =>
        html`<details class="disclose" ${row.trustedBotSender === null ? '' : 'open'}>
          <summary>
            ${icon('chevron')}${teamName(row)}:
            ${row.trustedBotSender === null ? 'no test sender' : row.trustedBotSender.botId}
          </summary>
          <form class="fields" method="post" action="/workspaces/${row.teamId}/trusted-sender">
            ${csrfField(context.csrf)}
            <label class="field"
              >Bot ID <input name="botId" value="${row.trustedBotSender?.botId ?? ''}"
            /></label>
            <label class="field"
              >User ID <input name="userId" value="${row.trustedBotSender?.userId ?? ''}"
            /></label>
            <label class="field"
              >Channel ID <input name="channelId" value="${row.trustedBotSender?.channelId ?? ''}"
            /></label>
            <button type="submit" class="quiet">${icon('save')}Save test sender</button>
          </form>
        </details>`,
    );
  return page(
    'Workspaces',
    context,
    html`<p class="lead">
        A newly added workspace stays pending until you whitelist it. Open a workspace to choose its
        channels.
      </p>
      <div class="list">
        ${rows.length > 0
          ? rows
          : html`<p class="empty">
              No workspace yet. Use Add to Slack to install the bot, then whitelist it here.
            </p>`}
      </div>
      ${senders.length === 0
        ? ''
        : html`<section class="card">
            <div class="card-h">
              <h2>${icon('bot')}Test senders</h2>
              <p>
                Lets one bot (the live-test harness) talk to the agent as if it were a person, in
                one channel only. Leave all three empty in production.
              </p>
            </div>
            <div class="card-b">${senders}</div>
          </section>`}
      <p class="muted small">
        The agent enforces configuration version ${document.version}.
        <a href="/config">See what it contains</a>.
      </p>`,
    {
      section: 'workspaces',
      actions: html`<a class="button" href="/slack/install">${icon('plus')}Add to Slack</a>`,
    },
  );
}

/** Whether the bot answers in a channel, and if not, the first thing to fix. */
function channelLamp(
  workspaceLive: boolean,
  enabled: boolean,
  botMember: boolean,
  blockedCount: number,
): Raw {
  if (!enabled) {
    return botMember
      ? lamp('idle', 'Off')
      : lamp('idle', 'Off', html`Invite the bot first: <code>/invite</code> in the channel.`);
  }
  if (!botMember) {
    return lamp('off', 'Bot not in channel', html`Invite it again with <code>/invite</code>.`);
  }
  if (!workspaceLive) return lamp('wait', 'Waiting for workspace', 'Whitelist the workspace.');
  return lamp('live', 'Answering', `${blockedCount} blocked; other channel members have access`);
}

/**
 * How old a cached Slack listing is, with a refresh link; a failed refresh
 * names the error and whether an older listing is still shown.
 */
function listingNotice(listing: Listing<unknown>, what: string, fallback: string): Raw {
  const refresh = html`<a href="?refresh=1">Refresh from Slack</a>`;
  if (listing.error !== null) {
    return html`<div class="notice err">
      <div>
        Slack did not list ${what} (${listing.error}).
        ${listing.rows === null ? fallback : `Showing the list from ${time(listing.fetchedAt)}.`}
        ${refresh}
      </div>
    </div>`;
  }
  return listing.fetchedAt === null
    ? html``
    : html`<p class="muted small">Slack list from ${time(listing.fetchedAt)}. ${refresh}</p>`;
}

export function channelsPage(
  context: PageContext,
  installation: Installation,
  stored: Channel[],
  live: Listing<SlackChannel>,
  blockedCounts: ReadonlyMap<string, number>,
): string {
  const storedById = new Map(stored.map((row) => [row.channelId, row]));
  const ids = new Set([
    ...(live.rows ?? []).map((row) => row.id),
    ...stored.map((row) => row.channelId),
  ]);
  // The listing holds exactly the bot's channels; without one, the saved state stands.
  const liveById = live.rows === null ? null : new Map(live.rows.map((row) => [row.id, row]));
  const workspaceLive = installation.status === 'whitelisted';
  const base = `/workspaces/${installation.teamId}/channels`;
  const channels = [...ids].map((id) => {
    const current = storedById.get(id);
    const slack = liveById?.get(id);
    return {
      id,
      current,
      name: slack?.name ?? current?.name ?? id,
      isPrivate: slack?.isPrivate ?? current?.isPrivate ?? false,
      botMember: liveById === null ? (current?.botMember ?? false) : slack !== undefined,
      enabled: current?.enabled ?? false,
      blockedCount: blockedCounts.get(id) ?? 0,
    };
  });
  // Enabled channels first, then channels the bot is in, then by name.
  channels.sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      Number(b.botMember) - Number(a.botMember) ||
      a.name.localeCompare(b.name),
  );
  const rows = channels.map(
    (row) =>
      html`<div class="row">
        <span class="row-ic">${icon(row.isPrivate ? 'lock' : 'channels')}</span>
        <div class="row-main">
          <div class="row-title">
            ${row.current !== undefined
              ? html`<a href="${base}/${row.id}/blocked-members">#${row.name}</a>`
              : html`<span>#${row.name}</span>`}
          </div>
          <div class="row-meta">
            <span>${row.isPrivate ? 'Private' : 'Public'}</span><span class="id">${row.id}</span>
          </div>
        </div>
        <div class="row-side">
          ${channelLamp(workspaceLive, row.enabled, row.botMember, row.blockedCount)}
        </div>
        <div class="row-actions">
          ${row.enabled
            ? postButton(
                `${base}/${row.id}`,
                'Disable',
                context.csrf,
                { enabled: 'false' },
                'quiet',
                { icon: 'disable', iconOnly: true, tone: 'stop' },
              )
            : row.botMember
              ? postButton(
                  `${base}/${row.id}`,
                  'Enable',
                  context.csrf,
                  { enabled: 'true' },
                  'primary',
                  { icon: 'enable', iconOnly: true, tone: 'go' },
                )
              : html``}
          ${row.current !== undefined
            ? html`<a
                  href="${base}/${row.id}/blocked-members"
                  ${iconAttrs(`Blocked members (${row.blockedCount})`)}
                  >${icon('users')}<span class="count ${row.blockedCount === 0 ? 'zero' : ''}"
                    >${row.blockedCount}</span
                  ></a
                >
                <a href="${base}/${row.id}/tools" ${iconAttrs('Tools')}>${icon('tools')}</a>`
            : html``}
        </div>
      </div>`,
  );
  return page(
    teamName(installation),
    context,
    html`${workspaceLive
        ? html``
        : html`<div class="notice wait">
            <div>
              This workspace is ${installation.status}. No channel answers until it is whitelisted
              on <a href="/workspaces">Workspaces</a>.
            </div>
          </div>`}
      ${listingNotice(live, 'the channels', 'Only channels saved earlier are shown.')}
      <p class="lead">
        Channels appear here once the bot is invited to them with <code>/invite</code>. The bot
        answers in a channel once it is invited there, the channel is enabled, and at least one
        channel member is not blocked. Tools are configured per workspace on
        <a href="/workspaces/${installation.teamId}/tools">Tools</a> and assigned per channel.
      </p>
      <div class="list">
        ${rows.length > 0
          ? rows
          : html`<p class="empty">
              The bot sees no channels. Invite it to one with <code>/invite</code>, then reload.
            </p>`}
      </div>`,
    workspaceOptions(installation, 'channels', `Channels of ${teamName(installation)}`),
  );
}

/** The channel pages share a header: name, privacy and the two tabs. */
function channelOptions(
  installation: Installation,
  channel: Channel,
  current: 'access' | 'tools',
  windowTitle: string,
): PageOptions {
  const channelsPath = `/workspaces/${installation.teamId}/channels`;
  const base = `${channelsPath}/${channel.channelId}`;
  return {
    section: 'workspaces',
    windowTitle,
    workspace: { installation, page: null },
    crumbs: [
      ['Workspaces', '/workspaces'],
      [teamName(installation), channelsPath],
    ],
    badge: channel.enabled ? lamp('live', 'Enabled') : lamp('idle', 'Off'),
    sub: html`<span>${channel.isPrivate ? 'Private' : 'Public'}</span
      ><span class="id">${channel.channelId}</span>`,
    tabs: [
      ['Access', `${base}/blocked-members`, current === 'access'],
      ['Tools and model', `${base}/tools`, current === 'tools'],
    ],
  };
}

/**
 * The line from a workspace to the people in a channel. The bot answers
 * only when every link holds; the first broken one is where to act.
 */
function circuit(
  installation: Installation,
  channel: Channel,
  blockedMembers: BlockedMember[],
): Raw {
  const workspace = teamName(installation);
  const links: Array<{ ok: boolean; title: string; okText: string; fix: Raw | string }> = [
    {
      ok: installation.status === 'whitelisted',
      title: 'Workspace whitelisted',
      okText: `${workspace} is whitelisted.`,
      fix: html`${workspace} is ${installation.status}. <a href="/workspaces">Whitelist it</a>.`,
    },
    {
      ok: channel.botMember,
      title: 'Bot in channel',
      okText: 'The bot was invited.',
      fix: html`Invite it with <code>/invite</code> in the channel.`,
    },
    {
      ok: channel.enabled,
      title: 'Channel enabled',
      okText: 'Mentions here are handled.',
      fix: html`<a href="/workspaces/${installation.teamId}/channels">Enable it</a>.`,
    },
    {
      ok: true,
      title: 'Member access',
      okText: `${blockedMembers.length} blocked. All other channel members have access.`,
      fix: 'Review blocked members below.',
    },
  ];
  const firstBroken = links.findIndex((link) => !link.ok);
  return html`<section class="card">
    <div class="card-h">
      <h2>${icon('activity')}Readiness</h2>
      ${firstBroken === -1
        ? lamp('live', 'The bot answers unblocked members in this channel.')
        : lamp('off', 'The bot does not answer here yet.')}
    </div>
    <div class="card-b">
      <ol class="circuit" aria-label="What the bot needs to answer here">
        ${links.map(
          (link, index) =>
            html`<li
              class="step ${link.ok ? 'yes' : 'no'} ${index === firstBroken ? 'broken' : ''}"
            >
              <span class="jack" aria-hidden="true"
                >${icon(link.ok ? 'check' : index === firstBroken ? 'x' : 'dashed')}</span
              >
              <div>
                <strong>${link.title}${link.ok ? '' : ': no'}</strong>
                <span class="sub">${link.ok ? link.okText : link.fix}</span>
              </div>
            </li>`,
        )}
      </ol>
    </div>
  </section>`;
}

export function blockedMembersPage(
  context: PageContext,
  installation: Installation,
  channel: Channel,
  blockedMembers: BlockedMember[],
  users: Listing<SlackUser>,
): string {
  const channelPath = `/workspaces/${installation.teamId}/channels/${channel.channelId}`;
  const base = `${channelPath}/blocked-members`;
  const listed = new Set(blockedMembers.map((row) => row.userId));
  const rows = blockedMembers.map(
    (row) =>
      html`<div class="row">
        <span class="row-ic">${initials(row.displayName || row.userId)}</span>
        <div class="row-main">
          <div class="row-title">${row.displayName || row.userId}</div>
          <div class="row-meta"><span class="id">${row.userId}</span></div>
        </div>
        <div class="row-side">
          ${postButton(`${base}/${row.userId}/unblock`, 'Unblock', context.csrf, {}, 'quiet', {
            icon: 'userMinus',
            iconOnly: true,
          })}
        </div>
      </div>`,
  );
  // Both workspace and Enterprise Grid user IDs are supported.
  const candidates = (users.rows ?? []).filter(
    (user) => !listed.has(user.id) && /^[UW][A-Z0-9]+$/.test(user.id),
  );
  const name = `#${channel.name || channel.channelId}`;
  return page(
    name,
    context,
    html`${circuit(installation, channel, blockedMembers)}
      <section class="card">
        <div class="card-h">
          <h2>${icon('users')}Blocked members</h2>
          <span class="badge">${blockedMembers.length}</span>
          <p>
            All unblocked channel members, including guests and external participants, can use
            commands, shared memory and every tool assigned to this channel (<a
              href="${channelPath}/tools"
              >Tools</a
            >).
          </p>
        </div>
        <div class="list">
          ${rows.length > 0
            ? rows
            : html`<p class="empty">Nobody is blocked. All channel members have access.</p>`}
        </div>
      </section>
      <form class="card" method="post" action="${base}">
        <div class="card-h"><h2>${icon('userPlus')}Block a member</h2></div>
        <div class="card-b">
          ${listingNotice(users, "the workspace's people", 'Enter a user ID instead.')}
          <div class="fields">
            ${csrfField(context.csrf)}
            <label class="field"
              >Person
              <input
                name="userId"
                list="block-candidates"
                placeholder="U… or W…"
                pattern="[UW][A-Z0-9]+"
                required
              />
              <datalist id="block-candidates">
                ${candidates.map(
                  (user) => html`<option value="${user.id}">${user.name} (${user.id})</option>`,
                )}
              </datalist></label
            >
            <button type="submit">${icon('userPlus')}Block member</button>
          </div>
        </div>
      </form>`,
    channelOptions(installation, channel, 'access', name),
  );
}

// -- tools ----------------------------------------------------------------------

const KIND_ICONS: Record<ToolKind, IconName> = {
  gitlab: 'tools',
  atlassian: 'audit',
  datadog: 'activity',
  cloudflare: 'shield',
  slack: 'logo',
  webSearch: 'search',
  webFetch: 'download',
  codeMode: 'zap',
  files: 'audit',
  localExec: 'prompt',
};

/** Readiness of an instance in words, as the runtimes last reported it. */
function toolLamp(instance: ToolInstance, status: ToolStatus | undefined): Raw {
  if (instance.status !== 'enabled') return lamp('idle', 'Disabled');
  if (isLegacyWebSearch(instance)) return lamp('off', 'Not ready', LEGACY_WEB_SEARCH_DETAIL);
  if (instance.kind === 'webSearch')
    return lamp(
      'live',
      'Ready',
      'The selected model provider runs hosted search when the model supports it and channel assignment permits it.',
    );
  if (!kindNeedsProbe(instance.kind)) return lamp('live', 'Ready', 'No runtime check needed.');
  if (!instance.hasCredential) return lamp('off', 'No credential', 'Set one in Edit.');
  if (status === undefined || status.credentialVersion !== instance.credentialVersion)
    return lamp('wait', 'Waiting for runtime', 'Not checked since the last change.');
  const when = `Checked ${time(status.reportedAt)} by ${status.reporter}`;
  if (status.state === 'ready') {
    return lamp(
      'live',
      'Ready',
      status.toolsCount === null ? when : `${status.toolsCount} tools. ${when}`,
    );
  }
  return lamp('off', status.state === 'blocked' ? 'Blocked' : 'Error', status.detail || when);
}

function credentialText(instance: ToolInstance): string {
  if (instance.kind === 'slack')
    return instance.hasCredential
      ? 'Workspace bot token'
      : 'No bot token (workspace not whitelisted)';
  if (!CREDENTIAL_KINDS.includes(instance.kind)) return 'Not needed';
  return instance.hasCredential ? `Set (v${instance.credentialVersion})` : 'Not set';
}

/** Host and settings fields of a kind, pre-filled from an instance when editing. */
function settingsFields(kind: ToolKind, instance: ToolInstance | null): Raw {
  const host = instance?.host ?? '';
  switch (kind) {
    case 'gitlab':
      return html`<label class="field"
        >Host <input name="host" value="${host}" placeholder="gitlab.example.com" required
      /></label>`;
    case 'atlassian': {
      const settings = instance?.settings as AtlassianSettings | undefined;
      const selected = settings?.operations ?? null;
      return html`<label class="field"
          >Site <input name="host" value="${host}" placeholder="example.atlassian.net" required
        /></label>
        <label class="field"
          >Cloud ID <input name="cloudId" value="${settings?.cloudId ?? ''}" required
        /></label>
        <label class="field"
          >Token owner email <input name="email" value="${settings?.email ?? ''}" required
        /></label>
        <fieldset class="field">
          <legend>Operations</legend>
          ${ATLASSIAN_READ_OPERATIONS.map(
            (name) =>
              html`<label
                ><input
                  type="checkbox"
                  name="op_${name}"
                  ${selected === null || selected.includes(name) ? 'checked' : ''}
                />
                ${name}</label
              >`,
          )}
        </fieldset>`;
    }
    case 'datadog': {
      const settings = instance?.settings as DatadogSettings | undefined;
      return html`<label class="field"
          >Site <input name="host" value="${host}" placeholder="datadoghq.eu" required
        /></label>
        <label class="field"
          >Toolsets <input name="toolsets" value="${settings?.toolsets ?? 'all'}"
        /></label>
        <label class="field"
          >Denied tools (comma list)
          <input name="denyTools" value="${(settings?.denyTools ?? []).join(', ')}"
        /></label>`;
    }
    case 'cloudflare': {
      const settings = instance?.settings as CloudflareSettings | undefined;
      return html`<label class="field"
          >Account ID (optional, enables account-level datasets)
          <input
            name="accountId"
            value="${settings?.accountId ?? ''}"
            placeholder="32 hex characters"
        /></label>
        <label class="field"
          >Zones (optional, one per line; empty = every zone the token can see)
          <textarea name="zones" rows="4" placeholder="example.com">
${(settings?.zones ?? []).join('\n')}</textarea
          >
        </label>`;
    }
    case 'webSearch':
      return html`<p class="muted small">
        The selected model provider runs hosted search on supported models (Claude Code's
        WebSearch). No endpoint or key; assigning this instance to a channel admits it.
      </p>`;
    case 'codeMode':
      return html`<p class="muted small">
        Code Mode: the model may run a short JavaScript program in a sandbox (no network, no
        credentials) that calls the channel's read-only service tools and returns one combined
        result. No endpoint or key; assigning this instance to a channel admits it.
      </p>`;
    case 'files': {
      const settings = instance?.settings as FilesSettings | undefined;
      return html`<label class="field"
        ><span
          ><input type="checkbox" name="readOnly" ${settings?.readOnly === true ? 'checked' : ''} />
          Read-only</span
        ></label
      >`;
    }
    default:
      return html``;
  }
}

/** Write-only credential fields: never pre-filled, empty keeps the stored one. */
function credentialFields(kind: ToolKind, instance: ToolInstance | null): Raw {
  if (!CREDENTIAL_KINDS.includes(kind)) return html``;
  const hint =
    instance === null || !instance.hasCredential
      ? ''
      : ` (set, v${instance.credentialVersion}; leave empty to keep)`;
  if (kind === 'atlassian') {
    return html`<label class="field"
        >Jira token${hint} <input name="credentialJira" type="password" autocomplete="off" /></label
      ><label class="field"
        >Confluence token${hint}
        <input name="credentialConfluence" type="password" autocomplete="off"
      /></label>`;
  }
  return html`<label class="field"
    >Token${hint} <input name="credential" type="password" autocomplete="off"
  /></label>`;
}

export function toolsPage(
  context: PageContext,
  installation: Installation,
  instances: ToolInstance[],
  statuses: ReadonlyMap<string, ToolStatus>,
  assignments: ChannelTool[],
  channels: Channel[],
  model: ModelView,
  prompt: PromptView,
): string {
  const base = `/workspaces/${installation.teamId}/tools`;
  const channelNames = new Map(channels.map((row) => [row.channelId, row.name || row.channelId]));
  const rows = instances.map((instance) => {
    const users = assignments.filter((row) => row.instanceId === instance.id);
    return html`<div class="row">
      <span class="row-ic">${icon(KIND_ICONS[instance.kind])}</span>
      <div class="row-main">
        <div class="row-title">${instance.label}</div>
        <div class="row-meta">
          <span>${TOOL_KIND_TITLES[instance.kind]}</span>
          ${instance.host === null ? '' : html`<span>${instance.host}</span>`}
          <span class="tag ${instance.hasCredential ? 'set' : ''}"
            >${credentialText(instance)}</span
          >
          <span
            >${users.length === 0
              ? 'No channel'
              : users
                  .map((row) => `#${channelNames.get(row.channelId) ?? row.channelId}`)
                  .join(', ')}</span
          >
          <span class="id">${instance.id}</span>
        </div>
      </div>
      <div class="row-side">${toolLamp(instance, statuses.get(instance.id))}</div>
      <div class="row-actions">
        ${postButton(
          `${base}/${instance.id}/status`,
          instance.status === 'enabled' ? 'Disable' : 'Enable',
          context.csrf,
          { status: instance.status === 'enabled' ? 'disabled' : 'enabled' },
          instance.status === 'enabled' ? 'quiet' : 'primary',
          instance.status === 'enabled'
            ? { icon: 'disable', iconOnly: true, tone: 'stop' }
            : { icon: 'enable', iconOnly: true, tone: 'go' },
        )}
        <a href="#edit-${instance.id}" ${iconAttrs('Edit')}>${icon('edit')}</a>
        <div
          class="modal"
          id="edit-${instance.id}"
          role="dialog"
          aria-label="Edit ${instance.label}"
        >
          <a class="modal-bg" href="#" aria-label="Close" tabindex="-1"></a>
          <form class="stack modal-card" method="post" action="${base}/${instance.id}">
            <div class="modal-head">
              <h2>${icon('edit')}Edit ${instance.label}</h2>
              <a href="#" ${iconAttrs('Close')}>${icon('close')}</a>
            </div>
            ${csrfField(context.csrf)}
            <label class="field"
              >Label <input name="label" value="${instance.label}" required
            /></label>
            ${settingsFields(instance.kind, instance)} ${credentialFields(instance.kind, instance)}
            <div class="actions">
              <button type="submit">${icon('save')}Save</button>
              <a class="button ghost" href="#">Cancel</a>
            </div>
          </form>
        </div>
        ${users.length > 0
          ? html`<span class="sub">Unassign to delete</span>`
          : confirmButton(
              `${base}/${instance.id}/delete`,
              'Delete',
              'Deletes the instance and its stored credential.',
              context.csrf,
            )}
      </div>
    </div>`;
  });
  const createForms = TOOL_KINDS.map(
    (kind) =>
      html`<details>
        <summary>${icon(KIND_ICONS[kind])}Add ${TOOL_KIND_TITLES[kind]}</summary>
        <form class="stack" method="post" action="${base}">
          ${csrfField(context.csrf)}<input type="hidden" name="kind" value="${kind}" />
          <label class="field"
            >Label <input name="label" placeholder="${TOOL_KIND_TITLES[kind]}" required
          /></label>
          ${settingsFields(kind, null)} ${credentialFields(kind, null)}
          <div><button type="submit">${icon('plus')}Add ${TOOL_KIND_TITLES[kind]}</button></div>
        </form>
      </details>`,
  );
  return page(
    teamName(installation),
    context,
    html`<p class="lead">
        A tool instance belongs to this workspace. Assign it to channels on each channel's Tools
        page; a channel uses at most one instance per kind. Credentials are write-only: they are
        never shown again, only their version.
      </p>
      <div class="list">
        ${rows.length > 0 ? rows : html`<p class="empty">No tool instance yet. Add one below.</p>`}
      </div>
      <div class="section-h"><h2>${icon('plus')}Add a tool instance</h2></div>
      <div class="adders">${createForms}</div>
      <div class="split even">
        <div>${modelPanel(context, `${base}/model`, model, 'workspace')}</div>
        <div>${promptPanel(context, `${base}/prompt`, prompt, 'workspace')}</div>
      </div>`,
    workspaceOptions(installation, 'tools', `Tools of ${teamName(installation)}`),
  );
}

/** Where a channel's or workspace's model comes from (channel → workspace → deployment). */
export interface ModelView {
  fingerprint: string | null;
  /** The key new runs use; null when the deployment has no allowlist. */
  effective: string | null;
  source: 'channel' | 'workspace' | 'deployment';
  channel: string | null;
  workspace: string | null;
  deployment: string | null;
  /** False when the assigned key is absent from MODEL_CATALOG. */
  available: boolean;
  /** The deployment's keys; empty hides the controls. */
  keys: string[];
  route?: string | null;
  modelId?: string | null;
  webSearch?: boolean;
}

/**
 * The model select of a channel (inherit = the workspace default) or of a
 * workspace (inherit = the deployment default). Hidden without an allowlist.
 */
function modelPanel(
  context: PageContext,
  action: string,
  view: ModelView,
  level: 'channel' | 'workspace',
): Raw {
  if (view.keys.length === 0) return html``;
  const stored = level === 'channel' ? view.channel : view.workspace;
  const inherited =
    level === 'channel'
      ? view.workspace !== null
        ? `workspace default: ${view.workspace}`
        : `deployment default: ${view.deployment ?? '—'}`
      : `deployment default: ${view.deployment ?? '—'}`;
  const keys = stored !== null && !view.keys.includes(stored) ? [...view.keys, stored] : view.keys;
  const options = keys.map(
    (key) =>
      html`<option value="${key}" ${key === stored ? 'selected' : ''}>
        ${key}${key === view.deployment ? ' (deployment default)' : ''}${view.keys.includes(key)
          ? ''
          : ' (no longer offered)'}
      </option>`,
  );
  return html`<form class="card" method="post" action="${action}" id="model">
    <div class="card-h">
      <h2>${icon('model')}Model</h2>
      <p>
        ${level === 'channel'
          ? 'The model every new run in this channel uses. A route, connection or model change starts a fresh model conversation in the same Slack thread.'
          : 'The default model of channels in this workspace that have no model of their own.'}
      </p>
    </div>
    <div class="card-b stack">
      <input type="hidden" name="fingerprint" value="${view.fingerprint ?? ''}" />
      ${csrfField(context.csrf)}
      ${view.route
        ? html`<p class="muted small">
            ${view.route} · ${view.modelId} · Hosted search
            ${view.webSearch ? 'configured' : 'unavailable'}
          </p>`
        : html``}
      <label class="field"
        >Model
        <select name="key" aria-label="Model">
          <option value="inherit" ${stored === null ? 'selected' : ''}>
            Inherit (${inherited})
          </option>
          ${options}
        </select></label
      >
      <div>
        ${view.available
          ? lamp('live', `Runs use ${view.effective ?? '—'}`, `from the ${view.source}`)
          : lamp(
              'off',
              `${view.effective ?? '—'} is no longer offered`,
              'Choose a model from the deployment catalog to allow new runs.',
            )}
      </div>
    </div>
    <div class="card-f"><button type="submit">${icon('save')}Save model</button></div>
  </form>`;
}

/** Where a channel's or workspace's system prompt comes from (channel → workspace → none). */
export interface PromptView {
  fingerprint: string | null;
  /** The text new runs receive after the fixed rules; null: none. */
  effective: string | null;
  source: 'channel' | 'workspace' | 'none';
  channel: string | null;
  workspace: string | null;
  /** Length of the effective text. */
  chars: number;
  maxChars: number;
}

/**
 * The system prompt of a channel (empty = inherit the workspace prompt) or
 * of a workspace (empty = no prompt for channels without their own).
 */
function promptPanel(
  context: PageContext,
  action: string,
  view: PromptView,
  level: 'channel' | 'workspace',
): Raw {
  const stored = level === 'channel' ? view.channel : view.workspace;
  const status =
    view.source === 'none'
      ? lamp('idle', level === 'channel' ? 'No channel prompt' : 'No workspace prompt')
      : lamp('live', `${view.chars} characters`, `from the ${view.source}`);
  return html`<section class="card" id="prompt">
    <div class="card-h">
      <h2>${icon('prompt')}System prompt</h2>
      <p>
        ${level === 'channel'
          ? "Runs in this channel receive these instructions after the assistant's fixed rules. Changing them rotates the native session of every active coding thread in this channel at its next run. Leave empty to inherit the workspace prompt."
          : "The instructions every channel in this workspace receives unless the channel has a prompt of its own. Runs receive them after the assistant's fixed rules."}
        At most ${view.maxChars} characters; a long prompt leaves less room for the thread
        (CLAUDE_MAX_PROMPT_CHARS).
      </p>
    </div>
    <form class="card-b stack" method="post" action="${action}" id="prompt-form">
      <input type="hidden" name="fingerprint" value="${view.fingerprint ?? ''}" />
      ${csrfField(context.csrf)}
      <label class="field"
        >Instructions
        <textarea name="text" maxlength="${view.maxChars}" rows="8" aria-label="System prompt">
${stored ?? ''}</textarea
        >
      </label>
      <div>${status}</div>
      ${level === 'channel' && view.source === 'workspace'
        ? html`<details class="disclose">
            <summary>${icon('chevron')}Inherited workspace prompt</summary>
            <pre>${view.workspace ?? ''}</pre>
          </details>`
        : html``}
    </form>
    <div class="card-f">
      ${stored !== null
        ? postButton(
            action,
            'Clear (inherit)',
            context.csrf,
            { reset: 'true', fingerprint: view.fingerprint ?? '' },
            'quiet',
            { icon: 'reset' },
          )
        : html``}
      <button type="submit" form="prompt-form">${icon('save')}Save prompt</button>
    </div>
  </section>`;
}

export interface ChannelToolsView {
  fingerprint: string;
  model: ModelView;
  prompt: PromptView;
  /** "Automatic thread replies" (default on). */
  autoReplies: boolean;
  tools: Array<{
    kind: ToolKind;
    instanceId: string;
    label: string;
    ready: boolean;
    detail: string | null;
  }>;
  compiled: ChannelToolAssignment | null;
}

export function channelToolsPage(
  context: PageContext,
  installation: Installation,
  channel: Channel,
  instances: ToolInstance[],
  view: ChannelToolsView,
): string {
  const base = `/workspaces/${installation.teamId}/channels/${channel.channelId}`;
  const current = new Map(view.tools.map((row) => [row.kind, row]));
  const selectors = TOOL_KINDS.map((kind) => {
    const assigned = current.get(kind);
    const options = instances.filter(
      (row) => row.kind === kind && (row.status === 'enabled' || row.id === assigned?.instanceId),
    );
    return html`<tr>
      <td>${TOOL_KIND_TITLES[kind]}</td>
      <td data-label="Instance">
        <select name="kind_${kind}" aria-label="${TOOL_KIND_TITLES[kind]} instance">
          <option value="none" ${assigned === undefined ? 'selected' : ''}>None</option>
          ${options.map(
            (row) =>
              html`<option value="${row.id}" ${row.id === assigned?.instanceId ? 'selected' : ''}>
                ${row.label}${row.host === null ? '' : ` (${row.host})`}${row.status === 'enabled'
                  ? ''
                  : ' (disabled)'}
              </option>`,
          )}
        </select>
      </td>
      <td data-label="Readiness">
        ${assigned === undefined
          ? html`<span class="faint">—</span>`
          : assigned.ready
            ? lamp('live', 'Ready')
            : lamp('wait', 'Not ready', assigned.detail ?? '')}
      </td>
    </tr>`;
  });
  const name = `#${channel.name || channel.channelId}`;
  return page(
    name,
    context,
    html`<form class="card" method="post" action="${base}/tools">
        <div class="card-h">
          <h2>${icon('tools')}Tools</h2>
          <p>
            One instance per kind. Instances are managed on
            <a href="/workspaces/${installation.teamId}/tools">the workspace's Tools page</a>.
            Unblocked channel members may use exactly the tools assigned here.
          </p>
        </div>
        ${csrfField(context.csrf)}
        <div class="table">
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Instance</th>
                <th>Readiness</th>
              </tr>
            </thead>
            <tbody>
              ${selectors}
            </tbody>
          </table>
        </div>
        <div class="card-f"><button type="submit">${icon('save')}Save tools</button></div>
      </form>
      <div class="split even">
        <div>${modelPanel(context, `${base}/model`, view.model, 'channel')}</div>
        <div>${promptPanel(context, `${base}/prompt`, view.prompt, 'channel')}</div>
      </div>
      <section class="card">
        <div class="card-h"><h2>${icon('shield')}What the agent enforces</h2></div>
        <div class="card-b">
          ${view.compiled === null
            ? html`<div class="notice wait">
                <div>
                  Not in the current configuration: the channel is not enabled or its workspace is
                  not whitelisted.
                </div>
              </div>`
            : html`<details class="disclose">
                <summary>${icon('chevron')}Compiled channel configuration</summary>
                <pre>${JSON.stringify(view.compiled, null, 2)}</pre>
              </details>`}
        </div>
      </section>`,
    channelOptions(installation, channel, 'tools', `Tools in ${name}`),
  );
}

export function adminsPage(context: PageContext, admins: AdminUser[], selfId: number): string {
  const rows = admins.map(
    (row) =>
      html`<div class="row">
        <span class="row-ic">${initials(row.name)}</span>
        <div class="row-main">
          <div class="row-title">
            ${row.name}${row.id === selfId ? html` <span class="tag set">You</span>` : ''}
          </div>
          <div class="row-meta"><span>Created ${time(row.createdAt)}</span></div>
        </div>
        <div class="row-side">
          ${row.disabled ? lamp('off', 'Disabled') : lamp('live', 'Active')}
        </div>
        <div class="row-actions">
          ${row.id === selfId
            ? html``
            : postButton(
                `/admins/${row.id}`,
                row.disabled ? 'Enable' : 'Disable',
                context.csrf,
                { disabled: row.disabled ? 'false' : 'true' },
                row.disabled ? 'primary' : 'quiet',
                row.disabled
                  ? { icon: 'enable', iconOnly: true, tone: 'go' }
                  : { icon: 'disable', iconOnly: true, tone: 'stop' },
              )}
        </div>
      </div>`,
  );
  return page(
    'Accounts',
    context,
    html`<div class="list">${rows}</div>
      <div class="split even">
        <form class="card" method="post" action="/admins">
          <div class="card-h"><h2>${icon('userPlus')}Add an admin</h2></div>
          <div class="card-b stack">
            ${csrfField(context.csrf)}
            <label class="field">Name <input name="name" autocomplete="off" required /></label>
            <label class="field"
              >Password (12 characters or more)
              <input
                name="password"
                type="password"
                minlength="12"
                autocomplete="new-password"
                required
            /></label>
          </div>
          <div class="card-f"><button type="submit">${icon('userPlus')}Add admin</button></div>
        </form>
        <form class="card" method="post" action="/admins/password">
          <div class="card-h"><h2>${icon('tokens')}Change your password</h2></div>
          <div class="card-b stack">
            ${csrfField(context.csrf)}
            <label class="field"
              >Current password
              <input name="current" type="password" autocomplete="current-password" required
            /></label>
            <label class="field"
              >New password
              <input
                name="password"
                type="password"
                minlength="12"
                autocomplete="new-password"
                required
            /></label>
          </div>
          <div class="card-f">
            <button type="submit" class="quiet">${icon('save')}Change password</button>
          </div>
        </form>
      </div>`,
    { section: 'admins' },
  );
}

export function tokensPage(
  context: PageContext,
  tokens: Array<{ id: number; name: string; createdBy: string; createdAt: number }>,
  created: string | null,
): string {
  return page(
    'API tokens',
    context,
    html`${created === null
        ? html``
        : html`<div class="notice ok">
            <div>
              <strong>Copy the new token now. It is not shown again.</strong>
              <code class="secret">${created}</code>
            </div>
          </div>`}
      <p class="lead">
        A token has full admin rights on <code>/api/*</code>. Use one per automation, such as the
        live-test harness, so you can revoke it alone.
      </p>
      <div class="list">
        ${tokens.length > 0
          ? tokens.map(
              (row) =>
                html`<div class="row">
                  <span class="row-ic">${icon('tokens')}</span>
                  <div class="row-main">
                    <div class="row-title">${row.name}</div>
                    <div class="row-meta">
                      <span>Created ${time(row.createdAt)} by ${row.createdBy}</span>
                    </div>
                  </div>
                  <div class="row-side">
                    ${confirmButton(
                      `/tokens/${row.id}/delete`,
                      'Delete',
                      'Anything still using this token loses access at once.',
                      context.csrf,
                    )}
                  </div>
                </div>`,
            )
          : html`<p class="empty">No tokens.</p>`}
      </div>
      <form class="card" method="post" action="/tokens">
        <div class="card-h"><h2>${icon('tokens')}Create a token</h2></div>
        <div class="card-b">
          <div class="fields">
            ${csrfField(context.csrf)}
            <label class="field"
              >Name <input name="name" placeholder="e.g. live-test harness" required
            /></label>
            <button type="submit">${icon('plus')}Create token</button>
          </div>
        </div>
      </form>`,
    { section: 'tokens' },
  );
}

export interface LiveRegion {
  epoch: string;
  versions: Record<string, number>;
}

function auditRow(row: AuditEntry): Raw {
  return html`<details class="row-details">
    <summary class="row">
      <span class="row-ic">${initials(row.actor)}</span>
      <span class="row-main">
        <span class="row-title"
          ><span class="tag accent">${row.action}</span><span class="id">${row.target}</span></span
        >
        <span class="row-meta"
          ><span>${row.actor}</span><span class="when">${time(row.at)}</span></span
        >
      </span>
      <span class="row-side">
        ${row.configVersion === null ? '' : html`<span class="badge">v${row.configVersion}</span>`}
      </span>
    </summary>
    <pre class="detail">${JSON.stringify(row.detail, null, 2)}</pre>
  </details>`;
}

export function auditPage(context: PageContext, entries: AuditEntry[], live?: LiveRegion): string {
  return page(
    'Audit log',
    context,
    html`<div class="list audit">
      ${entries.length === 0 ? html`<p class="empty">No entries yet.</p>` : entries.map(auditRow)}
    </div>`,
    {
      section: 'audit',
      sub: `The latest ${entries.length} changes and token reads, newest first. Open an entry for its detail.`,
      ...(live === undefined
        ? {}
        : { liveNotice: { topics: ['audit'], ...live, text: 'New audit entries were recorded.' } }),
    },
  );
}

export function configPage(
  context: PageContext,
  document: CompiledDocument,
  live?: LiveRegion,
): string {
  return page(
    'Application settings',
    context,
    html`<section class="card">
      <div class="card-h">
        <h2>${icon('shield')}Configuration in force</h2>
        <p>
          What the agent and the adapter enforce right now. They fetch it again at most 2 seconds
          after a change here.
        </p>
      </div>
      <div class="card-b">
        <dl class="kv facts">
          <dt>Version</dt>
          <dd>${document.version}</dd>
          <dt>Hash</dt>
          <dd><span class="id">${document.hash}</span></dd>
        </dl>
        <details class="disclose">
          <summary>${icon('chevron')}Compiled configuration</summary>
          <pre>${JSON.stringify(document, null, 2)}</pre>
        </details>
      </div>
    </section>`,
    {
      section: 'config',
      ...(live === undefined
        ? {}
        : {
            liveNotice: {
              topics: ['config'],
              ...live,
              text: 'The configuration changed elsewhere; what you type here is kept until you reload.',
            },
          }),
    },
  );
}

// -- Costs ----------------------------------------------------------------------

const COST_BREAKDOWNS: Array<[Exclude<CostGroup, 'day'>, string]> = [
  ['channel', 'Channel'],
  ['requester', 'Requester'],
  ['mode', 'Mode'],
  ['model', 'Model'],
  ['route', 'Provider route'],
];

function costsHref(
  view: Pick<CostsView, 'from' | 'to'>,
  group: CostGroup,
  path = '/costs',
): string {
  return `${path}?${new URLSearchParams({ from: view.from, to: view.to, group }).toString()}`;
}

function grouped(value: number): string {
  return value.toLocaleString('en-US');
}

function costTable(rows: CostRow[], title: string): Raw {
  const most = Math.max(1, ...rows.map((row) => row.requests));
  return html`<div class="table">
    <table>
      <thead>
        <tr>
          <th>${title}</th>
          <th class="num">Attempts</th>
          <th class="num">Completed</th>
          <th class="num">Failed</th>
          <th class="num">Interrupted</th>
          <th class="num">Input tokens</th>
          <th class="num">Output tokens</th>
        </tr>
      </thead>
      <tbody>
        ${rows.length === 0
          ? html`<tr>
              <td class="empty" colspan="7">No model attempts in this range.</td>
            </tr>`
          : rows.map(
              (row) =>
                html`<tr>
                  <td>
                    <span
                      >${row.label}${row.detail
                        ? html`<span class="sub id">${row.detail}</span>`
                        : ''}</span
                    >
                  </td>
                  <td class="num" data-label="Attempts">
                    <span
                      >${grouped(row.requests)}<span class="bar" aria-hidden="true"
                        ><i style="width:${Math.round((row.requests / most) * 100)}%"></i></span
                    ></span>
                  </td>
                  <td class="num" data-label="Completed">${grouped(row.completedRequests)}</td>
                  <td class="num" data-label="Failed">${grouped(row.failedRequests)}</td>
                  <td class="num" data-label="Interrupted">${grouped(row.interruptedRequests)}</td>
                  <td class="num" data-label="Input tokens">${grouped(row.inputTokens)}</td>
                  <td class="num" data-label="Output tokens">${grouped(row.outputTokens)}</td>
                </tr>`,
            )}
      </tbody>
    </table>
  </div>`;
}

/** Every UTC day of a range, oldest first, or null when it is too long to chart. */
function rangeDays(from: string, to: string, limit = 92): string[] | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (!(days > 0) || days > limit) return null;
  return Array.from({ length: days }, (_, index) => utcDay(start + index * DAY_MS));
}

/** Attempts per day as stacked bars (completed, failed, interrupted); inline SVG. */
function attemptsChart(view: CostsView): Raw {
  const days = rangeDays(view.from, view.to);
  if (days === null) {
    return html`<p class="muted small">Choose a range of 92 days or less to see the chart.</p>`;
  }
  const byDay = new Map(view.days.map((row) => [row.label, row]));
  const most = Math.max(1, ...view.days.map((row) => row.requests));
  // Bars stretch to the plot; labels stay HTML so they keep their size.
  const width = days.length * 10;
  const height = 100;
  const bar = 7;
  const labelEvery = Math.ceil(days.length / 8);
  return html`<div class="chart">
      <div class="chart-plot">
        ${[1, 0.5, 0].map(
          (share) =>
            html`<span class="chart-y" style="top:${(1 - share) * 100}%"
              >${Math.round(share * most)}</span
            >`,
        )}
        <svg
          viewBox="0 0 ${width} ${height}"
          preserveAspectRatio="none"
          role="img"
          aria-label="Attempts per day, ${view.from} to ${view.to}"
        >
          ${[0, 50, 100].map(
            (y) => html`<line class="grid" x1="0" x2="${width}" y1="${y}" y2="${y}" />`,
          )}
          ${days.map((day, index) => {
            const row = byDay.get(day);
            const x = index * 10 + (10 - bar) / 2;
            let y = height;
            const segments = (
              [
                ['completed', row?.completedRequests ?? 0],
                ['failed', row?.failedRequests ?? 0],
                ['interrupted', row?.interruptedRequests ?? 0],
              ] as const
            ).map(([kind, value]) => {
              const h = (value / most) * height;
              y -= h;
              return h <= 0
                ? html``
                : html`<rect
                    class="s-${kind}"
                    x="${x}"
                    y="${y.toFixed(2)}"
                    width="${bar}"
                    height="${h.toFixed(2)}"
                  />`;
            });
            return html`<g class="day">
              <title>
                ${day}: ${row?.requests ?? 0} attempts (${row?.completedRequests ?? 0} completed,
                ${row?.failedRequests ?? 0} failed, ${row?.interruptedRequests ?? 0} interrupted)
              </title>
              <rect x="${index * 10}" y="0" width="10" height="${height}" fill="transparent" />
              ${segments}
            </g>`;
          })}
        </svg>
      </div>
      <div class="chart-x" aria-hidden="true">
        ${days.map(
          (day, index) => html`<span>${index % labelEvery === 0 ? day.slice(5) : ''}</span>`,
        )}
      </div>
    </div>
    <div class="legend">
      <span><i class="sw sw-completed"></i>Completed</span
      ><span><i class="sw sw-failed"></i>Failed</span
      ><span><i class="sw sw-interrupted"></i>Interrupted</span>
    </div>`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;
}

function outcomeBar(totals: CostAggregate): Raw {
  if (totals.requests === 0) return html``;
  const share = (value: number) => `${((value / totals.requests) * 100).toFixed(2)}%`;
  return html`<div class="mini-bar" aria-hidden="true">
    <i style="width:${share(totals.completedRequests)};background:var(--accent)"></i
    ><i style="width:${share(totals.failedRequests)};background:var(--err)"></i
    ><i style="width:${share(totals.interruptedRequests)};background:var(--warn)"></i>
  </div>`;
}

export function costsPage(context: PageContext, view: CostsView, live?: LiveRegion): string {
  const totals = view.totals;
  const ledger = view.ledger;
  const presets = costPresets(view.generatedAt);
  return page(
    'Costs',
    context,
    html`<form class="toolbar" method="get" action="/costs">
        <nav class="seg" aria-label="Range">
          ${presets.map(
            (preset) =>
              html`<a
                href="${costsHref(preset.range, view.group)}"
                ${preset.range.from === view.from && preset.range.to === view.to
                  ? raw('aria-current="page"')
                  : ''}
                >${preset.label}</a
              >`,
          )}
        </nav>
        <label class="field"
          ><span class="sr">From</span
          ><input type="date" name="from" value="${view.from}" aria-label="From"
        /></label>
        <label class="field"
          ><span class="sr">To</span
          ><input type="date" name="to" value="${view.to}" aria-label="To"
        /></label>
        <input type="hidden" name="group" value="${view.group}" />
        <button type="submit" class="quiet">Show</button>
        <p class="actions">
          <a class="button ghost" href="${costsHref(view, 'day', '/costs.csv')}"
            >${icon('download')}Daily CSV</a
          >
          ${view.group === 'day'
            ? ''
            : html`<a class="button ghost" href="${costsHref(view, view.group, '/costs.csv')}"
                >${icon('download')}Breakdown CSV</a
              >`}
        </p>
      </form>
      <div class="stats">
        <div class="stat">
          <div class="stat-l">${icon('activity')}Attempts</div>
          <div class="stat-v">${count(totals.requests)}</div>
          <div class="stat-s">${view.from} to ${view.to}</div>
        </div>
        <div class="stat">
          <div class="stat-l">${icon('check')}Completed</div>
          <div class="stat-v">${percent(totals.completedRequests, totals.requests)}</div>
          <div class="stat-s">
            ${totals.completedRequests} completed, ${totals.failedRequests} failed,
            ${totals.interruptedRequests} interrupted
          </div>
          ${outcomeBar(totals)}
        </div>
        <div class="stat">
          <div class="stat-l">${icon('zap')}Input tokens</div>
          <div class="stat-v">${count(totals.inputTokens)}</div>
          <div class="stat-s">
            ${count(totals.cacheReadTokens)} cache read · ${count(totals.cacheCreationTokens)} cache
            write
          </div>
        </div>
        <div class="stat">
          <div class="stat-l">${icon('zap')}Output tokens</div>
          <div class="stat-v">${count(totals.outputTokens)}</div>
          <div class="stat-s">Billed USD is unavailable.</div>
        </div>
      </div>
      <section class="card">
        <div class="card-h">
          <h2>${icon('costs')}Attempts per day</h2>
          <p>Provider inference attempts and reported token usage by UTC day.</p>
        </div>
        <div class="card-b">${attemptsChart(view)}</div>
      </section>
      <div class="section-h"><h2>${icon('costs')}Per day</h2></div>
      ${costTable(view.days, 'Day (UTC)')}
      <div class="section-h"><h2>${icon('costs')}Breakdown</h2></div>
      <nav class="tabs" aria-label="Breakdown">
        ${COST_BREAKDOWNS.map(
          ([group, label]) =>
            html`<a
              href="${costsHref(view, group)}"
              ${group === view.group ? raw('aria-current="page"') : ''}
              >${label}</a
            >`,
        )}
      </nav>
      ${costTable(view.rows, COST_BREAKDOWNS.find(([group]) => group === view.group)?.[1] ?? 'Day')}
      <p class="muted small">
        Ledger:
        ${ledger.lastReceivedAt === null
          ? 'no rows received yet'
          : html`last row received ${time(ledger.lastReceivedAt)}`}
        · ${ledger.requestRows} request rows, ${ledger.runRows} run
        rows${ledger.firstDay === null ? '' : ` since ${ledger.firstDay}`} · instance
        ${ledger.instances.length === 0 ? '—' : ledger.instances.join(', ')} · kept
        ${ledger.retentionDays} days.
      </p>`,
    {
      section: 'costs',
      sub: 'Provider inference attempts and reported token usage by UTC day. Billed USD is unavailable.',
      ...(live === undefined
        ? {}
        : { liveNotice: { topics: ['costs'], ...live, text: 'New cost data arrived.' } }),
    },
  );
}

// -- Overview ---------------------------------------------------------------------

export interface OverviewView {
  /** The last 7 days, grouped by day. */
  costs: CostsView;
  installations: Installation[];
  channels: Channel[];
  instances: ToolInstance[];
  statuses: ReadonlyMap<string, ToolStatus>;
  /** The newest audit entries. */
  audit: AuditEntry[];
}

interface Attention {
  icon: IconName;
  tone: 'ok' | 'wait' | 'off';
  title: string;
  detail: string;
  href: string;
  action: string;
}

/** What blocks the bot somewhere, worst first. */
export function attentionItems(view: OverviewView): Attention[] {
  const names = new Map(view.installations.map((row) => [row.teamId, teamName(row)]));
  const items: Attention[] = [];
  for (const instance of view.instances) {
    if (instance.status !== 'enabled' || !kindNeedsProbe(instance.kind)) continue;
    const where = `${names.get(instance.teamId) ?? instance.teamId} · ${TOOL_KIND_TITLES[instance.kind]}`;
    const href = `/workspaces/${instance.teamId}/tools`;
    if (!instance.hasCredential && CREDENTIAL_KINDS.includes(instance.kind)) {
      items.push({
        icon: 'tokens',
        tone: 'off',
        title: `${instance.label} has no credential`,
        detail: where,
        href,
        action: 'Set',
      });
      continue;
    }
    const status = view.statuses.get(instance.id);
    if (
      status !== undefined &&
      status.credentialVersion === instance.credentialVersion &&
      status.state !== 'ready'
    ) {
      items.push({
        icon: 'alert',
        tone: 'off',
        title: `${instance.label}: runtime check ${status.state === 'blocked' ? 'blocked' : 'failed'}`,
        detail: `${status.detail || where} · checked ${time(status.reportedAt)}`,
        href,
        action: 'Fix',
      });
    }
  }
  for (const channel of view.channels) {
    if (!channel.enabled || channel.botMember) continue;
    items.push({
      icon: 'channels',
      tone: 'off',
      title: `The bot left #${channel.name || channel.channelId}`,
      detail: `${names.get(channel.teamId) ?? channel.teamId} · invite it again with /invite`,
      href: `/workspaces/${channel.teamId}/channels/${channel.channelId}/blocked-members`,
      action: 'Open',
    });
  }
  for (const row of view.installations) {
    if (!row.hasToken) {
      items.push({
        icon: 'dashed',
        tone: 'off',
        title: `${teamName(row)} is not paired`,
        detail: 'No bot token. Add to Slack to pair it.',
        href: '/workspaces',
        action: 'Pair',
      });
    } else if (row.status === 'pending') {
      items.push({
        icon: 'clock',
        tone: 'wait',
        title: `${teamName(row)} is pending`,
        detail: 'The bot tells people it is not enabled here yet.',
        href: '/workspaces',
        action: 'Review',
      });
    }
  }
  return items;
}

export function overviewPage(context: PageContext, view: OverviewView): string {
  const totals = view.costs.totals;
  const days = rangeDays(view.costs.from, view.costs.to) ?? [];
  const byDay = new Map(view.costs.days.map((row) => [row.label, row.requests]));
  const series = days.map((day) => byDay.get(day) ?? 0);
  const live = new Set(
    view.installations
      .filter((row) => row.hasToken && row.status === 'whitelisted')
      .map((row) => row.teamId),
  );
  const answering = view.channels.filter(
    (row) => row.enabled && row.botMember && live.has(row.teamId),
  ).length;
  const attention = attentionItems(view);
  const channelCounts = new Map<string, number>();
  for (const row of view.channels)
    channelCounts.set(row.teamId, (channelCounts.get(row.teamId) ?? 0) + 1);
  return page(
    'Overview',
    context,
    html`<div class="stats">
        <a class="stat" href="/costs">
          <div class="stat-l">${icon('activity')}Attempts</div>
          <div class="stat-v">${count(totals.requests)}</div>
          ${sparkline(series, `Attempts per day: ${series.join(', ')}`)}
        </a>
        <a class="stat" href="/costs">
          <div class="stat-l">${icon('check')}Completed</div>
          <div class="stat-v">${percent(totals.completedRequests, totals.requests)}</div>
          <div class="stat-s">
            ${totals.completedRequests} completed · ${totals.failedRequests} failed ·
            ${totals.interruptedRequests} interrupted
          </div>
          ${outcomeBar(totals)}
        </a>
        <a class="stat" href="/costs">
          <div class="stat-l">${icon('zap')}Input tokens</div>
          <div class="stat-v">${count(totals.inputTokens)}</div>
          <div class="stat-s">
            ${count(totals.outputTokens)} out · ${count(totals.cacheReadTokens)} cache read
          </div>
        </a>
        <a class="stat" href="/workspaces">
          <div class="stat-l">${icon('channels')}Answering channels</div>
          <div class="stat-v">${answering}<small> / ${view.channels.length}</small></div>
          <div class="stat-s">
            in ${live.size} whitelisted workspace${live.size === 1 ? '' : 's'}
          </div>
        </a>
      </div>
      <div class="split">
        <section class="card">
          <div class="card-h">
            <h2>${icon('alert')}Needs attention</h2>
            <span class="faint small"
              >${attention.length} item${attention.length === 1 ? '' : 's'}</span
            >
          </div>
          <div class="list">
            ${attention.length === 0
              ? html`<p class="empty">Nothing needs attention. Every line holds.</p>`
              : attention.map(
                  (item) =>
                    html`<a class="row row-go" href="${item.href}">
                      <span class="row-ic ${item.tone}">${icon(item.icon)}</span>
                      <span class="row-main">
                        <span class="row-title">${item.title}</span>
                        <span class="row-meta">${item.detail}</span>
                      </span>
                      <span class="row-side faint small">${item.action}${icon('chevron')}</span>
                    </a>`,
                )}
          </div>
        </section>
        <section class="card">
          <div class="card-h">
            <h2>${icon('audit')}Recent activity</h2>
            <a class="small" href="/audit">Audit log</a>
          </div>
          <div class="list audit">
            ${view.audit.length === 0
              ? html`<p class="empty">No entries yet.</p>`
              : view.audit.map(auditRow)}
          </div>
        </section>
      </div>
      <div class="section-h">
        <h2>${icon('workspaces')}Workspaces</h2>
        <a class="small" href="/workspaces">Manage</a>
      </div>
      <div class="list">
        ${view.installations.length === 0
          ? html`<p class="empty">
              No workspace yet. <a href="/slack/install">Add to Slack</a> to install the bot.
            </p>`
          : view.installations.map(
              (row) =>
                html`<div class="row">
                  <span class="row-ic">${initials(teamName(row))}</span>
                  <div class="row-main">
                    <div class="row-title">
                      ${row.hasToken
                        ? html`<a href="/workspaces/${row.teamId}/channels">${teamName(row)}</a>`
                        : html`<span>${teamName(row)}</span>`}
                    </div>
                    <div class="row-meta">
                      <span class="id">${row.teamId}</span
                      ><span>${channelCounts.get(row.teamId) ?? 0} channels</span>
                    </div>
                  </div>
                  <div class="row-side">${workspaceLamp(row, false)}</div>
                </div>`,
            )}
      </div>`,
    {
      section: 'overview',
      sub: `${view.costs.from} to ${view.costs.to} (UTC), last 7 days`,
      actions: html`<a class="button quiet" href="/slack/install">${icon('plus')}Add to Slack</a>`,
    },
  );
}
