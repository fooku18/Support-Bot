#!/usr/bin/env node
/** Generate self-contained admin/Slack transport contracts from the agent package.
 * Process images retain only their own generated clients; canonical domain
 * policy, delivery and wire vocabulary live in apps/agent. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { format } from 'prettier';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

/** Named top-level declarations extracted from apps/agent/src/contracts/protocol.ts. */
const PROTOCOL_EXPORTS = [
  'PROTOCOL_VERSION',
  'CONTEXT_STATUS_COMPLETE',
  'CONTEXT_STATUS_TRUNCATED',
  'ContextStatus',
  'RUN_STATUS_AWAITING_CONTEXT',
  'RUN_STATUS_QUEUED',
  'RUN_STATUS_RUNNING',
  'RUN_STATUS_CANCELLING',
  'RUN_STATUS_CANCELLED',
  'RUN_STATUS_COMPLETED',
  'RUN_STATUS_FAILED',
  'RUN_STATUS_PAUSED',
  'RunStatus',
  'OUTBOX_STATE_PENDING',
  'OUTBOX_STATE_DELIVERING',
  'OUTBOX_STATE_SETTLED',
  'OUTBOX_STATE_DELIVERED',
  'OUTBOX_STATE_UNCERTAIN',
  'OutboxState',
  'AGENT_PROGRESS_STAGES',
  'AgentProgressStage',
  'AGENT_TOOL_CATEGORIES',
  'AgentToolCategory',
  'AGENT_PROGRESS_SOURCES',
  'AgentProgressSource',
  'isAgentProgressStage',
  'isAgentToolCategory',
  'isAgentProgressSource',
  'PROGRESS_MARKER',
  'SOFT_LIMIT_METRICS',
  'SoftLimitMetric',
  'isSoftLimitMetric',
  'SoftLimitReading',
  'renderSoftLimitReading',
  'progressStageLabel',
  'renderProgressText',
  'DELIVERY_METADATA_EVENT_TYPE',
  'DeliveryMetadata',
  'SlackDeliveryMetadata',
  'deliveryMetadata',
  'parseDeliveryMetadata',
  'CONTROL_KIND_STEER',
  'CONTROL_KIND_CANCEL',
  'ControlKind',
  'CONTROL_STATE_PENDING',
  'CONTROL_STATE_DISPATCHING',
  'CONTROL_STATE_APPLIED',
  'CONTROL_STATE_UNCERTAIN',
  'CONTROL_STATE_SUPERSEDED',
  'CONTROL_STATE_CONVERTED',
  'CONTROL_STATE_REJECTED',
  'ControlState',
  'STEERING_CLOSED',
  'STEERING_OPEN',
  'STEERING_DRAINING',
  'SteeringState',
  'CANCELLATION_CONFIRMED',
  'CANCELLATION_PROVIDER_UNCONFIRMED',
  'CANCELLATION_EFFECTS_UNCERTAIN',
  'CANCELLATION_LEASE_EXPIRED',
  'CANCELLATION_CONVERTED_TO_STEERING',
  'CancellationOutcome',
  'INTAKE_ROUTING_RUN',
  'INTAKE_ROUTING_STEERING',
  'INTAKE_ROUTING_CANCEL',
  'INTAKE_ROUTING_REJECTED',
  'INTAKE_ROUTING_NO_ACTIVE_RUN',
  'INTAKE_ROUTING_QUEUED_FOLLOWUP',
  'INTAKE_ROUTING_INVALID',
  'INTAKE_ROUTING_BUSY',
  'IntakeRouting',
  'AdmissionScope',
  'CONTROL_REPLY_NO_ACTIVE_RUN',
  'CONTROL_REPLY_UNAUTHORIZED',
  'CONTROL_REPLY_UNCERTAIN',
  'CONTROL_REPLY_QUEUED_FOLLOWUP',
  'CONTROL_REPLY_EMPTY_UPDATE',
  'CONTROL_REPLY_BUSY',
  'OUTBOX_ACTIONS',
  'OutboxAction',
  'isOutboxAction',
  'TaskSummary',
  'PendingFlag',
  'CLAUDE_FAILURE_CATEGORIES',
  'ClaudeFailureCategory',
  'RUN_FAILURE_REASONS',
  'RunFailureReason',
  'runFailureReason',
  'TOOL_FAILURE_CLASSES',
  'ToolFailureClass',
  'DENIED_TOOL_CATEGORIES',
  'DeniedToolCategory',
  'MAX_TOOL_TRACE_ENTRIES',
  'TOOL_OPERATION_KIND_PATTERN',
  'RUN_ID_PATTERN',
  'SDK_VERSION_PATTERN',
];

const TARGETS = ['apps/slack/src/generated/protocol.ts'];
const POLICY_TARGET = 'apps/admin/src/generated/authorization-policy.ts';
const TOOL_KINDS_TARGET = 'apps/admin/src/generated/tool-kinds.ts';
const MESSAGE_CONTENT_TARGETS = ['apps/slack/src/generated/slack-message-content.ts'];

