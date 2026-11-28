/** JSON request/response contracts for private application service boundaries. */

export interface IntakeRequest {
  qualificationToken?: string;
  installationId: string;
  teamId: string;
  channelId: string;
  /** `thread_ts ?? ts` of the triggering mention. */
  rootTs: string;
  eventId: string;
  /** Source message identity (channel + ts of the mention message). */
  messageTs: string;
  userId: string;
  /** Original event text: only this field may parse as a control. */
  text: string;
  /** Canonical text/blocks/attachments captured at intake. */
  canonicalText: string;
  authorBotId: string | null;
  threadTs?: string;
  eventTs?: string;
  /**
   * Slack's per-event `action_token` (apps with Agents & AI Apps enabled):
   * lets the run's Slack message search act with this user's permissions.
   * Held on the inbox row until the run ends; never inspected or logged.
   */
  actionToken?: string;
}

export interface SlackFileDescriptorDto {
  id: string;
  sourceTs: string;
  name: string;
  mime: string;
  bytes: number;
  revision: string;
  hosted: boolean;
}

/**
 * One admin-managed tool instance assigned to the task's channel. Non-secret
 * settings only: credentials stay in the admin store and the runtimes.
 */
export interface ChannelToolDto {
  kind:
    | 'gitlab'
    | 'atlassian'
    | 'datadog'
    | 'cloudflare'
    | 'slack'
    | 'webSearch'
    | 'webFetch'
    | 'optimizely'
    | 'codeMode';
  instanceId: string;
  label: string;
  credentialVersion: number;
  ready: boolean;
  detail: string | null;
  /** GitLab only. */
  host?: string;
  /** Atlassian only: effective operation allowlist. */
  operations?: string[];
  /** Datadog only: upstream tools removed from the catalog. */
  denyTools?: string[];
  /** Cloudflare only: the account the account-level datasets are limited to (null: none). */
  accountId?: string | null;
  /** Cloudflare only: the zone names exposed (null: every zone the token sees). */
  zones?: string[] | null;
  datafiles?: Array<{ name: string; sdkKey: string }>;
}

/**
 * The tools the task's channel exposes, from the admin document the agent
 * synced last (`toolAssignments`). Null when the channel has no entry (not
 * enabled, or no document synced): no optional tool is available.
 */
export interface ChannelToolsDto {
  configVersion: number;
  teamId: string;
  channelId: string;
  /**
   * The channel's admin-chosen model key (null: deployment default).
   * Metadata: the run's model is pinned at its first claim (`runModel`).
   */
  modelKey: string | null;
  /**
   * The channel's admin system prompt (channel, else workspace; null: none).
   * The runner appends it to its fixed system prompt when it prepares a
   * turn; the heartbeat value is informational and never changes a
   * prepared or running turn.
   */
  systemPrompt: string | null;
  tools: ChannelToolDto[];
}
/** Immutable admission-time input. Author attribution never adds authority. */
export interface AcceptedRequestDto {
  messageTs: string;
  eventId: string;
  acceptedAtMs: number;
  text: string;
  contentHash: string;
  userId: string;
  authorKind: 'human' | 'bot';
  botId: string | null;
}
