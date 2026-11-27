import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { InstallationRegistry, type Installation } from './installations.js';
import { createStageLogger } from './logger.js';
import { configureOutbound, createOutboundAgent } from './outbound.js';
import { createSocketModeReceiver } from './receiver.js';
import { decideMention, type MentionEvent } from './intake.js';
import {
  createNativeAgentAdapter,
  nativeAgentSender,
  nativeThreadReply,
  NativeAgentRefusal,
} from './native-agents.js';
import { nativeInputHandler } from './native-inputs.js';
import { sendNativeExports } from './native-exports.js';
import { sendAnswerFile } from './long-answer.js';
import { SLACK_MARKDOWN_CHARS } from './generated/long-answer.js';
import { assertPrivateWorkspaceChannel } from './file-upload.js';
import { isChannelMember } from './membership.js';
import { readLinkedMessage, readThreadContext } from './message-reads.js';
import { fetchRepliesPage, postEphemeral, addReaction } from './slackclient.js';
import { buildTaskKey, parseTaskKey, type TaskIdentity } from './taskkey.js';
import { ChannelCommandHandler, CommandClient } from './channel-commands.js';
import { createReplyDecider, withoutAttribution, type ThreadMessage } from './reply-decider.js';
import { flattenMessageContent } from './generated/slack-message-content.js';

const STEP_MEMBERSHIP_MS = 60_000;
const STEP_MEMBERSHIP_ENTRIES = 10_000;
const REQUEST_CONTROL = /^(continue(?:\s|$)|cancel$|status$)/i;

function controlText(request: { text: string; canonicalText: string }) {
  return withoutAttribution(
    request.text ? flattenMessageContent({ text: request.text }) : request.canonicalText,
  );
}

async function resumeQuestion(
  adapter: ReturnType<typeof createNativeAgentAdapter>,
  who: { runId: string; owner: string; actor: string },
  answer: string,
) {
  const inspected = (await adapter.inspect(who)) as { suspended?: { toolCallId: string } };
  if (!inspected.suspended) return false;
  await adapter.resume({ ...who, toolCallId: inspected.suspended.toolCallId, answer });
  return true;
}

class NativeTransportRefusal extends Error {
  constructor(readonly code: string) {
    super('native request refused');
  }
}

export function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value || /^(<|placeholder|change-?me)/i.test(value)) throw new Error(`${name} required`);
  return value;
}
export function privateUrl(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('invalid private service URL');
  return url.origin;
}

