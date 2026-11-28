/** Socket Mode routing with acknowledgment after durable native intake. */
import { isChannelMember } from './membership.js';
import type { Dispatcher } from 'undici';
import { SocketModeClient, LogLevel } from '@slack/socket-mode';
import { decideMention, type MentionEvent } from './intake.js';
import type { Installation, InstallationLookup } from './installations.js';
import type { StageLogger } from './logger.js';

/** A human mention from a workspace the adapter does not serve. */
export interface UnusableMention {
  channel: string;
  user: string;
  threadTs: string;
}

export interface EnvelopeArgs {
  type: string;
  ack(response?: unknown): Promise<void>;
  body: unknown;
  retry_num?: number;
  retry_reason?: string;
}

export interface ReceiverDeps {
  appToken: string;
  log: StageLogger;
  /** Whitelisted, verified installations by team. */
  installations: InstallationLookup;
  /**
   * Called (not awaited) for an envelope from a team without a usable
   * installation; the registry reports it to the admin service.
   */
  reportSeen?: (teamId: string) => void;
  /**
   * Called (not awaited, after the ack) for a human mention in a team
   * without a usable installation: tells that person privately why the bot
   * does not answer, when the workspace is paired but not whitelisted.
   */
  notifyUnusable?: (teamId: string, mention: UnusableMention) => void;
  command?: (
    event: MentionEvent,
    eventId: string | undefined,
    installation: Installation,
    ack: () => Promise<void>,
  ) => Promise<boolean>;
  /** Records or ignores an ordinary thread reply before acknowledging Slack. */
  reply?: (
    event: MentionEvent,
    eventId: string | undefined,
    installation: Installation,
  ) => Promise<void>;
  /** Accepts a mention durably before Slack acknowledgment. */
  intake: (
    event: MentionEvent,
    eventId: string | undefined,
    installation: Installation,
  ) => Promise<void>;
  /**
   * Bounded connection-state observations (PR-4): the SDK lifecycle events
   * are the source of truth; the tracker only records the transition.
   */
  connection?: { transitioned(state: 'connected' | 'reconnecting' | 'disconnected'): void };
  /**
   * Message-button clicks (`interactive` envelopes). The handler owns the
   * acknowledgment (after durable recording). Undefined acknowledges and
   * ignores every interaction.
   */
  interaction?: (envelope: EnvelopeArgs, installation: Installation) => Promise<void>;
  /**
   * Extra options for the Socket Mode client's internal Web API client.
   * Test-only: `slackApiUrl` points apps.connections.open at a fake Slack
   * server during automated container verification.
   */
  clientOptions?: { slackApiUrl?: string };
  /** The egress proxy's CONNECT dispatcher, for apps.connections.open and the websocket alike. */
  dispatcher?: Dispatcher;
}

export interface ReceiverHandle {
  client: SocketModeClient;
  start(): Promise<unknown>;
  stop(): Promise<void>;
}

export function createSocketModeReceiver(deps: ReceiverDeps): ReceiverHandle {
  const client = new SocketModeClient({
    appToken: deps.appToken,
    logLevel: LogLevel.INFO,
    ...(deps.clientOptions !== undefined ? { clientOptions: deps.clientOptions } : {}),
    ...(deps.dispatcher !== undefined ? { dispatcher: deps.dispatcher } : {}),
  });
  let stopping = false;
  const lifecycle = createLifecycleLogger(deps.log, { isShuttingDown: () => stopping });
  client.on('connected', () => {
    deps.connection?.transitioned('connected');
    lifecycle.connected();
  });
  client.on('reconnecting', () => {
    deps.connection?.transitioned('reconnecting');
    lifecycle.reconnecting();
  });
  client.on('disconnected', () => {
    deps.connection?.transitioned('disconnected');
    lifecycle.disconnected();
  });
  client.on('error', lifecycle.error);
  client.on('slack_event', (args: EnvelopeArgs) => {
    // Intentionally not awaited: the client dispatches events as they arrive.
    void handleEnvelope(args, deps).catch((err: unknown) => {
      deps.log.error(`envelope processing failed: ${safeSummary(err)}`);
    });
  });
  return {
    client,
    start: () => client.start(),
    stop: async () => {
      stopping = true;
      await client.disconnect();
    },
  };
}

/**
 * Processes one Socket Mode envelope. Envelopes from a team without a
 * usable installation are reported, acknowledged and dropped. `interactive`
 * envelopes (button clicks) go to the interaction handler, which
 * acknowledges after durable recording. Otherwise acknowledges:
 * - other non-events envelopes and non-app_mention events immediately,
 * - ignored mentions immediately (filtering decision, nothing to persist),
 * - relevant mentions only after durable intake succeeded.
 * A relevant mention that fails intake is NOT acknowledged.
 */
