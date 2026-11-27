import { decideMention, type BotIdentity, type MentionEvent } from './intake.js';
import { postMessage, type SlackDeps } from './slackclient.js';
import { fileDescriptors } from './file-descriptors.js';
import { nativeInputFiles } from './generated/native-inputs.js';
import { longAnswerMessage, type AnswerFileReceipt } from './generated/long-answer.js';

/** A current channel preference is a silent routing decision, not a failed request. */
export class AutomaticRepliesDisabledError extends Error {
  constructor() {
    super('automatic_replies_disabled');
  }
}

/** Ordinary thread messages reuse mention identity validation, but never start
 * an unrelated thread or process the message copy of an explicit mention. */
export function nativeThreadReply(event: MentionEvent, identity: BotIdentity): MentionEvent | null {
  if (
    event.type !== 'message' ||
    !event.thread_ts ||
    event.thread_ts === event.ts ||
    (event.subtype && !['file_share', 'bot_message'].includes(event.subtype))
  )
    return null;
  const normalized = { ...event, type: 'app_mention' };
  const decision = decideMention(normalized, identity);
  if (
    decision.kind !== 'accept' ||
    decision.request.canonicalText.includes(`<@${identity.botUserId}>`) ||
    // Reserved channel commands require a direct mention. Never turn an
    // unmentioned command or typo into an automatic model follow-up.
    /^\s*!/.test(decision.request.canonicalText)
  )
    return null;
  return normalized;
}

/** Native agent transport for the authenticated Slack receiver. */
export function createNativeAgentAdapter(options: {
  baseUrl: string;
  token: string;
  identity: BotIdentity;
  slack: SlackDeps;
}) {
  async function call(operation: string, body: unknown) {
    const response = await fetch(`${options.baseUrl}/agents/${operation}`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      if (operation === 'followup' && response.status === 409) {
        const refusal = (await response.json()) as { error?: string };
        if (refusal.error === 'automatic_replies_disabled')
          throw new AutomaticRepliesDisabledError();
      }
      throw new Error(`Native agent ${operation} refused (${response.status})`);
    }
    return response.json();
  }
  return {
    async mention(
      event: MentionEvent,
      eventId: string,
      expectedOwner?: string,
      anyParticipant = false,
    ) {
      const decision = decideMention(event, options.identity);
      if (decision.kind !== 'accept') throw new Error('Mention identity refused');
      const accepted = decision.request;
      const files = nativeInputFiles(
        fileDescriptors(event.files, accepted.messageTs),
        accepted.messageTs,
      );
      return call(expectedOwner ? 'followup' : 'start', {
        ...accepted,
        eventId,
        ...(files.length ? { files } : {}),
        ...(expectedOwner ? { expectedOwner } : {}),
        ...(expectedOwner && anyParticipant ? { anyParticipant } : {}),
      });
    },
    resume(input: {
      runId: string;
      actor: string;
      owner: string;
      toolCallId: string;
      answer: string;
    }) {
      return call('resume', input);
    },
    cancel(input: { runId: string; actor: string; owner: string }) {
      return call('cancel', input);
    },
    result(input: { runId: string; actor: string; owner: string }) {
      return call('result', input);
    },
    inspect(input: { runId: string; actor: string; owner: string }) {
      return call('inspect', input);
    },
    deliver(input: { runId: string; actor: string; owner: string }) {
      return call('deliver', input);
    },
  };
}

/** Reuse Slack's actual rendering, bounded transport and effect metadata. The
 * application service admits this once and retains unknown sends as uncertain. */
export function nativeAgentSender(slack: SlackDeps) {
  return (value: {
    operationId: string;
    taskKey: string;
    channel: string;
    rootTs: string;
    text: string;
    footer?: string;
    /** Set for a long answer: `text` is its preview, the file its full text. */
    answerFileReceipt?: AnswerFileReceipt;
  }) =>
    postMessage(slack, {
      channel: value.channel,
      thread_ts: value.rootTs,
      text: value.answerFileReceipt
        ? longAnswerMessage(value.text, value.answerFileReceipt.attached)
        : value.text,
      footer: value.footer ?? null,
      delivery: {
        operationId: value.operationId,
        answer: true,
        revision: 1,
        ...(value.answerFileReceipt?.attached
          ? {
              resultFiles: [
                { id: value.answerFileReceipt.fileId, sha256: value.answerFileReceipt.sha256 },
              ],
            }
          : {}),
      },
    });
}

/** Receiver integration seam: pass as the existing Socket Mode receiver's
 * `intake`. The receiver already verifies installation and channel membership;
 * the service registers/checks the independent root and current policy itself.
 * No generic coordinator intake/claim/qualification is involved. */
export function nativeAgentIntake(options: { baseUrl: string; token: string }) {
  return async (
    event: MentionEvent,
    eventId: string | undefined,
    installation: import('./installations.js').Installation,
  ): Promise<void> => {
    if (!eventId) throw new Error('Authenticated Slack event ID required');
    await createNativeAgentAdapter({
      ...options,
      identity: installation.identity,
      slack: installation.slack,
    }).mention(event, eventId);
  };
}
