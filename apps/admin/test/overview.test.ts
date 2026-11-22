import { describe, expect, it } from 'vitest';
import type { CostsView } from '../src/costs.js';
import type { Channel, Installation, ToolInstance, ToolStatus } from '../src/store.js';
import { attentionItems, overviewPage, type OverviewView } from '../src/views/pages.js';

const installation = (teamId: string, patch: Partial<Installation> = {}): Installation => ({
  teamId,
  teamName: `Team ${teamId}`,
  botUserId: 'U0BOT',
  botId: 'B0BOT',
  status: 'whitelisted',
  trustedBotSender: null,
  scopes: '',
  installedBy: 'alice',
  installedAt: 0,
  lastSeenAt: null,
  hasToken: true,
  ...patch,
});

const instance = (id: string, patch: Partial<ToolInstance> = {}): ToolInstance => ({
  id,
  teamId: 'T0ONE',
  kind: 'gitlab',
  label: `GitLab ${id}`,
  host: 'gitlab.example.com',
  settings: {} as ToolInstance['settings'],
  hasCredential: true,
  credentialVersion: 2,
  status: 'enabled',
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

const status = (instanceId: string, patch: Partial<ToolStatus> = {}): ToolStatus => ({
  instanceId,
  state: 'ready',
  detail: '',
  toolsCount: 3,
  credentialVersion: 2,
  reporter: 'runner',
  reportedAt: 0,
  ...patch,
});

const channel = (channelId: string, patch: Partial<Channel> = {}): Channel => ({
  teamId: 'T0ONE',
  channelId,
  name: channelId.toLowerCase(),
  isPrivate: false,
  botMember: true,
  enabled: true,
  ...patch,
});

const costs: CostsView = {
  generatedAt: Date.parse('2026-11-21T12:00:00Z'),
  from: '2026-11-15',
  to: '2026-11-21',
  group: 'day',
  totals: {
    requests: 0,
    completedRequests: 0,
    failedRequests: 0,
    interruptedRequests: 0,
    billedUsd: null,
    runs: 0,
    estimateUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  days: [],
  rows: [],
  ledger: {
    requestRows: 0,
    runRows: 0,
    lastReceivedAt: null,
    firstDay: null,
    instances: [],
    retentionDays: 30,
  },
};

function view(patch: Partial<OverviewView>): OverviewView {
  return {
    costs,
    installations: [installation('T0ONE')],
    channels: [],
    instances: [],
    statuses: new Map(),
    audit: [],
    ...patch,
  };
}

describe('overview', () => {
  it('names what keeps the bot from answering, and nothing that is fine', () => {
    const items = attentionItems(
      view({
        installations: [
          installation('T0ONE'),
          installation('T0TWO', { status: 'pending' }),
          installation('T0THREE', { hasToken: false, teamName: '' }),
          installation('T0FOUR', { status: 'disabled' }),
        ],
        channels: [
          channel('C0LIVE'),
          channel('C0LEFT', { botMember: false }),
          channel('C0OFF', { enabled: false, botMember: false }),
        ],
        instances: [
          instance('ready'),
          instance('failing'),
          instance('stale', { credentialVersion: 3 }),
          instance('missing', { hasCredential: false }),
          instance('off', { status: 'disabled', hasCredential: false }),
        ],
        statuses: new Map([
          ['ready', status('ready')],
          ['failing', status('failing', { state: 'error', detail: '401 Unauthorized' })],
          ['stale', status('stale', { state: 'error' })],
        ]),
      }),
    );
    expect(items.map((item) => item.title)).toEqual([
      'GitLab failing: runtime check failed',
      'GitLab missing has no credential',
      'The bot left #c0left',
      'Team T0TWO is pending',
      'T0THREE is not paired',
    ]);
    expect(items[0]!.detail).toContain('401 Unauthorized');
    expect(items[2]!.href).toBe('/workspaces/T0ONE/channels/C0LEFT/blocked-members');
  });

  it('renders the week with an empty ledger and escapes workspace names', () => {
    const body = overviewPage(
      { adminName: 'alice', csrf: 'csrf' },
      view({
        installations: [installation('T0ONE', { teamName: '<b>One</b>', status: 'pending' })],
      }),
    );
    expect(body).toContain('<h1>Overview</h1>');
    expect(body).toContain('&lt;b&gt;One&lt;/b&gt; is pending');
    expect(body).not.toContain('<b>One</b>');
    expect(body).toContain('2026-11-15 to 2026-11-21 (UTC), last 7 days');
  });
});
