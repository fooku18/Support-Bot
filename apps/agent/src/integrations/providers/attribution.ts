import type { ResolvedModel } from '../../contracts/model-catalog.js';

export type CostMode = 'answer' | 'coding' | 'studio';

export interface RunAttribution {
  instance: string;
  teamId: string;
  channelId: string;
  rootTs: string;
  requesterUserId: string;
  runId: string;
  runSeq: number;
  attempt: number;
  model: ResolvedModel;
  mode: CostMode;
}
