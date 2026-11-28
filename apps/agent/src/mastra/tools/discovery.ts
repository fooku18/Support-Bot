import { isGitlabOperationName } from '../../integrations/gitlab/gitlab-operations.js';
import { isAtlassianOperationName } from '../../integrations/atlassian/atlassian-operations.js';
import type { EffectiveToolName } from '../../integrations/tools/tool-profile.js';

/** Metadata exposure follows the same capability families as broker admission. */
export function nativeOperationCapability(name: string): EffectiveToolName | 'gitlab' | null {
  if (isGitlabOperationName(name)) return 'gitlab';
  if (isAtlassianOperationName(name)) return 'atlassian';
  if (name.startsWith('datadog_')) return 'datadog';
  if (name.startsWith('cloudflare_')) return 'cloudflare';
  if (name.startsWith('slack_')) return 'slack';
  if (name === 'web_fetch') return 'webFetch';
  return null;
}
