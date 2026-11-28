/**
 * The run's effective tool profile, built from the tools the admin service
 * assigned to the task's channel (`claim.tools`, D5). There is no file or
 * environment tool configuration: a channel exposes exactly its assigned,
 * ready instances, and a channel without assignments exposes no optional
 * tool.
 *
 * The profile carries instance IDs, labels, non-secret settings and
 * credential versions (never a credential).
 */

import type { ChannelToolDto, ChannelToolsDto } from '../../contracts/dto.js';
import type { OptimizelyDatafile } from '../../contracts/tool-kinds.js';
import {
  ATLASSIAN_ADAPTER,
  ATLASSIAN_CONTRACT_VERSION,
  ATLASSIAN_READ_OPERATIONS,
  normalizeAtlassianOperations,
} from '../atlassian/atlassian-operations.js';
import { DATADOG_ADAPTER, DATADOG_CONTRACT_VERSION } from '../datadog/datadog-mcp-adapter.js';
import {
  CLOUDFLARE_ADAPTER,
  CLOUDFLARE_CONTRACT_VERSION,
} from '../cloudflare/cloudflare-api-adapter.js';
import { SLACK_ADAPTER, SLACK_CONTRACT_VERSION } from '../slack/slack-api-adapter.js';
import { OPTIMIZELY_ADAPTER } from '../optimizely/datafile.js';

/** Adapter id of the web fetch tool. */
export const WEB_RUNTIME_ADAPTER = 'web-runtime-v1';

/** Adapter ID of provider-hosted web search. */
export const WEB_SEARCH_ADAPTER = 'anthropic-web-search-v1';

export type EffectiveToolName =
  'atlassian' | 'datadog' | 'cloudflare' | 'slack' | 'webSearch' | 'webFetch' | 'optimizely';

export interface EffectiveTool {
  name: EffectiveToolName;
  /** Admin-managed instance serving the tool for this channel. */
  instanceId: string;
  label: string;
  credentialVersion: number;
  adapter: string;
  /** Atlassian: typed operation allowlist plus contract version. */
  operations?: string[];
  contractVersion?: string;
  /** Datadog: upstream tool names the admin removed. */
  denyTools?: string[];
  /** Cloudflare: the configured account (null: zone-level only) and zone names (null: all). */
  accountId?: string | null;
  zones?: string[] | null;
  datafiles?: OptimizelyDatafile[];
}

/** The channel's GitLab instance. */
export interface EffectiveGitlab {
  instanceId: string;
  label: string;
  host: string;
  credentialVersion: number;
}

/** The run's grant. */
export interface EffectiveToolProfile {
  tools: EffectiveTool[];
  gitlab: EffectiveGitlab | null;
}

function effectiveTool(tool: ChannelToolDto): EffectiveTool | null {
  const base = {
    instanceId: tool.instanceId,
    label: tool.label,
    credentialVersion: tool.credentialVersion,
  };
  switch (tool.kind) {
    case 'atlassian':
      return {
        ...base,
        name: 'atlassian',
        adapter: ATLASSIAN_ADAPTER,
        operations: normalizeAtlassianOperations(tool.operations ?? [...ATLASSIAN_READ_OPERATIONS]),
        contractVersion: ATLASSIAN_CONTRACT_VERSION,
      };
    case 'datadog':
      return {
        ...base,
        name: 'datadog',
        adapter: DATADOG_ADAPTER,
        contractVersion: DATADOG_CONTRACT_VERSION,
        denyTools: [...(tool.denyTools ?? [])].sort(),
      };
    case 'cloudflare':
      return {
        ...base,
        name: 'cloudflare',
        adapter: CLOUDFLARE_ADAPTER,
        contractVersion: CLOUDFLARE_CONTRACT_VERSION,
        accountId: tool.accountId ?? null,
        zones: tool.zones === undefined || tool.zones === null ? null : [...tool.zones].sort(),
      };
    case 'slack':
      return {
        ...base,
        name: 'slack',
        adapter: SLACK_ADAPTER,
        contractVersion: SLACK_CONTRACT_VERSION,
      };
    case 'webSearch':
      return { ...base, name: 'webSearch', adapter: WEB_SEARCH_ADAPTER };
    case 'webFetch':
      return { ...base, name: 'webFetch', adapter: WEB_RUNTIME_ADAPTER };
    case 'optimizely':
      return {
        ...base,
        name: 'optimizely',
        adapter: OPTIMIZELY_ADAPTER,
        datafiles: (tool.datafiles ?? []).map((d) => ({ name: d.name, sdkKey: d.sdkKey })),
      };
    default:
      return null;
  }
}

/**
 * Builds the run's profile from the channel's assigned tools. Unready
 * instances and a GitLab instance without a host are left out; `gitlab: false`
 * (fixture deployments) leaves a GitLab assignment unused.
 */
export function resolveChannelTools(
  channel: ChannelToolsDto | null,
  options: { gitlab: boolean },
): EffectiveToolProfile {
  const profile: EffectiveToolProfile = {
    tools: [],
    gitlab: null,
  };
  for (const tool of channel?.tools ?? []) {
    if (tool.kind === 'gitlab' && !options.gitlab) continue;
    if (!tool.ready) continue;
    if (tool.kind === 'gitlab') {
      if (typeof tool.host !== 'string' || tool.host.length === 0) continue;
      profile.gitlab = {
        instanceId: tool.instanceId,
        label: tool.label,
        host: tool.host.toLowerCase(),
        credentialVersion: tool.credentialVersion,
      };
      continue;
    }
    const entry = effectiveTool(tool);
    if (entry !== null) profile.tools.push(entry);
  }
  return profile;
}
