import { describe, expect, it } from 'vitest';
import { createRunStatus, toolStatus } from '../../src/domain/delivery/run-status.js';
import { runNativeSegment } from '../../src/mastra/runtime/segment.js';

describe('run status lines', () => {
  it.each([
    ['get_merge_request', { merge_request_iid: 123 }, 'Reading merge request !123…'],
    ['get_merge_request_diffs', { merge_request_iid: '<!here>' }, 'Looking at merge requests…'],
    ['list_pipelines', {}, 'Checking GitLab pipelines…'],
    ['get_job_trace', {}, 'Checking GitLab pipelines…'],
    ['get_issue', { issue_iid: 7 }, 'Reading GitLab issue #7…'],
    ['get_repository_file', {}, 'Searching GitLab…'],
    ['search', {}, 'Searching GitLab…'],
    ['getJiraIssue', { issueKey: 'SHOP-42' }, 'Reading SHOP-42…'],
    ['getJiraIssue', { issueKey: '<@U1>' }, 'Searching Jira…'],
    ['searchJiraIssuesUsingJql', {}, 'Searching Jira…'],
    ['getConfluencePage', {}, 'Reading Confluence…'],
    ['datadog_call', {}, 'Checking Datadog…'],
    ['cloudflare_graphql', {}, 'Checking Cloudflare…'],
    ['slack_search_messages', {}, 'Searching Slack…'],
    ['slack_read_message', {}, 'Reading Slack…'],
    ['web_search', {}, 'Searching the web…'],
    ['web_fetch', {}, 'Reading a web page…'],
    ['something_new', {}, 'Working…'],
  ])('%s %j reads %s', (name, args, line) => {
    expect(toolStatus(name, args)).toBe(line);
  });

  it('shows nothing for a question to the user', () => {
    expect(toolStatus('ask_user', {})).toBeUndefined();
  });

  it('throttles, skips repeats, caps the count and survives a failed send', async () => {
    let clock = 0;
    const sent: string[] = [];
    const status = createRunStatus(
      async (text) => {
        sent.push(text);
        if (text === 'b') throw new Error('slack down');
      },
      { intervalMs: 10, limit: 3, now: () => clock },
    );
    status.report('a');
    status.report('x');
    clock = 10;
    status.report('a');
    status.report('b');
    clock = 20;
    status.report(undefined);
    status.report('c');
    clock = 30;
    status.report('d');
    await status.settled();
    expect(sent).toEqual(['a', 'b', 'c']);
  });

  it('reports each tool call of a segment', async () => {
    const calls: string[] = [];
    await runNativeSegment(
      {
        runId: 'status',
        output: {
          fullStream: (async function* () {
            yield { type: 'tool-call', payload: { toolName: 'datadog_call', args: { q: 1 } } };
            yield { type: 'text-delta', payload: { text: 'x' } };
            yield { type: 'tool-call', payload: { toolName: 'web_fetch', args: {} } };
          })(),
          getFullOutput: async () => ({ text: 'done', finishReason: 'stop', steps: [] }),
        },
        cleanup() {},
      } as unknown as Parameters<typeof runNativeSegment>[0],
      (name, args) => calls.push(`${name}:${JSON.stringify(args)}`),
    );
    expect(calls).toEqual(['datadog_call:{"q":1}', 'web_fetch:{}']);
  });
});
