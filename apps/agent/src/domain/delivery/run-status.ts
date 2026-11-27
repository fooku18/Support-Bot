export const RUN_STATUS_START = 'Thinking…';

const JIRA_KEY = /^[A-Z][A-Z0-9]{0,19}-\d{1,9}$/;

function field(args: unknown, name: string) {
  return args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined;
}

function iid(args: unknown, name: string) {
  const value = field(args, name);
  return Number.isInteger(value) && (value as number) > 0 ? String(value) : undefined;
}

/** A short line for the user about what the run does now, from the tool it calls. */
export function toolStatus(toolName: string, args: unknown): string | undefined {
  if (toolName === 'ask_user') return undefined;
  if (toolName.includes('merge_request')) {
    const mr = iid(args, 'merge_request_iid');
    return mr ? `Reading merge request !${mr}…` : 'Looking at merge requests…';
  }
  if (/pipeline|_job/.test(toolName)) return 'Checking GitLab pipelines…';
  if (toolName.includes('issue') && !/jira/i.test(toolName)) {
    const issue = iid(args, 'issue_iid');
    return issue ? `Reading GitLab issue #${issue}…` : 'Looking at GitLab issues…';
  }
  if (/repository|commit|branch|project|deployment/.test(toolName) || toolName === 'search')
    return 'Searching GitLab…';
  if (/jira/i.test(toolName)) {
    const key = field(args, 'issueKey');
    return typeof key === 'string' && JIRA_KEY.test(key) ? `Reading ${key}…` : 'Searching Jira…';
  }
  if (/confluence/i.test(toolName)) return 'Reading Confluence…';
  if (toolName.startsWith('datadog_')) return 'Checking Datadog…';
  if (toolName.startsWith('cloudflare_')) return 'Checking Cloudflare…';
  if (toolName === 'slack_search_messages') return 'Searching Slack…';
  if (toolName.startsWith('slack_')) return 'Reading Slack…';
  if (toolName === 'web_search') return 'Searching the web…';
  if (toolName === 'web_fetch') return 'Reading a web page…';
  if (toolName === 'export_file') return 'Preparing a file…';
  return 'Working…';
}

/**
 * Sends status lines in order, at most one per `intervalMs` and `limit` in all,
 * never the same line twice in a row. A failed send is dropped.
 */
export function createRunStatus(
  send: (text: string) => Promise<unknown>,
  { intervalMs = 3000, limit = 8, now = Date.now } = {},
) {
  let chain: Promise<unknown> = Promise.resolve();
  let last: string | undefined;
  let at = -Infinity;
  let sent = 0;
  return {
    report(text: string | undefined) {
      if (!text || text === last || sent >= limit || now() - at < intervalMs) return;
      last = text;
      at = now();
      sent += 1;
      chain = chain.then(() => send(text)).catch(() => undefined);
    },
    settled: () => chain,
  };
}
