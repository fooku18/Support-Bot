/** exact, deterministic commands; shared by intake and history filtering. */
export type ChannelCommand =
  | { kind: 'capabilities' }
  | { kind: 'help' }
  | { kind: 'configure' }
  | { kind: 'invalid' }
  | { kind: 'list'; page: number }
  | { kind: 'remember'; text: string }
  | { kind: 'replace'; id: number; text: string }
  | { kind: 'delete'; id: number };

/** @public */
export function classifyChannelCommand(text: string, botUserId: string): ChannelCommand | null {
  const mention = /^\s*<@([A-Z0-9]+)>\s*([\s\S]*)$/.exec(text);
  if (!mention || mention[1] !== botUserId) return null;
  const input = mention[2]!;
  const helpText = input.replace(/\s+\*Sent using\* <@[UW][A-Z0-9]+(?:\|[^>\n]+)?>\s*$/, '');
  if (/^(?:help|what can you do here)\??\s*$/i.test(helpText)) return { kind: 'capabilities' };
  if (!input.startsWith('!')) return null;
  if (/^!help\s*$/i.test(input)) return { kind: 'help' };
  if (/^!config\s*$/i.test(input)) return { kind: 'configure' };
  const list = /^!memory(?:\s+list(?:\s+([1-9][0-9]*))?)?\s*$/i.exec(input);
  if (list) {
    const page = Number(list[1] ?? 1);
    return Number.isSafeInteger(page) ? { kind: 'list', page } : { kind: 'invalid' };
  }
  // Consume one separator only: the remainder is literal, including newlines/spaces.
  const add = /^!memory\s+remember[ \t\n]([\s\S]+)$/i.exec(input);
  if (add) return { kind: 'remember', text: add[1]! };
  const replace = /^!memory\s+replace\s+#?([1-9][0-9]*)[ \t\n]([\s\S]+)$/i.exec(input);
  if (replace && Number.isSafeInteger(Number(replace[1])))
    return { kind: 'replace', id: Number(replace[1]), text: replace[2]! };
  const del = /^!memory\s+delete\s+#?([1-9][0-9]*)\s*$/i.exec(input);
  if (del && Number.isSafeInteger(Number(del[1]))) return { kind: 'delete', id: Number(del[1]) };
  return { kind: 'invalid' };
}

/** @public */
export const CHANNEL_COMMAND_HELP =
  'Commands: !help; !config (channel settings, including automatic thread replies); !memory [list [page]]; !memory remember <text>; !memory replace <#id> <text>; !memory delete <#id>. Memory is saved only by these explicit commands. Changes apply to newly pinned runs. Deletion does not erase Slack history, earlier runs or backups.';
/** @public */
export const COMMAND_RECEIPT_TYPE = 'support_agent_command_receipt';
export interface MemoryEntry {
  id: number;
  text: string;
  creator: string;
  editor: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  createdAt: number;
  lastConfirmedAt: number;
}
export interface ChannelMemorySnapshot {
  revision: number;
  hash: string;
  rendered: string;
  entries: MemoryEntry[];
}

export function renderChannelMemory(entries: MemoryEntry[]): string {
  return entries.length === 0
    ? ''
    : JSON.stringify(
        entries.map((e) => ({
          id: e.id,
          text: e.text,
          channelId: e.channelId,
          threadTs: e.threadTs,
          messageTs: e.messageTs,
        })),
      );
}
/** Structural validation shared by fresh claims and persisted journals. Hash checked by caller. */
export function isChannelMemorySnapshot(value: unknown): value is ChannelMemorySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as ChannelMemorySnapshot;
  if (
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    typeof v.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.hash) ||
    typeof v.rendered !== 'string' ||
    v.rendered.length > 24000 ||
    !Array.isArray(v.entries) ||
    v.entries.length > 50
  )
    return false;
  let previous = 0,
    total = 0;
  for (const e of v.entries) {
    if (
      !e ||
      !Number.isSafeInteger(e.id) ||
      e.id <= previous ||
      typeof e.text !== 'string' ||
      !e.text.trim() ||
      e.text.length > 1000 ||
      typeof e.creator !== 'string' ||
      typeof e.editor !== 'string' ||
      typeof e.channelId !== 'string' ||
      typeof e.threadTs !== 'string' ||
      typeof e.messageTs !== 'string' ||
      !Number.isSafeInteger(e.createdAt) ||
      !Number.isSafeInteger(e.lastConfirmedAt)
    )
      return false;
    previous = e.id;
    total += e.text.length;
  }
  return total <= 12000 && renderChannelMemory(v.entries) === v.rendered;
}

/**
 * Literal cells for the durable memory-list presentation (ID, note, confirmation).
 *
 * @public
 */
export interface CommandReceiptTable {
  rows: Array<[string, string, string]>;
}