export async function startNativeAdapter(env: NodeJS.ProcessEnv, shutdown?: AbortSignal) {
  const token = required(env, 'SERVICE_TOKEN');
  const baseUrl = privateUrl(required(env, 'NATIVE_APPLICATION_URL'));
  const log = createStageLogger('native-adapter');
  const decideReply = createReplyDecider(env);
  configureOutbound(env.EGRESS_PROXY_URL);
  const agent = createOutboundAgent(env.EGRESS_PROXY_URL);
  const installations = new InstallationRegistry({
    adminUrl: privateUrl(required(env, 'ADMIN_URL')),
    adminToken: required(env, 'ADMIN_INTERNAL_TOKEN'),
    pollIntervalMs: 2000,
    slackApiUrl: env.SLACK_API_URL,
    boundedReadRetries: true,
    agent,
    log,
  });
  const commands = new ChannelCommandHandler(
    new CommandClient(
      privateUrl(required(env, 'ADMIN_URL')),
      required(env, 'ADMIN_INTERNAL_TOKEN'),
    ),
    installations,
    (message) => log.warn(message),
  );
  const pending = new Set<Promise<unknown>>();
  const presentations = new Map<string, Promise<unknown>>();
  let stopping = false;
  let connected = false;
  let receiver: ReturnType<typeof createSocketModeReceiver> | undefined;
  let closing: Promise<void> | undefined;
  function track<T>(work: Promise<T>) {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  const transport = async (path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(path === '/agents/present' ? 900000 : 180000),
    });
    if (!response.ok) {
      if (response.status === 409) {
        const refusal = (await response.json()) as { error?: string };
        if (typeof refusal.error === 'string') throw new NativeTransportRefusal(refusal.error);
      }
      throw new Error(`native transport refused (${response.status})`);
    }
    return response.json();
  };
  function resolve(identity: TaskIdentity) {
    buildTaskKey(identity);
    const installation = installations.get(identity.teamId);
    if (
      !installations.synced ||
      !installation ||
      installation.identity.installationId !== identity.installationId
    )
      throw new Error('current installation unavailable');
    return installation;
  }
  const stepMembers = new Map<string, number>();
  async function stepMember(
    installation: Installation,
    identity: TaskIdentity & { userId: string },
  ) {
    const key = `${identity.teamId}:${identity.installationId}:${identity.channelId}:${identity.userId}`;
    const now = Date.now();
    if ((stepMembers.get(key) ?? 0) > now) return true;
    stepMembers.delete(key);
    if (!(await isChannelMember(installation, identity.channelId, identity.userId))) return false;
    if (stepMembers.size >= STEP_MEMBERSHIP_ENTRIES)
      for (const [k, until] of stepMembers) if (until <= now) stepMembers.delete(k);
    stepMembers.set(key, now + STEP_MEMBERSHIP_MS);
    return true;
  }
  async function authority(
    identity: TaskIdentity & { userId: string; messageTs?: string; authorBotId?: string | null },
    reuseMembership = false,
  ) {
    const installation = resolve(identity);
    await assertPrivateWorkspaceChannel(installation.slack, identity.channelId);
    const member = reuseMembership
      ? await stepMember(installation, identity)
      : await isChannelMember(installation, identity.channelId, identity.userId);
    if (!member) throw new Error('requester membership revoked');
    let cursor: string | undefined;
    let root = false,
      source = identity.messageTs === undefined;
    for (let page = 0; page < 10; page++) {
      const history = await fetchRepliesPage(installation.slack, {
        channel: identity.channelId,
        rootTs: identity.rootTs,
        limit: 100,
        cursor,
      });
      if (history.isLimited) throw new Error('source authority incomplete');
      for (const message of history.messages) {
        // A deleted root with replies stays in the thread as a tombstone.
        if (message.ts === identity.rootTs && message.subtype !== 'tombstone') root = true;
        if (message.ts === identity.messageTs) {
          if (
            message.user !== identity.userId ||
            (message.bot_id ?? null) !== (identity.authorBotId ?? null)
          )
            throw new Error('source author changed');
          source = true;
        }
      }
      cursor = history.nextCursor;
      if (!cursor || (root && source)) break;
    }
    if (!root || !source || resolve(identity) !== installation)
      throw new Error('source/root authority unavailable');
    return installation;
  }
  function present(
    handle: { runId: string; owner: string; duplicate?: boolean },
    actor: string,
    working?: { event: MentionEvent; installation: Installation },
  ) {
    const key = `${handle.runId}:${handle.owner}`;
    if (presentations.has(key)) return presentations.get(key)!;
    const work = track(
      (async () => {
        const reaction =
          working && !handle.duplicate && working.event.ts
            ? {
                channel: working.event.channel,
                timestamp: working.event.ts,
                name: 'hourglass_flowing_sand',
              }
            : undefined;
        try {
          if (reaction)
            await addReaction(working!.installation.slack, reaction).catch(() =>
              log.warn('working indication unavailable'),
            );
          return await transport('/agents/present', { ...handle, actor });
        } finally {
          if (reaction)
            await working!.installation.slack.webClient.reactions
              .remove(reaction)
              .catch(() => log.warn('working indication removal unconfirmed'));
        }
      })()
        .catch((error) => {
          // No automatic resend after an unknown external result. An explicit
          // `status` mention can inspect/present under the service's one-shot receipt.
          log.warn(
            `native presentation unavailable run_id=${handle.runId} reason=${error instanceof NativeTransportRefusal ? error.code : error instanceof Error ? error.name : 'unknown'}; retained state requires explicit status`,
          );
        })
        .finally(() => presentations.delete(key)),
    );
    presentations.set(key, work);
    return work;
  }
  const inputs = nativeInputHandler({ token, installations });
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((req, res) => {
    void track(handle(req, res));
  });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (await inputs(req, res)) return;
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/native-authority/ready') {
        if (!installations.synced) throw new Error('admin unavailable');
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, installations: installations.size }));
        return;
      }
      if (
        req.method === 'GET' &&
        ['/healthz', '/readyz', '/native/status'].includes(req.url ?? '')
      ) {
        const application = await transport('/native/status');
        const ok = !stopping && connected && installations.synced;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ok,
            runtime: 'native-answer',
            pending: pending.size - 1,
            application,
          }),
        );
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > (req.url === '/native-delivery' ? 12 * 1024 ** 2 : 256000))
          throw new Error('body bounds');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown;
      if (req.url === '/native-authority/check') {
        await authority(body, true);
        result = { ok: true };
      } else if (req.url === '/native-messages/linked' || req.url === '/native-messages/thread') {
        // The origin thread's authority first: it names the requester, whose
        // membership the read checks for the channel it reads.
        const identity = body.identity;
        if (typeof identity?.messageTs !== 'string') throw new Error('message read origin refused');
        const installation = await authority(identity);
        result = req.url.endsWith('/linked')
          ? await readLinkedMessage(installation, identity, body.link)
          : await readThreadContext(installation, identity, body.after ?? null);
        if (resolve(identity) !== installation) throw new Error('installation replaced');
      } else if (req.url === '/native-delivery') {
        const identity = parseTaskKey(body.taskKey);
        if (
          !identity ||
          identity.channelId !== body.channel ||
          identity.rootTs !== body.rootTs ||
          typeof body.text !== 'string' ||
          Buffer.byteLength(body.text) > 48000 ||
          // Slack refuses a longer markdown block; long answers come as preview and file.
          (body.answerFile === undefined && body.text.length > SLACK_MARKDOWN_CHARS) ||
          (body.footer !== undefined && typeof body.footer !== 'string')
        )
          throw new Error('delivery identity refused');
        const installation = await authority({ ...identity, userId: body.requesterUserId });
        const check = async () => {
          await authority({ ...identity, userId: body.requesterUserId });
          if (!body.authority || body.authority.actor !== body.requesterUserId)
            throw new Error('export authority missing');
          await transport('/agents/delivery-authority', {
            ...body.authority,
            operationId: body.operationId,
          });
        };
        const files = body.files?.length
          ? await sendNativeExports(installation.slack, body, check, undefined, async (receipt) => {
              await transport('/agents/export-receipt', {
                ...body.authority,
                operationId: body.operationId,
                receipt,
              });
            })
          : [];
        // A long answer: the full answer file first, then the preview message,
        // which says whether the file is attached. A failed upload still posts.
        const answerFile = body.answerFile
          ? await sendAnswerFile(
              installation.slack,
              {
                file: body.answerFile,
                preview: body.text,
                channel: body.channel,
                rootTs: body.rootTs,
              },
              check,
            )
          : undefined;
        if (files.length || answerFile) await check();
        result = {
          ...(await nativeAgentSender(installation.slack)({
            ...body,
            answerFileReceipt: answerFile,
          })),
          ...(files.length ? { files } : {}),
          ...(answerFile ? { answerFile } : {}),
        };
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      if (!res.headersSent) res.writeHead(503).end('{"error":"native_adapter_unavailable"}');
      else res.destroy();
    }
  }
  const close = () =>
    (closing ??= (async () => {
      stopping = true;
      await receiver?.stop();
      await commands.stop();
      while (pending.size) await Promise.allSettled([...pending]);
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      installations.stop();
      await installations.settled();
      agent?.destroy();
    })());
  try {
    await installations.syncOnce();
    await installations.settled();
    if (!installations.synced) throw new Error('authenticated installations unavailable');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(
        Number(required(env, 'NATIVE_ADAPTER_PORT')),
        env.NATIVE_BIND_HOST ?? '0.0.0.0',
        resolve,
      );
    });
    receiver = createSocketModeReceiver({
      appToken: required(env, 'SLACK_APP_TOKEN'),
      log,
      installations,
      connection: {
        transitioned: (state) => {
          connected = state === 'connected';
        },
      },
      clientOptions: {
        ...(env.SLACK_API_URL ? { slackApiUrl: env.SLACK_API_URL } : {}),
        ...(agent ? { agent } : {}),
      },
      intake: (event, eventId, installation) => track(intake(event, eventId, installation)),
      command: (event, eventId, installation, ack) =>
        track(commands.mention(event, eventId, installation, ack)),
      interaction: (envelope, installation) =>
        track(
          (async () => {
            if (!(await commands.interaction(envelope, installation))) await envelope.ack();
          })(),
        ),
      reply: (event, eventId, installation) =>
        track(
          (async () => {
            const normalized = nativeThreadReply(event, installation.identity);
            if (!normalized || !eventId) return;
            const decision = decideMention(normalized, installation.identity);
            if (decision.kind !== 'accept') return;
            // Silence unrelated threads and other participants. The service rechecks
            // current authorization and the owner atomically at admission.
            let current: {
              runId: string;
              owner: string;
              autoReplies: boolean;
              delivered: boolean;
              requester: boolean;
              requesterId: string;
            };
            try {
              current = (await transport('/agents/thread', {
                ...decision.request,
                anyParticipant: Boolean(decideReply),
              })) as typeof current;
            } catch (error) {
              if (
                error instanceof NativeTransportRefusal &&
                ['thread_owner_required', 'origin_revoked', 'authorization_revoked'].includes(
                  error.code,
                )
              )
                return;
              throw error;
            }
            const typed = controlText(decision.request);
            const control = REQUEST_CONTROL.test(typed);
            if (
              current.requester &&
              !current.delivered &&
              !control &&
              typed &&
              !event.files?.length &&
              (await answerQuestion(current, typed, normalized, installation))
            )
              return;
            if (decideReply && current.autoReplies && current.delivered && !control) {
              const verdict = await decideReply(
                decision.request.canonicalText,
                Boolean(event.files?.length),
                current.requester,
                await recentThreadMessages(
                  installation,
                  decision.request.channelId,
                  decision.request.rootTs,
                  decision.request.messageTs,
                  current.requesterId,
                ),
              );
              const detail = `reason=${verdict.reason}${verdict.failure ? ` failure=${verdict.failure}` : ''}${verdict.probability === undefined ? '' : ` p=${verdict.probability.toFixed(3)}`} channel=${event.channel} message_ts=${event.ts}`;
              if (verdict.reason === 'decider_unavailable')
                log.warn(`thread reply decider unavailable; automatic reply skipped ${detail}`);
              else log.info(`automatic reply ${verdict.reply ? 'accepted' : 'skipped'} ${detail}`);
              if (!verdict.reply) return;
            }
            await intake(normalized, eventId, installation, current.owner, !current.requester);
          })(),
        ),
    });
    const deadline = Date.now() + 60000;
    for (;;) {
      shutdown?.throwIfAborted();
      try {
        await transport('/readyz');
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error('native application startup unavailable');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    shutdown?.throwIfAborted();
    await receiver.start();
    installations.start();
    commands.start();
    return { close, port: (server.address() as { port: number }).port };
  } catch (error) {
    await close();
    throw error;
  }

  async function recentThreadMessages(
    installation: Installation,
    channel: string,
    rootTs: string,
    beforeTs: string,
    requesterId: string,
  ): Promise<ThreadMessage[]> {
    const { botId, botUserId } = installation.identity;
    const earlier: ThreadMessage[] = [];
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const replies = await fetchRepliesPage(installation.slack, {
          channel,
          rootTs,
          cursor,
          limit: 200,
        });
        for (const message of replies.messages) {
          if (!message.ts || message.ts >= beforeTs || !message.text) continue;
          earlier.push({
            author:
              message.bot_id === botId || message.user === botUserId
                ? 'assistant'
                : message.user === requesterId
                  ? 'requester'
                  : 'other',
            text: message.text.replaceAll(`<@${botUserId}>`, '@assistant'),
          });
        }
        cursor = replies.nextCursor;
        if (!cursor) break;
      }
    } catch {
      log.warn('thread history for the reply decider unavailable');
    }
    return earlier.slice(-3);
  }

  async function answerQuestion(
    current: { runId: string; owner: string; requesterId: string },
    answer: string,
    event: MentionEvent,
    installation: Installation,
  ) {
    const adapter = createNativeAgentAdapter({
      baseUrl,
      token,
      identity: installation.identity,
      slack: installation.slack,
    });
    const who = { runId: current.runId, owner: current.owner, actor: current.requesterId };
    try {
      if (!(await resumeQuestion(adapter, who, answer))) return false;
    } catch {
      await refuse(installation, event.channel, who.actor, event.thread_ts ?? event.ts);
      return true;
    }
    log.info(`question answered by thread reply run_id=${current.runId} message_ts=${event.ts}`);
    void present(current, who.actor, { event, installation });
    return true;
  }

  async function refuse(installation: Installation, channel: string, user: string, rootTs: string) {
    await postEphemeral(installation.slack, {
      channel,
      user,
      thread_ts: rootTs,
      text: 'Request refused or unavailable. Continue, cancel, and status are available for active threads. No automatic replay.',
    }).catch(() => log.warn('native refusal notice unconfirmed; no automatic resend'));
  }

  async function intake(
    event: MentionEvent,
    eventId: string | undefined,
    installation: Installation,
    expectedOwner?: string,
    anyParticipant = false,
  ) {
    if (stopping || !eventId) throw new Error('native intake unavailable');
    const decision = decideMention(event, installation.identity);
    if (decision.kind !== 'accept') throw new Error('native origin refused');
    const adapter = createNativeAgentAdapter({
      baseUrl,
      token,
      identity: installation.identity,
      slack: installation.slack,
    });
    const command = controlText(decision.request)
      .replace(new RegExp(`<@${installation.identity.botUserId}>`, 'g'), '')
      .trim();
    try {
      if (REQUEST_CONTROL.test(command)) {
        if (event.files?.length) throw new Error('native controls do not accept attachments');
        const current = (await transport('/agents/thread', {
          ...decision.request,
          anyParticipant: true,
          control: /^cancel$/i.test(command)
            ? 'task.cancel'
            : /^continue(?:\s|$)/i.test(command)
              ? 'task.steer'
              : 'task.read',
        })) as { runId: string; owner: string; requesterId: string };
        const who = { runId: current.runId, owner: current.owner, actor: current.requesterId };
        if (/^cancel$/i.test(command)) await adapter.cancel(who);
        else if (/^continue(?:\s|$)/i.test(command)) {
          const answer = command.slice('continue'.length).trim();
          if (!answer) throw new Error('native continuation requires an answer');
          if (!(await resumeQuestion(adapter, who, answer)))
            throw new Error('no native question awaits an answer');
        }
        void present(
          current,
          who.actor,
          /^continue/i.test(command) ? { event, installation } : undefined,
        );
      } else {
        const accepted = (await adapter.mention(event, eventId, expectedOwner, anyParticipant)) as {
          runId: string;
          owner: string;
          duplicate?: boolean;
        };
        // Slack redelivers an event it saw unacknowledged; the service returns
        // the admitted run, and presentation joins it.
        if (accepted.duplicate)
          log.info(`native mention duplicate event_id=${eventId} run_id=${accepted.runId}`);
        void present(accepted, decision.request.userId, { event, installation });
      }
    } catch (error) {
      if (expectedOwner && !REQUEST_CONTROL.test(command) && error instanceof NativeAgentRefusal) {
        log.info(
          `automatic reply refused reason=${error.code} channel=${event.channel} message_ts=${event.ts} event_id=${eventId}`,
        );
        return;
      }
      // Ephemeral refusal is outside durable result delivery. It never claims
      // acceptance or retries a model/tool/send. Contents carry no raw errors.
      await refuse(installation, event.channel, decision.request.userId, decision.request.rootTs);
    }
  }
}

export async function runNativeAdapter(env: NodeJS.ProcessEnv) {
  const current: { handle?: Awaited<ReturnType<typeof startNativeAdapter>> } = {};
  let stopping = false;
  const abort = new AbortController();
  const shutdown = () => {
    stopping = true;
    abort.abort();
    void current.handle?.close().catch(() => {
      process.exitCode = 1;
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
  const handle = await startNativeAdapter(env, abort.signal);
  current.handle = handle;
  if (stopping) await handle.close();
}