export async function handleEnvelope(args: EnvelopeArgs, deps: ReceiverDeps): Promise<void> {
  if (args.type === 'interactive' && deps.interaction !== undefined) {
    const body = args.body as
      { team?: { id?: unknown }; user?: { id?: string }; channel?: { id?: string } } | undefined;
    const installation = resolveInstallation(body?.team?.id, 'interaction', deps);
    if (installation === undefined) {
      await args.ack();
      return;
    }
    // The admin checks modal sessions against current requester membership.
    if (
      body?.channel?.id &&
      !(await isChannelMember(installation, body.channel.id, body.user?.id ?? ''))
    ) {
      await args.ack();
      return;
    }
    await deps.interaction(args, installation);
    return;
  }
  if (args.type !== 'events_api') {
    await args.ack();
    return;
  }
  const payload = args.body as
    | {
        type?: string;
        event?: MentionEvent;
        event_id?: unknown;
        team_id?: unknown;
        authorizations?: Array<{ team_id?: string }>;
      }
    | undefined;
  const event = payload?.event;
  if (payload?.type !== 'event_callback' || event === undefined || typeof event !== 'object') {
    await args.ack();
    return;
  }
  const eventId = typeof payload.event_id === 'string' ? payload.event_id : undefined;
  // In Connect, the actor's team is not the installation's authorization
  // scope. Use Slack's installation authorizations when provided. Refuse an
  // ambiguous envelope rather than route it to an arbitrary workspace.
  const authorized = payload.authorizations
    ?.map((row) => row.team_id)
    .filter(
      (team): team is string =>
        typeof team === 'string' && deps.installations.get(team) !== undefined,
    );
  const teams = authorized ? [...new Set(authorized)] : null;
  const eventTeam =
    teams === null
      ? payload.team_id
      : teams.includes(String(payload.team_id))
        ? payload.team_id
        : teams.length === 1
          ? teams[0]
          : undefined;
  const installation = resolveInstallation(eventTeam, 'event', deps);
  if (installation === undefined) {
    await args.ack();
    const mention = unusableMention(event);
    if (mention !== null && typeof payload.team_id === 'string') {
      deps.notifyUnusable?.(payload.team_id, mention);
    }
    return;
  }
  if (event.type !== 'app_mention') {
    if (event.type === 'message') {
      if (deps.reply !== undefined) {
        try {
          await deps.reply(event, eventId, installation);
        } catch (err) {
          deps.log.error(
            `thread reply not recorded; envelope not acknowledged event_id=${eventId ?? 'n/a'}: ${safeSummary(err)}`,
          );
          return;
        }
      }
    }
    await args.ack();
    return;
  }
  const decision = decideMention(event, installation.identity);
  if (decision.kind === 'ignore') {
    deps.log.info(`ignoring mention (${decision.reason}) event_id=${eventId ?? 'n/a'}`);
    await args.ack();
    return;
  }
  if (!(await isChannelMember(installation, event.channel, event.user ?? ''))) {
    deps.log.info('ignoring mention (actor is not a channel member)');
    await args.ack();
    return;
  }
  if (deps.command && (await deps.command(event, eventId, installation, () => args.ack()))) return;
  const retryNote =
    typeof args.retry_num === 'number' && args.retry_num > 0 ? ` retry_num=${args.retry_num}` : '';
  try {
    await deps.intake(event, eventId, installation);
    await args.ack();
  } catch (err) {
    deps.log.error(
      `intake failed; envelope not acknowledged${retryNote} event_id=${eventId ?? 'n/a'}: ${safeSummary(err)}`,
    );
  }
}

/**
 * The envelope team's usable installation. A missing team, or a team that
 * is not whitelisted or not verified, is logged by ID, reported (valid team
 * IDs only). The caller acknowledges and drops.
 */
function resolveInstallation(
  teamId: unknown,
  kind: 'event' | 'interaction',
  deps: ReceiverDeps,
): Installation | undefined {
  const team = typeof teamId === 'string' && /^T[A-Z0-9]{1,31}$/.test(teamId) ? teamId : null;
  const installation = team === null ? undefined : deps.installations.get(team);
  if (installation !== undefined) return installation;
  deps.log.info(
    `ignoring ${kind} from ${team === null ? 'a missing or malformed workspace' : `unknown or unusable workspace team=${team}`}`,
  );
  if (team !== null) deps.reportSeen?.(team);
  return undefined;
}

/** A human app_mention in a channel, or null (bots never get the notice). */
function unusableMention(event: MentionEvent): UnusableMention | null {
  if (
    event.type !== 'app_mention' ||
    event.bot_id !== undefined ||
    event.subtype !== undefined ||
    event.user === undefined ||
    event.ts === undefined ||
    !/^[CG][A-Z0-9]+$/.test(event.channel)
  ) {
    return null;
  }
  return { channel: event.channel, user: event.user, threadTs: event.thread_ts ?? event.ts };
}

function safeSummary(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.length > 200 ? `${err.message.slice(0, 200)}...` : err.message;
    return `${err.name}: ${message}`;
  }
  return 'unknown error';
}

export interface LifecycleLogger {
  connected(): void;
  reconnecting(): void;
  disconnected(): void;
  error(err: unknown): void;
}

export function createLifecycleLogger(
  log: StageLogger,
  opts: { isShuttingDown?: () => boolean } = {},
): LifecycleLogger {
  return {
    connected: () => log.info('socket connected'),
    reconnecting: () => log.warn('connection lost; reconnecting to Slack Socket Mode'),
    disconnected: () => {
      if (opts.isShuttingDown?.() !== true) {
        log.warn('disconnected from Slack Socket Mode (auto-reconnect active)');
      }
    },
    error: (err) => log.error(`socket error: ${safeSummary(err)}`),
  };
}
