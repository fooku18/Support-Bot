import { createHash } from 'node:crypto';
import { isModelRoute, validModelKey, type ResolvedModel } from '../../contracts/model-catalog.js';
import type { RunLimitsDto } from '../../contracts/dto.js';
import { parseCoordinatorAdminDocument, type CoordinatorAdminDocument } from './admin-document.js';

/** Deployment-owned settings are distinct from the admin's source identity. */
export interface CoordinatorDeploymentConfig {
  modelPolicy: { defaultKey: string; models: ResolvedModel[] };
  admission: { global: number; perThread: number };
  execution: { maxInferenceInvocations: number };
}
/** Complete trusted snapshot. sourceJson preserves the admin's wire key order
 * across JSONB storage. Never reconstruct the source from a JSONB object. */
export interface CoordinatorConfig extends CoordinatorDeploymentConfig {
  version: number;
  hash: string;
  sourceJson: string;
}
export function coordinatorAdminSnapshot(input: CoordinatorConfig) {
  if (typeof input?.sourceJson !== 'string' || Buffer.byteLength(input.sourceJson) > 1024 * 1024)
    throw new Error('invalid admin source');
  return parseCoordinatorAdminDocument(JSON.parse(input.sourceJson));
}
export function deriveCoordinatorConfig(
  document: CoordinatorAdminDocument,
  deployment: CoordinatorDeploymentConfig,
): CoordinatorConfig {
  const snapshot = parseCoordinatorAdminDocument(document);
  const input = {
    version: snapshot.document.version,
    sourceJson: snapshot.sourceJson,
    ...deployment,
  };
  return validateCoordinatorConfig({ ...input, hash: coordinatorConfigHash(input) });
}
export function coordinatorConfigHash(input: Omit<CoordinatorConfig, 'hash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: input.version,
        sourceJson: input.sourceJson,
        modelPolicy: {
          defaultKey: input.modelPolicy.defaultKey,
          models: input.modelPolicy.models.map(({ key, model, route, connection, webSearch }) => ({
            key,
            model,
            route,
            connection,
            webSearch,
          })),
        },
        admission: { global: input.admission.global, perThread: input.admission.perThread },
        execution: { maxInferenceInvocations: input.execution.maxInferenceInvocations },
      }),
    )
    .digest('hex');
}
export function validateCoordinatorConfig(input: CoordinatorConfig): CoordinatorConfig {
  if (
    !input ||
    Object.keys(input).sort().join(',') !==
      'admission,execution,hash,modelPolicy,sourceJson,version' ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1
  )
    throw new Error('invalid config version or sections');
  const snapshot = coordinatorAdminSnapshot(input);
  if (snapshot.document.version !== input.version) throw new Error('admin version mismatch');
  if (
    Object.keys(input.modelPolicy ?? {})
      .sort()
      .join(',') !== 'defaultKey,models' ||
    Object.keys(input.admission ?? {})
      .sort()
      .join(',') !== 'global,perThread'
  )
    throw new Error('invalid deployment sections');
  if (
    Object.keys(input.execution ?? {}).join(',') !== 'maxInferenceInvocations' ||
    !Number.isSafeInteger(input.execution?.maxInferenceInvocations) ||
    input.execution.maxInferenceInvocations < 1 ||
    input.execution.maxInferenceInvocations > 10
  )
    throw new Error('invalid execution limits');
  const models = input.modelPolicy?.models;
  if (
    !Array.isArray(models) ||
    !models.length ||
    models.length > 16 ||
    new Set(models.map((m) => m.key)).size !== models.length ||
    !models.some((m) => m.key === input.modelPolicy.defaultKey) ||
    models.some(
      (m) =>
        !m ||
        Object.keys(m).sort().join(',') !== 'connection,key,model,route,webSearch' ||
        !validModelKey(m.key) ||
        !isModelRoute(m.route) ||
        typeof m.model !== 'string' ||
        typeof m.connection !== 'string' ||
        typeof m.webSearch !== 'boolean',
    )
  )
    throw new Error('invalid model policy');
  if (
    ![input.admission?.global, input.admission?.perThread].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 10000,
    )
  )
    throw new Error('invalid admission limits');
  if (input.hash !== coordinatorConfigHash(input)) throw new Error('config hash mismatch');
  return structuredClone(input);
}

/** Historical settings of one logical run. Current authorization is always
 * re-evaluated from coordinatorAdminSnapshot(currentConfig).policySource. */
export interface CoordinatorRunConfiguration {
  config: { version: number; hash: string; adminHash: string };
  tools: import('../../contracts/dto.js').ChannelToolDto[];
  /** Runtime-owned logical-run session pin, populated by the first session ACK. */
  nativeSession?: { id: string; resumed: boolean };
  channel: { modelKey: string | null; systemPrompt: string | null; autoReplies: boolean };
  runLimits: RunLimitsDto;
  maxInferenceInvocations: number;
}
export function coordinatorRunConfiguration(
  config: CoordinatorConfig,
  teamId: string,
  channelId: string,
): CoordinatorRunConfiguration {
  const snapshot = coordinatorAdminSnapshot(config).document;
  const channel = snapshot.toolAssignments.find(
    (c) => c.teamId === teamId && c.channelId === channelId,
  );
  return {
    config: { version: config.version, hash: config.hash, adminHash: snapshot.hash },
    channel: {
      modelKey: channel?.modelKey ?? null,
      systemPrompt: channel?.systemPrompt ?? null,
      autoReplies: channel?.autoReplies ?? false,
    },
    tools: structuredClone(channel?.tools ?? []),
    runLimits: snapshot.runLimits,
    maxInferenceInvocations: config.execution.maxInferenceInvocations,
  };
}

/** Exact channel identity for deployment-owned reply enablement epochs. */
export const coordinatorReplyChannelKey = (teamId: string, channelId: string) =>
  JSON.stringify([teamId, channelId]);

export function resolveChannelModel(config: CoordinatorConfig, teamId: string, channelId: string) {
  const { channel } = coordinatorRunConfiguration(config, teamId, channelId);
  return config.modelPolicy.models.find(
    ({ key }) => key === (channel.modelKey ?? config.modelPolicy.defaultKey),
  );
}
