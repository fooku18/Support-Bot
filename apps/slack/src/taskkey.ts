/** GENERATED from apps/agent/src/contracts/task-key.ts; run npm run generate:protocol. */
export const TASK_KEY_VERSION = 'v1';

/** Slack IDs (team/channel/bot/user) are uppercase alphanumerics. */
const SLACK_ID_PATTERN = /^[A-Z0-9]+$/;

/** Slack message timestamps are `<seconds>.<fraction>`, digits only. */
export const SLACK_TS_PATTERN = /^[0-9]+\.[0-9]+$/;

/** A cell scope: non-empty ASCII alphanumerics plus `_ - . : $`. */
const CELL_SCOPE_PATTERN = /^[A-Za-z0-9_.:$-]+$/;

export class TaskKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskKeyError';
  }
}

export interface TaskIdentity {
  installationId: string;
  teamId: string;
  channelId: string;
  rootTs: string;
}

export function validateSlackId(value: string, name: string): void {
  if (!SLACK_ID_PATTERN.test(value)) {
    throw new TaskKeyError(`${name} must be a Slack ID of uppercase letters and digits`);
  }
}

export function validateSlackTs(value: string, name: string): void {
  if (!SLACK_TS_PATTERN.test(value)) {
    throw new TaskKeyError(`${name} must be a Slack message timestamp like "1716234567.123456"`);
  }
}

/**
 * Builds the versioned canonical task key and validates every component.
 * Throws TaskKeyError with a sanitized message when a component is malformed.
 */
export function buildTaskKey(identity: TaskIdentity): string {
  validateSlackId(identity.installationId, 'installationId');
  validateSlackId(identity.teamId, 'teamId');
  validateSlackId(identity.channelId, 'channelId');
  validateSlackTs(identity.rootTs, 'rootTs');
  const key = [
    TASK_KEY_VERSION,
    identity.installationId,
    identity.teamId,
    identity.channelId,
    identity.rootTs,
  ].join(':');
  if (!CELL_SCOPE_PATTERN.test(key) || key.length > 255) {
    throw new TaskKeyError('composed task key is not a valid cell name');
  }
  return key;
}

/**
 * Parses a task key back into its components. Returns undefined for keys of
 * an unknown version so callers can ignore foreign rows instead of crashing.
 */
export function parseTaskKey(taskKey: string): TaskIdentity | undefined {
  const parts = taskKey.split(':');
  if (parts.length !== 5 || parts[0] !== TASK_KEY_VERSION) {
    return undefined;
  }
  const [, installationId, teamId, channelId, rootTs] = parts;
  if (
    installationId === undefined ||
    teamId === undefined ||
    channelId === undefined ||
    rootTs === undefined
  ) {
    return undefined;
  }
  return { installationId, teamId, channelId, rootTs };
}

/**
 * Short, stable, human-usable task identifier used in Slack replies and
 * sanitized logs: `<channelId>:<rootTs>`. It contains no message text.
 */
export function displayTaskId(taskKey: string): string {
  const identity = parseTaskKey(taskKey);
  return identity === undefined ? 'unknown-task' : `${identity.channelId}:${identity.rootTs}`;
}

/**
 * Compares two Slack timestamps numerically: seconds first, then the fraction
 * padded to equal width (Slack fraction widths can vary). Never compares them
 * as plain strings, because "1000.1" sorts before "999.9" lexicographically.
 */
export function compareTs(a: string, b: string): number {
  const [aSec, aFrac] = splitTs(a);
  const [bSec, bFrac] = splitTs(b);
  const aSeconds = Number.parseInt(aSec, 10);
  const bSeconds = Number.parseInt(bSec, 10);
  if (aSeconds !== bSeconds) {
    return aSeconds < bSeconds ? -1 : 1;
  }
  // Fractions are digit strings; equal-width string comparison is numeric.
  const width = Math.max(aFrac.length, bFrac.length);
  const af = aFrac.padEnd(width, '0');
  const bf = bFrac.padEnd(width, '0');
  if (af === bf) {
    return 0;
  }
  return af < bf ? -1 : 1;
}

function splitTs(ts: string): [string, string] {
  const dot = ts.indexOf('.');
  if (dot < 0) {
    return [ts, ''];
  }
  return [ts.slice(0, dot), ts.slice(dot + 1)];
}

/** Stable per-message identity: the channel plus the message timestamp. */
export function messageId(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}
