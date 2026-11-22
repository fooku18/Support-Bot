/** Task identity helpers for the Slack adapter. */

export const TASK_KEY_VERSION = 'v1';

const SLACK_ID_PATTERN = /^[A-Z0-9]+$/;
const SLACK_TS_PATTERN = /^[0-9]+\.[0-9]+$/;
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

export function displayTaskId(taskKey: string): string {
  const identity = parseTaskKey(taskKey);
  return identity === undefined ? 'unknown-task' : `${identity.channelId}:${identity.rootTs}`;
}

/**
 * Numerically compares two Slack timestamps ("1716234567.123456"): seconds as
 * numbers, then zero-padded fractions. Never compares raw strings.
 */
export function compareTs(a: string, b: string): number {
  const [aSec, aFrac] = splitTs(a);
  const [bSec, bFrac] = splitTs(b);
  const aSeconds = Number.parseInt(aSec, 10);
  const bSeconds = Number.parseInt(bSec, 10);
  if (aSeconds !== bSeconds) {
    return aSeconds < bSeconds ? -1 : 1;
  }
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
