import type { AcceptedRequestDto } from '../../contracts/dto.js';
import { isApplicationIdentity, matchesTrustedBotSender } from './trusted-bot-sender.js';
import type { CoordinatorAdminDocument } from '../../application/configuration/admin-document.js';

/** Current trust is a grant, never a rewrite of the historical accepted author.
 * Use this at both admission and every authorization derived from retained input.
 * Ordinary policy evaluation still applies to the sender's user separately.
 */
export function acceptedOriginAllowed(
  document: CoordinatorAdminDocument,
  task: { installation_id: string; team_id: string; channel_id: string },
  author: Pick<AcceptedRequestDto, 'authorKind' | 'userId' | 'botId'>,
): boolean {
  const installation = document.installations.find(
    (i) => i.teamId === task.team_id && i.botUserId === task.installation_id,
  );
  if (!installation || author.userId === installation.botUserId) return false;
  if (author.authorKind === 'human') return author.botId === null;
  if (author.authorKind !== 'bot' || !author.botId || !installation.trustedBotSender) return false;
  const sender = { teamId: installation.teamId, ...installation.trustedBotSender };
  return (
    !isApplicationIdentity(sender, installation) &&
    author.botId !== installation.botId &&
    matchesTrustedBotSender(
      { bot_id: author.botId, user: author.userId },
      task.team_id,
      task.channel_id,
      sender,
    )
  );
}
