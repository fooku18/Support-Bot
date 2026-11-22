import type { ResolvedModel } from '../contracts/model-catalog.js';
import type { ModelBinding } from '../integrations/providers/access.js';
import type { Pool } from 'pg';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { NativeCodingOptions } from '../mastra/tools/coding.js';
import type { createReadServiceTools } from '../mastra/tools/read-services.js';
import type { IntakeRequest } from '../contracts/dto.js';
import type { NativeInputClient } from '../integrations/slack/input-client.js';
import type { CoordinatorConfig } from './configuration/config.js';
import type { NativeExport, NativeExportReceipt } from '../domain/delivery/native-exports.js';
import type { AnswerFileReceipt, NativeAnswerFile } from '../domain/delivery/long-answer.js';
import type { StageLogger } from '../infrastructure/logger.js';

type ServiceBinding = Parameters<typeof createReadServiceTools>[0];
export interface NativeAgentOptions {
  /** Credential-owning adapter closure. No model-driven fetch. */
  inputs?: NativeInputClient;
  /** Trusted workspace and publication binding. The binding is absent when GitLab is unavailable. */
  coding?: {
    version: string;
    prepare(input: {
      identity: IntakeRequest;
      taskKey: string;
      workspaceId: string;
      runId: string;
      signal: AbortSignal;
      authorize(): Promise<void>;
    }): Promise<
      | Omit<NativeCodingOptions, 'workspaceId' | 'run' | 'signal' | 'authorize' | 'publication'>
      | undefined
    >;
  };
  pool: Pool;
  storage: MastraCompositeStore;
  /** Operational log for refused, unknown and unconfirmed outcomes. Lines carry
   * run IDs and refusal codes only. */
  log: StageLogger;
  /** Explicitly configured separate telemetry store; absent in isolated harnesses. */
  observability?: boolean;
  /** Current trusted config, not a retained run's settings. No model-supplied config. */
  configuration(): Promise<CoordinatorConfig>;
  /** Current Slack installation, requester membership and source authority. */
  authority?(identity: IntakeRequest): Promise<void>;
  /** Process-local provider binding. Credentials never enter durable context. */
  bindModel(
    selection: ResolvedModel,
    identity: IntakeRequest,
    attribution?: { runId: string; runSeq: number; studio?: boolean },
  ): ModelBinding;
  instructions: string;
  services(
    identity: IntakeRequest,
    signal: AbortSignal,
  ): Promise<Omit<ServiceBinding, 'authorize'>>;
  /** Existing channel-memory authority; returns trusted instructions only. */
  channelInstructions(identity: IntakeRequest): Promise<string>;
  limits: { contextTokens: number; outputTokens: number; maxSteps: number; timeoutMs: number };
}
export type NativeAgentInput = IntakeRequest & {
  files?: import('../contracts/dto.js').SlackFileDescriptorDto[];
};
export interface IdentityRow {
  run_id: string;
  task_key: string;
  owner: string;
  accepted: NativeAgentInput;
  execution_policy_hash: string;
}
export type NativeAgentSender = (value: {
  operationId: string;
  taskKey: string;
  channel: string;
  rootTs: string;
  requesterUserId: string;
  text: string;
  /** Context line under a final answer (check mark and model); absent on notices. */
  footer?: string;
  files?: NativeExport[];
  /** The full answer when `text` is only its preview (long answers). */
  answerFile?: NativeAnswerFile;
  authority?: { runId: string; actor: string; owner: string };
}) => Promise<{
  ts?: string;
  files?: NativeExportReceipt[];
  /** Outcome of `answerFile`: the confirmed thread file, or not attached. */
  answerFile?: AnswerFileReceipt;
}>;