function extractDeclaration(source, name) {
  const pattern = new RegExp(`export\\s+(const|type|interface|function)\\s+${name}\\b`);
  const match = pattern.exec(source);
  if (match === null) {
    throw new Error(`protocol export not found: ${name}`);
  }
  let start = match.index;
  // Include a directly preceding JSDoc/TSDoc comment block when present.
  const before = source.slice(0, start);
  const commentStart = before.lastIndexOf('/**');
  if (commentStart >= 0) {
    const between = before.slice(commentStart);
    if (/^\/\*\*[\s\S]*\*\/\s*$/.test(between)) {
      start = commentStart;
    }
  }
  const keyword = match[1];
  if (keyword === 'interface') {
    return sliceBalanced(source, start, source.indexOf('{', match.index));
  }
  if (keyword === 'function') {
    const braceIndex = source.indexOf('{', match.index);
    if (braceIndex < 0) {
      throw new Error(`unterminated function: ${name}`);
    }
    return sliceBalanced(source, start, braceIndex);
  }
  // const / type: capture through the terminating semicolon at depth zero.
  let i = match.index;
  let depthBrace = 0;
  let depthBracket = 0;
  let depthParen = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace -= 1;
    else if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket -= 1;
    else if (ch === '(') depthParen += 1;
    else if (ch === ')') depthParen -= 1;
    else if (ch === ';' && depthBrace === 0 && depthBracket === 0 && depthParen === 0) {
      return source.slice(start, i + 1).trim();
    }
  }
  throw new Error(`unterminated declaration: ${name}`);
}

function sliceBalanced(source, start, braceIndex) {
  let i = braceIndex;
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1).trim();
    }
  }
  throw new Error('unterminated interface block');
}

