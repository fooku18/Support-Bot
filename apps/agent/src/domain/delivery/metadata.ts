/** Exact delivery receipts used to reconcile Slack writes without replay. */

/**
 * Slack message metadata the adapter attaches to every delivered message
 * (`chat.postMessage`/`chat.update` `metadata`). Invisible to users; read back
 * with `conversations.replies include_all_metadata`. Delivery reconciliation
 * finds the message by `operation_id` and compares `revision`; history
 * recovery uses `answer` to tell answers from status/progress messages.
 */
export const DELIVERY_METADATA_EVENT_TYPE = 'support_agent_delivery';

export interface DeliveryMetadata {
  operationId: string;
  revision: number;
  answer: boolean;
  /** The full answer file of a long answer (Slack file ID and SHA-256). */
  resultFiles?: Array<{ id: string; sha256: string }>;
}

/** Slack `metadata` argument (`event_type` + `event_payload`) for a delivered message. */
export interface SlackDeliveryMetadata {
  event_type: string;
  event_payload: {
    operation_id: string;
    revision: number;
    answer: boolean;
    result_files?: Array<{ id: string; sha256: string }>;
  };
}

/** Slack `metadata` argument for a delivered message. */
export function deliveryMetadata(args: DeliveryMetadata): SlackDeliveryMetadata {
  return {
    event_type: DELIVERY_METADATA_EVENT_TYPE,
    event_payload: {
      operation_id: args.operationId,
      revision: Math.max(0, Math.floor(args.revision)),
      answer: args.answer,
      ...(args.resultFiles?.length ? { result_files: args.resultFiles } : {}),
    },
  };
}

/** Parses delivery metadata from a `conversations.replies` message, or null. */
export function parseDeliveryMetadata(metadata: unknown): DeliveryMetadata | null {
  if (typeof metadata !== 'object' || metadata === null) {
    return null;
  }
  const candidate = metadata as { event_type?: unknown; event_payload?: unknown };
  if (candidate.event_type !== DELIVERY_METADATA_EVENT_TYPE) {
    return null;
  }
  const payload = candidate.event_payload as
    | { operation_id?: unknown; revision?: unknown; answer?: unknown; result_files?: unknown }
    | null
    | undefined;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const { operation_id: operationId, revision, answer } = payload;
  if (typeof operationId !== 'string' || operationId.length === 0) {
    return null;
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    return null;
  }
  const files = payload.result_files;
  if (
    files !== undefined &&
    (!Array.isArray(files) ||
      files.length > 10 ||
      files.some(
        (f) =>
          !f ||
          typeof f.id !== 'string' ||
          !/^F[A-Z0-9]+$/.test(f.id) ||
          typeof f.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(f.sha256),
      ))
  )
    return null;
  return {
    operationId,
    revision,
    answer: answer === true,
    ...(files === undefined
      ? {}
      : {
          resultFiles: (files as Array<{ id: string; sha256: string }>).map((f) => ({
            id: f.id,
            sha256: f.sha256,
          })),
        }),
  };
}
