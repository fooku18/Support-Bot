/**
 * Trusted bot sender of one installation (configured in the admin service),
 * shared by intake and context retrieval: exactly one bot/user pair in one
 * channel of that workspace. Undefined means disabled.
 */
export interface TrustedBotSender {
  teamId: string;
  channelId: string;
  botId: string;
  userId: string;
}

export function matchesTrustedBotSender(
  message: { bot_id?: string; user?: string },
  teamId: string | undefined,
  channelId: string,
  sender: TrustedBotSender | undefined,
): boolean {
  return (
    sender !== undefined &&
    teamId === sender.teamId &&
    channelId === sender.channelId &&
    message.bot_id === sender.botId &&
    message.user === sender.userId
  );
}

/** True when the configured trusted bot sender would be the application itself. */
export function isApplicationIdentity(
  sender: TrustedBotSender,
  identity: { botId: string; botUserId: string },
): boolean {
  return sender.botId === identity.botId || sender.userId === identity.botUserId;
}
