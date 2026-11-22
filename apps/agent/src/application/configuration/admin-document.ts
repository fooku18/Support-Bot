import { createHash } from 'node:crypto';
import { parseAuthorizationPolicy } from '../../domain/authorization/policy.js';
import { parseRunLimits } from '../../domain/authorization/run-limits.js';
import {
  parseToolAssignments,
  type ChannelToolAssignment,
} from '../../domain/authorization/tool-assignments.js';

interface Installation {
  teamId: string;
  teamName: string;
  botUserId: string;
  botId: string;
  trustedBotSender: { botId: string; userId: string; channelId: string } | null;
  installedAt: number | null;
}

export interface CoordinatorAdminDocument {
  version: number;
  hash: string;
  installations: Installation[];
  authorizationPolicy: Record<string, unknown>;
  toolAssignments: ChannelToolAssignment[];
  runLimits: ReturnType<typeof parseRunLimits>;
}

const TOOL_SETTINGS_FIELDS: Record<ChannelToolAssignment['tools'][number]['kind'], string[]> = {
  gitlab: ['host'],
  atlassian: ['operations'],
  datadog: ['denyTools'],
  cloudflare: ['accountId', 'zones'],
  slack: [],
  webSearch: [],
  webFetch: [],
  codeMode: [],
  files: ['readOnly'],
  localExec: [],
};

/** The complete trusted admin snapshot. Its source hash stays separate from the
 * coordinator configuration hash (which also covers deployment model/admission
 * settings). Unsupported sections are refused, never silently discarded.
 * This parser does not enable capabilities or write the coordinator database.
 */
export function parseCoordinatorAdminDocument(value: unknown) {
  try {
    const input = object(value);
    keys(input, [
      'version',
      'hash',
      'installations',
      'authorizationPolicy',
      'toolAssignments',
      'runLimits',
    ]);
    if (
      !Number.isSafeInteger(input.version) ||
      (input.version as number) < 1 ||
      typeof input.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.hash)
    )
      fail();
    if (!Array.isArray(input.installations) || input.installations.length > 2000) fail();
    const installations = input.installations.map((raw) => {
      const row = object(raw);
      keys(row, ['teamId', 'teamName', 'botUserId', 'botId', 'trustedBotSender', 'installedAt']);
      id(row.teamId, /^T[A-Z0-9]{1,31}$/);
      id(row.botUserId, /^U[A-Z0-9]{1,31}$/);
      id(row.botId, /^B[A-Z0-9]{1,31}$/);
      if (
        typeof row.teamName !== 'string' ||
        row.teamName.length > 1000 ||
        (row.installedAt !== null &&
          (!Number.isSafeInteger(row.installedAt) || (row.installedAt as number) < 0))
      )
        fail();
      if (row.trustedBotSender !== null) {
        const sender = object(row.trustedBotSender);
        keys(sender, ['botId', 'userId', 'channelId']);
        id(sender.botId, /^B[A-Z0-9]{1,31}$/);
        id(sender.userId, /^U[A-Z0-9]{1,31}$/);
        id(sender.channelId, /^[CG][A-Z0-9]{1,31}$/);
        if (sender.botId === row.botId || sender.userId === row.botUserId) fail();
      }
      return row as unknown as Installation;
    });
    const teams = new Set(installations.map((row) => row.teamId));
    if (teams.size !== installations.length) fail();
    const policySource = JSON.stringify(object(input.authorizationPolicy));
    parseAuthorizationPolicy(policySource);
    const assignments = parseToolAssignments(input.toolAssignments);
    if (assignments.some((row) => !teams.has(row.teamId))) fail();
    for (const row of assignments) {
      for (const tool of row.tools) {
        keys(object(tool), [
          'kind',
          'instanceId',
          'label',
          'credentialVersion',
          'ready',
          'detail',
          ...TOOL_SETTINGS_FIELDS[tool.kind],
        ]);
      }
    }
    const limits = parseRunLimits(input.runLimits);
    // These parsers historically default missing fields and drop unknown ones.
    // A new coordinator accepts only the current complete compiler contract.
    if (!same(input.toolAssignments, assignments) || !same(input.runLimits, limits)) fail();
    const body = {
      version: input.version,
      installations: input.installations,
      authorizationPolicy: input.authorizationPolicy,
      toolAssignments: input.toolAssignments,
      runLimits: input.runLimits,
    };
    const serialized = JSON.stringify(body);
    if (
      Buffer.byteLength(serialized) > 1024 * 1024 ||
      createHash('sha256').update(serialized).digest('hex') !== input.hash
    )
      fail();
    const document = structuredClone({ ...body, hash: input.hash }) as CoordinatorAdminDocument;
    return {
      document,
      // The admin's digest covers wire JSON order. Persist this string when
      // storing the snapshot in JSONB; JSONB's object ordering is not the wire
      // identity and must never be used to recompute the admin hash.
      sourceJson: JSON.stringify(document),
      policySource,
      trustedEditSenders: installations.flatMap((row) =>
        row.trustedBotSender ? [{ teamId: row.teamId, ...row.trustedBotSender }] : [],
      ),
    };
  } catch {
    throw new Error('Invalid coordinator admin document');
  }
}

function fail(): never {
  throw new Error('invalid');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    fail();
}
function id(value: unknown, pattern: RegExp) {
  if (typeof value !== 'string' || !pattern.test(value)) fail();
}
/** Object key order is not a schema constraint; array order remains significant. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) ||
    Array.isArray(b)
  )
    return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
  );
}
