/** Deterministic commands and private Configure UI; no task/model admission. */
import {
  classifyChannelCommand,
  COMMAND_RECEIPT_TYPE,
  type CommandReceiptTable,
} from './generated/channel-commands.js';
import type { Installation, InstallationLookup } from './installations.js';
import type { MentionEvent } from './intake.js';
import type { EnvelopeArgs } from './receiver.js';
import { fetchRepliesPage, openView, postEphemeral, SlackPostError } from './slackclient.js';

export const CONFIGURE_ACTION = 'support_agent_configure_channel';
export const CONFIGURE_CALLBACK = 'support_agent_channel_settings';
interface Draft {
  session: string;
  model: string | null;
  prompt: string | null;
  /** "Automatic thread replies" (default on). */
  autoReplies: boolean;
  keys: string[];
  workspaceModel: string | null;
  workspacePrompt: string | null;
}
interface Receipt {
  id: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  body: string;
  table?: CommandReceiptTable;
  reconcile: boolean;
  lease: string;
}
class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class CommandClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}
  async request<T>(route: string, body: unknown, timeout = 2000): Promise<T> {
    const response = await fetch(`${this.url}/internal/channel-commands/${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok)
      throw new CommandError(
        response.status,
        typeof data.error === 'string' ? data.error : 'Command service unavailable.',
      );
    return data as T;
  }
}
export function splitPrompt(text: string): [string, string] {
  let split = Math.min(3000, text.length);
  if (split > 0 && /[\uD800-\uDBFF]/.test(text[split - 1]!)) split--;
  return [text.slice(0, split), text.slice(split)];
}
const plain = (text: string) => ({ type: 'plain_text' as const, text, emoji: false });
const AUTO_REPLIES_OPTION = {
  text: plain('Answer clear follow-ups in threads I was mentioned in'),
  // Slack limits an option description to 150 characters (views.open
  // refuses the whole modal otherwise); the full explanation is in the
  // modal's section text.
  description: plain(
    'Never at channel top level. Off also stops joined threads; mentions always work.',
  ),
  value: 'on',
};
export function configureModal(draft: Draft): unknown {
  const [first, second] = splitPrompt(draft.prompt ?? '');
  const option = (value: string, text = value) => ({ text: plain(text), value });
  const keys =
    draft.model && !draft.keys.includes(draft.model) ? [...draft.keys, draft.model] : draft.keys;
  const models = [
    option('inherit', 'Inherit'),
    ...keys.map((k) => option(k, draft.keys.includes(k) ? k : `${k} (unavailable)`)),
  ];
  const field = (id: string, label: string, element: unknown, optional = false) => ({
    type: 'input',
    block_id: id,
    label: plain(label),
    element,
    optional,
  });
  return {
    type: 'modal',
    callback_id: CONFIGURE_CALLBACK,
    private_metadata: draft.session,
    title: plain('Configure channel'),
    submit: plain('Save'),
    close: plain('Cancel'),
    blocks: [
      {
        type: 'section',
        text: plain(
          `Changes apply to later runs. Inherited model: ${draft.workspaceModel ?? 'deployment default'}. Enter a prompt to override the workspace prompt. Leave both prompt fields empty to inherit it. The two text parts are joined exactly (4,000 units combined). Automatic thread replies: after someone mentions me in a thread, I answer clear follow-ups there without a new mention and stay quiet during discussion.`,
        ),
      },
      field(
        'replies',
        'Automatic thread replies',
        {
          type: 'checkboxes',
          action_id: 'value',
          options: [AUTO_REPLIES_OPTION],
          ...(draft.autoReplies ? { initial_options: [AUTO_REPLIES_OPTION] } : {}),
        },
        true,
      ),
      field('model', 'Model', {
        type: 'static_select',
        action_id: 'value',
        options: models,
        initial_option: models.find((o) => o.value === draft.model) ?? models[0],
      }),
      field(
        'part1',
        'Prompt — first part',
        {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          max_length: 3000,
          ...(first ? { initial_value: first } : {}),
        },
        true,
      ),
      field(
        'part2',
        'Prompt — continued',
        {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          max_length: 3000,
          ...(second ? { initial_value: second } : {}),
        },
        true,
      ),
    ],
  };
}
export class ChannelCommandHandler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private pendingReceipt: Promise<void> | undefined;
  constructor(
    private readonly client: CommandClient,
    private readonly installations: InstallationLookup,
    private readonly warn: (message: string) => void,
  ) {}
  async mention(
    event: MentionEvent,
    eventId: string | undefined,
    installation: Installation,
    ack: () => Promise<void>,
  ): Promise<boolean> {
    if (classifyChannelCommand(event.text ?? '', installation.identity.botUserId) === null)
      return false;
    let outcome: { kind: string; grant?: string };
    try {
      outcome = await this.client.request('execute', {
        teamId: installation.identity.teamId,
        channelId: event.channel,
        userId: event.user,
        messageTs: event.ts,
        threadTs: event.thread_ts,
        eventId,
        text: event.text,
      });
    } catch (error) {
      if (!(error instanceof CommandError) || error.status >= 500) throw error;
      await ack();
      await this.privateReply(
        installation,
        event.channel,
        event.user!,
        error.message,
        event.thread_ts,
      );
      return true;
    }
    await ack();
    if (outcome.kind === 'configure') {
      await this.privateReply(
        installation,
        event.channel,
        event.user!,
        'Configure this channel. This private entry expires in 15 minutes; send !config again if it disappears.',
        event.thread_ts,
        [
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: CONFIGURE_ACTION,
                text: plain('Configure channel'),
                value: outcome.grant,
              },
            ],
          },
        ],
      );
    }
    return true;
  }
  private async privateReply(
    installation: Installation,
    channel: string,
    user: string,
    text: string,
    thread?: string,
    blocks?: unknown[],
  ): Promise<void> {
    try {
      await postEphemeral(installation.slack, {
        channel,
        user,
        text,
        ...(thread ? { thread_ts: thread } : {}),
        ...(blocks ? { blocks } : {}),
      });
    } catch {
      this.warn('Private command response could not be delivered; reissue the command.');
    }
  }
  async interaction(envelope: EnvelopeArgs, installation: Installation): Promise<boolean> {
    const b = envelope.body as {
      type?: string;
      user?: { id?: string };
      team?: { id?: string };
      channel?: { id?: string };
      container?: { is_ephemeral?: boolean; channel_id?: string; thread_ts?: string };
      trigger_id?: string;
      actions?: Array<{ action_id?: string; value?: string }>;
      view?: {
        callback_id?: string;
        private_metadata?: string;
        state?: {
          values?: Record<
            string,
            Record<
              string,
              {
                value?: string | null;
                selected_option?: { value?: string };
                selected_options?: Array<{ value?: string }>;
              }
            >
          >;
        };
      };
    };
    const action = b.actions?.find((a) => a.action_id === CONFIGURE_ACTION);
    const submission = b.type === 'view_submission' && b.view?.callback_id === CONFIGURE_CALLBACK;
    if (!action && !submission) return false;
    const team = installation.identity.teamId,
      actor = b.user?.id;
    if (b.team?.id !== team || !actor) {
      await envelope.ack();
      return true;
    }
    if (submission) {
      const fields = b.view?.state?.values;
      const selected = (name: string) => fields?.[name]?.value?.selected_option?.value;
      try {
        await this.client.request(
          'save',
          {
            teamId: team,
            userId: actor,
            session: b.view?.private_metadata,
            model: selected('model') === 'inherit' ? null : selected('model'),
            part1: fields?.part1?.value?.value ?? '',
            part2: fields?.part2?.value?.value ?? '',
            autoReplies: (fields?.replies?.value?.selected_options ?? []).some(
              (option) => option.value === 'on',
            ),
            deadline: Date.now() + 1800,
          },
          2200,
        );
        await envelope.ack();
      } catch (error) {
        const message =
          error instanceof CommandError
            ? error.message
            : 'Save outcome unknown. Check the public receipt, then retry this same form.';
        await envelope.ack({
          response_action: 'errors',
          errors: { part1: message.slice(0, 500) },
        });
      }
      return true;
    }
    const channel = b.channel?.id;
    if (
      !channel ||
      b.container?.is_ephemeral !== true ||
      b.container.channel_id !== channel ||
      !b.trigger_id ||
      !action?.value
    ) {
      await envelope.ack();
      return true;
    }
    let acknowledged = false;
    try {
      const draft = await this.client.request<Draft>(
        'open',
        { teamId: team, channelId: channel, userId: actor, grant: action.value },
        1500,
      );
      await envelope.ack();
      acknowledged = true;
      await openView(installation.slack, b.trigger_id, configureModal(draft));
    } catch (error) {
      if (!acknowledged) await envelope.ack();
      // Bounded outcome only (the Slack error summary, never the view or a token).
      if (error instanceof SlackPostError)
        this.warn(
          `Configure channel: views.open failed (${error.failure.kind}: ${error.failure.summary.slice(0, 120)})`,
        );
      await this.privateReply(
        installation,
        channel,
        actor,
        error instanceof CommandError
          ? error.message
          : error instanceof SlackPostError && error.failure.kind === 'definite'
            ? 'Slack refused the configuration form. Nothing was changed; please report this to the operator.'
            : 'Could not open configuration in time; try the button again.',
        b.container.thread_ts,
      );
    }
    return true;
  }
  start(): void {
    this.stopped = false;
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pendingReceipt?.catch(() => {});
  }
  private async tick(): Promise<void> {
    const attempt = this.deliverOne();
    this.pendingReceipt = attempt;
    try {
      await attempt;
    } catch {
      this.warn('Command receipt delivery deferred; durable state retained.');
    } finally {
      this.pendingReceipt = undefined;
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), 1000);
  }
  async deliverOne(): Promise<void> {
    const receipt = await this.client.request<Receipt | null>('claim-receipt', {});
    if (!receipt) return;
    const installation = this.installations.get(receipt.teamId);
    if (!installation?.slack.receiptWebClient) return; // Lease expires; re-enable resumes reconciliation.
    const receiptSlack = { ...installation.slack, webClient: installation.slack.receiptWebClient };
    const authorized = async () =>
      (
        await this.client.request<{ ok: boolean }>('authorize-receipt', {
          id: receipt.id,
          lease: receipt.lease,
        })
      ).ok;
    const report = (state: string, ts?: string, retryAfterMs?: number) =>
      this.client.request('report-receipt', {
        id: receipt.id,
        lease: receipt.lease,
        state,
        ts,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    try {
      if (receipt.reconcile) {
        let cursor: string | undefined;
        let complete = false;
        for (let page = 0; page < 20; page++) {
          if (!(await authorized())) return;
          const replies = await fetchRepliesPage(receiptSlack, {
            channel: receipt.channelId,
            rootTs: receipt.threadTs,
            cursor,
            limit: 100,
          });
          const match = replies.messages.find(
            (m) =>
              m.commandReceiptId === receipt.id &&
              (m.user === installation.identity.botUserId ||
                m.bot_id === installation.identity.botId),
          );
          if (match) {
            await report('delivered', match.ts);
            return;
          }
          if (replies.isLimited) break;
          cursor = replies.nextCursor;
          if (!cursor) {
            complete = true;
            break;
          }
        }
        if (!complete) {
          await report('uncertain');
          return;
        }
      }
      if (!(await authorized())) return;
      const result = await receiptSlack.webClient.chat.postMessage({
        channel: receipt.channelId,
        thread_ts: receipt.threadTs,
        text: receipt.table ? receipt.body : 'Channel command receipt.',
        blocks: receiptBlocks(receipt),
        parse: 'none',
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
        metadata: { event_type: COMMAND_RECEIPT_TYPE, event_payload: { receiptId: receipt.id } },
      });
      const ts = result.ts ?? result.message?.ts;
      if (typeof ts !== 'string') throw new Error('Missing receipt timestamp');
      await report('delivered', ts);
    } catch (error) {
      const retryAfter = (error as { retryAfter?: unknown })?.retryAfter;
      await report(
        'uncertain',
        undefined,
        error instanceof SlackPostError && error.failure.kind === 'rate_limited'
          ? error.failure.retryAfterMs
          : typeof retryAfter === 'number'
            ? retryAfter * 1000
            : undefined,
      );
    }
  }
}

/** raw_text cells keep saved notes literal, including Slack markup and mentions. */
export function receiptBlocks(receipt: Pick<Receipt, 'body' | 'table'>) {
  const heading = { type: 'section', text: plain(receipt.body) };
  if (!receipt.table?.rows.length) return [heading];
  return [
    heading,
    {
      type: 'table',
      column_settings: [{ is_wrapped: false }, { is_wrapped: true }, { is_wrapped: true }],
      rows: [['ID', 'Note', 'Last confirmed'], ...receipt.table.rows].map((row) =>
        row.map((text) => ({ type: 'raw_text', text })),
      ),
    },
  ];
}