async function main() {
  const protocolSource = [
    'contracts/protocol.ts',
    'domain/delivery/replies.ts',
    'domain/delivery/metadata.ts',
  ]
    .map((file) => readFileSync(path.join(REPO_ROOT, 'apps/agent/src', file), 'utf8'))
    .join('\n');
  const dtoSource = readFileSync(path.join(REPO_ROOT, 'apps/agent/src/contracts/dto.ts'), 'utf8');
  const versionRecord = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/agent/src/contracts/version.json'), 'utf8'),
  );

  const versionMatch = /export const PROTOCOL_VERSION = (\d+);/.exec(protocolSource);
  if (versionMatch === null) {
    throw new Error('PROTOCOL_VERSION not found in apps/agent/src/contracts/protocol.ts');
  }
  const protocolVersion = Number(versionMatch[1]);
  if (versionRecord.protocolVersion !== protocolVersion) {
    throw new Error(
      `apps/agent/src/contracts/version.json protocolVersion (${versionRecord.protocolVersion}) ` +
        `does not match PROTOCOL_VERSION (${protocolVersion}); update both together`,
    );
  }

  const protocolBlocks = PROTOCOL_EXPORTS.map((name) => extractDeclaration(protocolSource, name));

  // dto.ts contributes every exported declaration; its only import is the
  // type-only reference to ./protocol.js, replaced by the blocks above.
  // Multi-line imports are stripped as whole statements so prettier may
  // format the canonical source freely.
  const stripImports = (source) =>
    source.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '').trim();
  const dtoBody = stripImports(dtoSource)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const header =
    '/**\n' +
    ' * GENERATED from the shared application contract — do not hand-edit.\n' +
    ' *\n' +
    ` * Protocol version ${protocolVersion} (application contract ${versionRecord.packageVersion}).\n` +
    ' * Canonical sources: apps/agent/src/contracts/ and apps/agent/src/domain/delivery/.\n' +
    ' * Regenerate with:\n' +
    ' *\n' +
    ' *   npm run generate:protocol\n' +
    ' */\n';

  const content = header + '\n' + protocolBlocks.join('\n\n') + '\n\n' + dtoBody + '\n';

  const policySource = readFileSync(
    path.join(REPO_ROOT, 'apps/agent/src/domain/authorization/policy.ts'),
    'utf8',
  );
  const policyMirror =
    '/**\n' +
    ' * GENERATED verbatim from apps/agent/src/domain/authorization/policy.ts — do not\n' +
    ' * hand-edit. Regenerate with:\n' +
    ' *\n' +
    ' *   npm run generate:protocol\n' +
    ' */\n\n' +
    policySource;
  const toolKindsSource = readFileSync(
    path.join(REPO_ROOT, 'apps/agent/src/contracts/tool-kinds.ts'),
    'utf8',
  );
  const toolKindsMirror =
    '/**\n' +
    ' * GENERATED verbatim from apps/agent/src/contracts/tool-kinds.ts — do not hand-edit.\n' +
    ' * Regenerate with:\n' +
    ' *\n' +
    ' *   npm run generate:protocol\n' +
    ' */\n\n' +
    toolKindsSource;
  const messageContentSource = readFileSync(
    path.join(REPO_ROOT, 'apps/agent/src/contracts/slack-message-content.ts'),
    'utf8',
  );
  const messageContentMirror =
    '/**\n' +
    ' * GENERATED verbatim from apps/agent/src/contracts/slack-message-content.ts — do\n' +
    ' * not hand-edit. Regenerate with:\n' +
    ' *\n' +
    ' *   npm run generate:protocol\n' +
    ' */\n\n' +
    messageContentSource;
  const commandSource = readFileSync(
    path.join(REPO_ROOT, 'apps/agent/src/contracts/channel-commands.ts'),
    'utf8',
  );
  const commandMirror =
    '/** GENERATED from apps/agent/src/contracts/channel-commands.ts; run npm run generate:protocol. */\n' +
    commandSource;
  const modelCatalogSource = readFileSync(
    path.join(REPO_ROOT, 'apps/agent/src/contracts/model-catalog.ts'),
    'utf8',
  );
  const modelCatalogHeader =
    '/** GENERATED from apps/agent/src/contracts/model-catalog.ts. Run npm run generate:protocol. */\n';
  const formatJavascript = (source) =>
    format(transformSync(source, { loader: 'ts', format: 'esm' }).code, {
      parser: 'babel',
      singleQuote: true,
      printWidth: 100,
    });
  const citationSource = 'apps/agent/src/contracts/markdown-citation.ts';
  const citationMirror =
    `/** GENERATED from ${citationSource}. Run npm run generate:protocol. */\n` +
    (await formatJavascript(readFileSync(path.join(REPO_ROOT, citationSource), 'utf8')));
  const addressContract = 'apps/agent/src/contracts/model-address.ts';
  const mirrors = [
    [
      'apps/egress/src/generated/model-address.ts',
      `/** GENERATED from ${addressContract}. Run npm run generate:protocol. */\n` +
        readFileSync(path.join(REPO_ROOT, addressContract), 'utf8'),
    ],
    ...['apps/admin', 'apps/egress', 'apps/tool-runtime'].map((pkg) => [
      `${pkg}/src/generated/model-catalog.ts`,
      modelCatalogHeader + modelCatalogSource,
    ]),
    [
      'deploy/lib/model-catalog.mjs',
      modelCatalogHeader + (await formatJavascript(modelCatalogSource)),
    ],
    ['tests/live/markdown-citation.mjs', citationMirror],
    [
      'apps/slack/src/generated/trusted-bot-sender.ts',
      '/** GENERATED from apps/agent/src/domain/authorization/trusted-bot-sender.ts; run npm run generate:protocol. */\n' +
        readFileSync(
          path.join(REPO_ROOT, 'apps/agent/src/domain/authorization/trusted-bot-sender.ts'),
          'utf8',
        ),
    ],
    ...['native-inputs', 'native-exports', 'long-answer', 'file-inputs'].map((name) => {
      const source = ['native-exports', 'long-answer'].includes(name)
        ? `domain/delivery/${name}.ts`
        : `domain/files/${name}.ts`;
      return [
        `apps/slack/src/generated/${name}.ts`,
        `/** GENERATED from apps/agent/src/${source}; run npm run generate:protocol. */\n` +
          readFileSync(path.join(REPO_ROOT, 'apps/agent/src', source), 'utf8').replace(
            /(['"])(?:\.\.\/)+contracts\/dto\.js\1/g,
            "'./protocol.js'",
          ),
      ];
    }),
    [
      'apps/slack/src/generated/slack-messages.ts',
      '/** GENERATED from apps/agent/src/contracts/slack-messages.ts; run npm run generate:protocol. */\n' +
        readFileSync(path.join(REPO_ROOT, 'apps/agent/src/contracts/slack-messages.ts'), 'utf8'),
    ],
    ...['apps/admin', 'apps/slack'].map((pkg) => [
      `${pkg}/src/generated/channel-commands.ts`,
      commandMirror,
    ]),
    ...TARGETS.map((target) => [target, content]),
    [POLICY_TARGET, policyMirror],
    [TOOL_KINDS_TARGET, toolKindsMirror],
    ...MESSAGE_CONTENT_TARGETS.map((target) => [target, messageContentMirror]),
  ];

  let drifted = [];
  for (const [target, expected] of mirrors) {
    const file = path.join(REPO_ROOT, target);
    let current = null;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    if (current !== expected) {
      drifted.push(target);
      if (!CHECK) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, expected);
      }
    }
  }
  if (CHECK && drifted.length > 0) {
    console.error(`protocol mirrors drifted: ${drifted.join(', ')}`);
    console.error('run `npm run generate:protocol` and commit the result.');
    process.exit(1);
  }
  if (!CHECK) {
    console.log(`generated ${mirrors.length} protocol mirrors (protocol v${protocolVersion}).`);
  } else {
    console.log(`protocol mirrors up to date (protocol v${protocolVersion}).`);
  }
}

main();
