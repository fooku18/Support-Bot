/**
 * The admin document's `toolAssignments` section: per enabled channel the
 * admin-managed tool instances assigned to it (non-secret settings only),
 * its effective model key and system prompt. ConfigSync validates it before caching a
 * document (a malformed section refuses the whole document, like a refused
 * policy); the task cells parse the cached copy to answer run claims and
 * heartbeats.
 */

import type { ChannelToolDto } from '../../contracts/dto.js';
import { MAX_CHANNEL_PROMPT_CHARS, MODEL_KEY_PATTERN } from '../../contracts/protocol.js';
import {
  CLOUDFLARE_ID,
  MAX_CLOUDFLARE_ZONES,
  MAX_LABEL_CHARS,
  TOOL_INSTANCE_ID,
  TOOL_KINDS,
  type ChannelToolAssignment,
} from '../../contracts/tool-kinds.js';

export class ToolAssignmentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolAssignmentsError';
  }
}

const TEAM_ID = /^T[A-Z0-9]{1,31}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{1,31}$/;
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
const LIST_ENTRY = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const ZONE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** Upper bound on assigned channels in one document (the policy caps its size at 64 KB anyway). */
export const MAX_TOOL_ASSIGNMENTS = 2_000;
const MAX_DETAIL_CHARS = 500;
const MAX_LIST_ENTRIES = 100;
/** Control characters other than `\n` and `\t` (C0, DEL and C1); the admin refuses them too. */
// eslint-disable-next-line no-control-regex
const PROMPT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function fail(message: string): never {
  throw new ToolAssignmentsError(message);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES)
    fail(`${where} must be an array of at most ${MAX_LIST_ENTRIES} names`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || !LIST_ENTRY.test(entry)) fail(`${where} has an invalid name`);
    return entry;
  });
}

function parseTool(value: unknown, where: string): ChannelToolDto {
  const input = object(value, where);
  const kind = input.kind;
  if (typeof kind !== 'string' || !(TOOL_KINDS as readonly string[]).includes(kind))
    fail(`${where}.kind is not a known tool kind`);
  if (typeof input.instanceId !== 'string' || !TOOL_INSTANCE_ID.test(input.instanceId))
    fail(`${where}.instanceId is invalid`);
  if (
    typeof input.label !== 'string' ||
    input.label.length === 0 ||
    input.label.length > MAX_LABEL_CHARS
  )
    fail(`${where}.label must be a string of 1..${MAX_LABEL_CHARS} characters`);
  const credentialVersion = input.credentialVersion;
  if (
    typeof credentialVersion !== 'number' ||
    !Number.isSafeInteger(credentialVersion) ||
    credentialVersion < 0
  )
    fail(`${where}.credentialVersion must be a non-negative integer`);
  if (typeof input.ready !== 'boolean') fail(`${where}.ready must be a boolean`);
  const detail = input.detail ?? null;
  if (detail !== null && (typeof detail !== 'string' || detail.length > MAX_DETAIL_CHARS))
    fail(`${where}.detail must be null or a string of at most ${MAX_DETAIL_CHARS} characters`);
  const tool: ChannelToolDto = {
    kind: kind as ChannelToolDto['kind'],
    instanceId: input.instanceId,
    label: input.label,
    credentialVersion,
    ready: input.ready,
    detail,
  };
  if (input.host !== undefined) {
    if (typeof input.host !== 'string' || !HOST_NAME.test(input.host))
      fail(`${where}.host is not a host name`);
    tool.host = input.host;
  }
  if (input.operations !== undefined)
    tool.operations = stringList(input.operations, `${where}.operations`);
  if (input.denyTools !== undefined)
    tool.denyTools = stringList(input.denyTools, `${where}.denyTools`);
  if (input.accountId !== undefined) {
    if (
      input.accountId !== null &&
      (typeof input.accountId !== 'string' || !CLOUDFLARE_ID.test(input.accountId))
    )
      fail(`${where}.accountId must be null or a Cloudflare account ID`);
    tool.accountId = input.accountId;
  }
  if (input.zones !== undefined) {
    if (input.zones === null) tool.zones = null;
    else {
      if (!Array.isArray(input.zones) || input.zones.length > MAX_CLOUDFLARE_ZONES)
        fail(
          `${where}.zones must be null or an array of at most ${MAX_CLOUDFLARE_ZONES} zone names`,
        );
      tool.zones = input.zones.map((entry) => {
        if (typeof entry !== 'string' || !ZONE_NAME.test(entry))
          fail(`${where}.zones has an invalid zone name`);
        return entry;
      });
    }
  }
  if (kind === 'gitlab' && tool.host === undefined) fail(`${where}.host is required for gitlab`);
  return tool;
}

/**
 * Validates and normalizes a `toolAssignments` section. A missing section
 * (`undefined`) is an empty list. Unknown fields are dropped; every known
 * field must be well-formed or the whole section is refused.
 */
export function parseToolAssignments(value: unknown): ChannelToolAssignment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOL_ASSIGNMENTS)
    fail(`toolAssignments must be an array of at most ${MAX_TOOL_ASSIGNMENTS} entries`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const where = `toolAssignments[${index}]`;
    const entry = object(raw, where);
    if (typeof entry.teamId !== 'string' || !TEAM_ID.test(entry.teamId))
      fail(`${where}.teamId is invalid`);
    if (typeof entry.channelId !== 'string' || !CHANNEL_ID.test(entry.channelId))
      fail(`${where}.channelId is invalid`);
    const key = `${entry.teamId}:${entry.channelId}`;
    if (seen.has(key)) fail(`${where} repeats a channel`);
    seen.add(key);
    if (!Array.isArray(entry.tools) || entry.tools.length > TOOL_KINDS.length)
      fail(`${where}.tools must be an array of at most ${TOOL_KINDS.length} tools`);
    const tools = entry.tools.map((tool, toolIndex) =>
      parseTool(tool, `${where}.tools[${toolIndex}]`),
    );
    // At most one instance per kind per channel (plan D3).
    if (new Set(tools.map((tool) => tool.kind)).size !== tools.length)
      fail(`${where}.tools repeats a tool kind`);
    // A document compiled before the admin knew about models has no field:
    // the deployment default applies until the next admin mutation.
    const modelKey = entry.modelKey ?? null;
    if (
      modelKey !== null &&
      (typeof modelKey !== 'string' || !MODEL_KEY_PATTERN.test(modelKey) || modelKey === 'default')
    )
      fail(`${where}.modelKey must be null or a model key`);
    // Missing in a document compiled before the admin knew about prompts: none.
    const systemPrompt = entry.systemPrompt ?? null;
    if (
      systemPrompt !== null &&
      (typeof systemPrompt !== 'string' ||
        systemPrompt.trim().length === 0 ||
        systemPrompt.length > MAX_CHANNEL_PROMPT_CHARS ||
        PROMPT_CONTROL.test(systemPrompt))
    )
      fail(
        `${where}.systemPrompt must be null or 1..${MAX_CHANNEL_PROMPT_CHARS} characters without control characters`,
      );
    // Absent (a document compiled before this setting existed): the default, on.
    const autoReplies = entry.autoReplies ?? true;
    if (typeof autoReplies !== 'boolean') fail(`${where}.autoReplies must be a boolean`);
    return {
      teamId: entry.teamId,
      channelId: entry.channelId,
      modelKey,
      systemPrompt,
      autoReplies,
      tools,
    };
  });
}
