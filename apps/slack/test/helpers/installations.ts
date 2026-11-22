/**
 * Static installation lookups for tests that do not exercise the admin
 * registry itself (see installations.test.ts for that).
 */

import type { WebClient } from '@slack/web-api';
import type { BotIdentity } from '../../src/intake.js';
import type { Installation, InstallationLookup } from '../../src/installations.js';

export function testInstallation(identity: BotIdentity, webClient?: unknown): Installation {
  return {
    identity,
    slack: {
      webClient: {
        conversations: {
          members: async () => ({
            ok: true,
            members: [
              'UHUMAN1',
              'UHUMAN2',
              'UAUTO',
              'UOWNER',
              'UOTHER',
              'U0HUMAN1',
              'U0HUMAN2',
              'U0ALICE1',
              'U0BOB1',
              'U0SENDER1',
              'U1',
              'U2',
              'UHUMAN01',
            ],
            response_metadata: {},
          }),
        },
        ...(webClient ?? {}),
      } as unknown as WebClient,
      botUserId: identity.botUserId,
      botId: identity.botId,
    },
  };
}

export function staticInstallations(...installations: Installation[]): InstallationLookup {
  const byTeam = new Map(installations.map((row) => [row.identity.teamId, row]));
  return { get: (teamId) => byTeam.get(teamId) };
}
