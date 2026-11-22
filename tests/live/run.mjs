#!/usr/bin/env node
/** Designated-instance scenario driver (T4 and T5).
 * The instance's model mode is the one `test:stack:up --model-mode` recorded.
 * On a stub instance the driver runs `"model": "stub"` scenarios against the
 * model stub: deterministic qualification, never live acceptance. Gateway
 * scenarios must declare `covers` and `budget` (the live-scenario gate).
 * The driver changes the stack only with `--switch-mode`, through
 * `test:stack:down|up`, and always returns it to the recorded mode. With
 * `E2E_ADMIN_TOKEN` it sets the test channel's tool assignment to what each
 * scenario needs and restores the original afterwards. */
import fs from 'node:fs';
import path from 'node:path';
import { markdownCitationLinks } from './markdown-citation.mjs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { stubModelCatalog } from '../../deploy/lib/model-catalog.mjs';
import { readEnvFile } from '../../deploy/lib/env-contract.mjs';
import {
  deployment,
  compose,
  requireNativeProject,
  readModelMode,
  status,
} from '../../deploy/lib/native-deployment.mjs';
import { TOOL_KINDS as ASSIGNMENT_KINDS } from '../../apps/agent/src/contracts/tool-kinds.ts';
import { acquireEnvironmentLock } from '../../deploy/lib/environment-lock.mjs';

/** Kinds that gateway scenarios can request and select with --tools. */
export const TOOL_KINDS = [
  'gitlab',
  'atlassian',
  'datadog',
  'cloudflare',
  'slack',
  'webSearch',
  'webFetch',
];
export class LiveError extends Error {
  constructor(code, blocked = false) {
    super(code);
    this.blocked = blocked;
  }
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => {
  throw new LiveError(code, true);
};
export function validateScenario(value) {
  const keys = (v, allowed) =>
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).every((k) => allowed.includes(k));
  if (
    !keys(value, ['name', 'mode', 'model', 'covers', 'budget', 'requires', 'steps', 'isolation']) ||
    !['answer', 'coding'].includes(value.mode ?? 'answer') ||
    !['stub', 'gateway'].includes(value.model ?? 'gateway') ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 150 ||
    !Array.isArray(value.steps) ||
    !value.steps.length ||
    value.steps.length > 8
  )
    fail('invalid_native_scenario');
  if (value.mode !== 'coding' && !value.isolation) fail('invalid_native_scenario');
  // The live-scenario gate: a gateway scenario declares what it uniquely
  // covers and its size (posted turns, upper bound of model requests).
  if (
    value.covers !== undefined &&
    (!Array.isArray(value.covers) ||
      !value.covers.length ||
      value.covers.length > 8 ||
      !value.covers.every(
        (c) => typeof c === 'string' && /^[a-z0-9][a-z0-9 ./:-]{2,119}$/.test(c),
      ) ||
      new Set(value.covers).size !== value.covers.length)
  )
    fail('invalid_gate_covers');
  if (
    value.budget !== undefined &&
    (!keys(value.budget, ['turns', 'modelRequests']) ||
      !Number.isSafeInteger(value.budget.turns) ||
      value.budget.turns < 1 ||
      value.budget.turns > 9 ||
      !Number.isSafeInteger(value.budget.modelRequests) ||
      value.budget.modelRequests < 1 ||
      value.budget.modelRequests > 200)
  )
    fail('invalid_gate_budget');
  if ((value.model ?? 'gateway') === 'gateway' && (!value.covers || !value.budget))
    fail('gateway_gate_fields_required');
  if (value.budget && value.steps.length + (value.isolation ? 1 : 0) > value.budget.turns)
    fail('gateway_turn_budget_exceeded');
  // Tool kinds that must be assigned and ready in the test channel.
  if (
    value.requires !== undefined &&
    (!Array.isArray(value.requires) ||
      !value.requires.length ||
      !value.requires.every((k) => TOOL_KINDS.includes(k)) ||
      new Set(value.requires).size !== value.requires.length)
  )
    fail('invalid_native_scenario');
  // Stub suite only (live-test-rules.md): editing or deleting the sender's
  // own messages of this run, and changing the test channel's settings.
  const stub = value.model === 'stub';
  // The stub suite needs only Docker and the Slack test app: no scenario of it
  // uses a tool instance (tools are T3 `tools` and the gateway suite).
  if (stub && neededTools(value).length > 0) fail('stub_scenario_needs_no_tools');
  const changed = new Set();
  for (const [index, step] of value.steps.entries()) {
    if (!isChangeStep(step)) continue;
    if (!stub) fail('stub_suite_only_step');
    const target = step.edit?.step ?? step.delete?.step;
    if (
      !keys(step, ['edit', 'delete', 'settleSeconds', 'excludes']) ||
      (step.edit !== undefined) === (step.delete !== undefined) ||
      (step.edit !== undefined && !keys(step.edit, ['step', 'prompt'])) ||
      (step.delete !== undefined && !keys(step.delete, ['step'])) ||
      !Number.isSafeInteger(target) ||
      target < 0 ||
      target >= index ||
      isChangeStep(value.steps[target]) ||
      value.steps[target].refused ||
      // A deleted message cannot be edited or deleted again.
      changed.has(`delete:${target}`) ||
      (step.edit !== undefined && !validPrompt(step.edit.prompt)) ||
      !validSettle(step.settleSeconds) ||
      (step.excludes !== undefined &&
        (!Array.isArray(step.excludes) ||
          step.excludes.length > 12 ||
          !step.excludes.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 300)))
    )
      fail('invalid_native_scenario');
    if (step.delete) changed.add(`delete:${target}`);
  }
  for (const step of value.steps) {
    if (isChangeStep(step)) continue;
    if ((step.refused !== undefined || step.channelSettings !== undefined) && !stub)
      fail('stub_suite_only_step');
    if (
      step.refused !== undefined &&
      (step.refused !== true ||
        step.contains !== undefined ||
        step.wait !== undefined ||
        step.cancel ||
        step.question ||
        step.resume ||
        step.attachments ||
        step.publication ||
        step.exports ||
        step.webSearch ||
        step.webFetch ||
        step.longAnswer)
    )
      fail('invalid_native_scenario');
    if ((step.settleSeconds !== undefined && !step.refused) || !validSettle(step.settleSeconds))
      fail('invalid_native_scenario');
    if (step.channelSettings !== undefined && !validChannelSettings(step.channelSettings))
      fail('invalid_native_scenario');
    if (
      step.longAnswer !== undefined &&
      (!keys(step.longAnswer, ['previewContains', 'previewExcludes']) ||
        ![
          ...(step.longAnswer.previewContains ?? []),
          ...(step.longAnswer.previewExcludes ?? []),
        ].every((x) => typeof x === 'string' && x.length > 0 && x.length <= 300) ||
        [step.longAnswer.previewContains, step.longAnswer.previewExcludes].some(
          (a) => a !== undefined && (!Array.isArray(a) || a.length > 12),
        ))
    )
      fail('invalid_native_scenario');
    if (
      !stub &&
      [...(step.contains ?? []), ...(step.excludes ?? [])].some((x) => x.includes('{{channel.'))
    )
      fail('stub_suite_only_step');
  }
  // A held step (`wait: false`) is not awaited; the next step cancels it with
  // the `cancel` control or deletes its message.
  for (const [index, step] of value.steps.entries()) {
    if (isChangeStep(step)) continue;
    if (step.wait !== undefined && step.wait !== false) fail('invalid_native_scenario');
    if (step.cancel !== undefined && step.cancel !== true) fail('invalid_native_scenario');
    if (
      step.wait === false &&
      (!(value.steps[index + 1]?.cancel || value.steps[index + 1]?.delete?.step === index) ||
        step.question ||
        step.resume ||
        step.publication ||
        step.exports ||
        step.webSearch ||
        step.webFetch)
    )
      fail('invalid_native_scenario');
    if (
      step.cancel &&
      (value.steps[index - 1]?.wait !== false ||
        !/^cancel$/i.test(step.prompt ?? '') ||
        step.mention === false ||
        step.attachments ||
        step.messageAttachments)
    )
      fail('invalid_native_scenario');
    if (step.messageAttachments !== undefined) {
      const raw = JSON.stringify(step.messageAttachments);
      if (
        !Array.isArray(step.messageAttachments) ||
        !step.messageAttachments.length ||
        step.messageAttachments.length > 4 ||
        !step.messageAttachments.every((a) => a && typeof a === 'object' && !Array.isArray(a)) ||
        raw.length > 4000 ||
        /<operator:|<@|<!/i.test(raw) ||
        step.attachments
      )
        fail('invalid_native_scenario');
    }
  }
  if (
    value.isolation?.wait !== undefined ||
    value.isolation?.cancel ||
    value.isolation?.channelSettings ||
    value.isolation?.refused ||
    (value.isolation && isChangeStep(value.isolation))
  )
    fail('invalid_native_scenario');
  // A question step expects the run to suspend with an ask_user question; the
  // next step answers it (`continue <answer>`) and the same run resumes.
  for (const [index, step] of value.steps.entries()) {
    if (isChangeStep(step)) continue;
    if (
      step.resume &&
      (!value.steps[index - 1]?.question ||
        !/^continue\s+\S/i.test(step.prompt ?? '') ||
        step.mention === false ||
        step.attachments)
    )
      fail('invalid_native_scenario');
    if (
      step.question &&
      (step.publication || step.exports || step.webSearch || step.webFetch || step.resume)
    )
      fail('invalid_native_scenario');
  }
  if (value.isolation?.question || value.isolation?.resume) fail('invalid_native_scenario');
  for (const step of [...value.steps, ...(value.isolation ? [value.isolation] : [])]) {
    if (isChangeStep(step)) continue;
    if (
      !keys(step, [
        'prompt',
        'refused',
        'settleSeconds',
        'channelSettings',
        'longAnswer',
        'contains',
        'excludes',
        'mention',
        'working',
        'webSearch',
        'webFetch',
        'attachments',
        'question',
        'resume',
        'wait',
        'cancel',
        'messageAttachments',
        'discovery',
        ...(value.mode === 'coding' ? ['publication', 'exports'] : []),
      ]) ||
      (step.mention !== undefined && typeof step.mention !== 'boolean') ||
      (step.working !== undefined && typeof step.working !== 'boolean') ||
      (step.question !== undefined && typeof step.question !== 'boolean') ||
      (step.resume !== undefined && typeof step.resume !== 'boolean') ||
      (step.discovery !== undefined &&
        (step.discovery !== true || step.publication || step.exports)) ||
      !validPrompt(step.prompt) ||
      // A held or refused step has no answer of its own; it may only name what
      // must never appear.
      (step.wait === false || step.refused
        ? step.contains !== undefined
        : !Array.isArray(step.contains) || !step.contains.length) ||
      step.contains?.length > 12 ||
      ![...(step.contains ?? []), ...(step.excludes ?? [])].every(
        (s) => typeof s === 'string' && s.length > 0 && s.length <= 300,
      ) ||
      (step.excludes !== undefined && !Array.isArray(step.excludes))
    )
      fail('invalid_native_scenario');
    if (
      step.webSearch !== undefined &&
      (!keys(step.webSearch, ['minSearches']) ||
        !Number.isSafeInteger(step.webSearch.minSearches) ||
        step.webSearch.minSearches < 1 ||
        step.webSearch.minSearches > 8)
    )
      fail('invalid_search_fixture');
    if (step.webFetch !== undefined) {
      if (!keys(step.webFetch, ['url']) || typeof step.webFetch.url !== 'string')
        fail('invalid_fetch_fixture');
      let url;
      try {
        url = new URL(step.webFetch.url);
      } catch {
        fail('invalid_fetch_fixture');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        fail('invalid_fetch_fixture');
    }
    for (const kind of ['attachments', 'exports']) {
      const files = step[kind];
      if (files !== undefined && (!Array.isArray(files) || !files.length || files.length > 4))
        fail('invalid_file_fixture');
      for (const f of files ?? []) {
        if (
          !keys(f, kind === 'attachments' ? ['name', 'data'] : ['name', 'bytes', 'sha256']) ||
          typeof f.name !== 'string' ||
          !f.name ||
          f.name.length > 160 ||
          /[\p{Cc}/\\]/u.test(f.name)
        )
          fail('invalid_file_fixture');
        if (kind === 'attachments') {
          if (
            typeof f.data !== 'string' ||
            f.data.length > 280000 ||
            !f.data.length ||
            Buffer.from(f.data, 'base64').toString('base64') !== f.data
          )
            fail('invalid_file_fixture');
        } else if (
          !Number.isSafeInteger(f.bytes) ||
          f.bytes < 1 ||
          f.bytes > 2 * 1024 ** 2 ||
          !/^[a-f0-9]{64}$/.test(f.sha256 ?? '')
        )
          fail('invalid_file_fixture');
      }
    }
    if (value.mode === 'coding') {
      const p = step.publication;
      // A discovery-only step can assert read tools without publication.
      if (p === undefined && (step.webSearch || step.webFetch || step.question || step.discovery))
        continue;
      if (
        !keys(p, ['host', 'project', 'projectId', 'targetBranch', 'files']) ||
        !/^[a-z0-9.-]+$/.test(p.host ?? '') ||
        !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(p.project ?? '') ||
        !Number.isSafeInteger(p.projectId) ||
        p.projectId < 1 ||
        !/^[a-zA-Z0-9_./-]+$/.test(p.targetBranch ?? '') ||
        !Array.isArray(p.files) ||
        !p.files.length ||
        p.files.length > 10
      )
        fail('invalid_publication_fixture');
      for (const file of p.files) {
        if (
          !keys(file, ['path', 'contains']) ||
          typeof file.path !== 'string' ||
          !file.path ||
          file.path.startsWith('/') ||
          file.path.split('/').some((x) => !x || x === '..' || x === '.') ||
          !Array.isArray(file.contains) ||
          !file.contains.length ||
          !file.contains.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 300)
        )
          fail('invalid_publication_fixture');
      }
    }
  }
  return value;
}
/** An edit or delete of an earlier step's message (stub suite only). */
function isChangeStep(step) {
  return !!step && typeof step === 'object' && ('edit' in step || 'delete' in step);
}
function validPrompt(prompt) {
  return (
    typeof prompt === 'string' &&
    !!prompt.trim() &&
    prompt.length <= 3000 &&
    !/<operator:|<@|<!/i.test(prompt)
  );
}
/** Seconds a refused or changed step watches for an unexpected run or answer. */
function validSettle(seconds) {
  return seconds === undefined || (Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 180);
}
/** Test channel settings a stub step may change; `restore` returns one to its original. */
export const CHANNEL_SETTINGS = {
  enabled: (v) => v === false || v === 'restore',
  blocked: (v) => v === true || v === 'restore',
  model: (v) => v === 'alternate' || v === 'restore',
  prompt: (v) =>
    typeof v === 'string' && !!v.trim() && v.length <= 500 && !/<operator:|<@|<!/i.test(v),
};
function validChannelSettings(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(([k, v]) => CHANNEL_SETTINGS[k]?.(v) === true)
  );
}
/** Tool kinds a scenario needs in the test channel: its `requires`, `webSearch`
 * and `webFetch` for steps that use them, and GitLab for a publication. Every
 * other kind must be unassigned. Works on unvalidated scenario files too. */
export function neededTools(scenario) {
  const steps = [
    ...(Array.isArray(scenario?.steps) ? scenario.steps : []),
    ...(scenario?.isolation ? [scenario.isolation] : []),
  ];
  const kinds = new Set(Array.isArray(scenario?.requires) ? scenario.requires : []);
  if (steps.some((s) => s?.webSearch)) kinds.add('webSearch');
  if (steps.some((s) => s?.webFetch)) kinds.add('webFetch');
  if (steps.some((s) => s?.publication)) kinds.add('gitlab');
  return TOOL_KINDS.filter((k) => kinds.has(k));
}
/** The exact assignment a scenario needs, from the workspace's existing
 * instances: one ready instance per needed kind (GitLab: the one on the
 * scenario's host), nothing else. None is BLOCKED. Several are BLOCKED unless
 * the channel already has one of them assigned: the driver never guesses. */
export function toolTarget(needs, instances, current, gitlabHost) {
  const target = {};
  for (const kind of needs) {
    let candidates = instances.filter((i) => i.kind === kind && i.ready);
    if (kind === 'gitlab' && gitlabHost)
      candidates = candidates.filter((i) => i.host === gitlabHost);
    if (!candidates.length) fail(`ready_${kind}_instance_required`);
    const chosen =
      candidates.length === 1
        ? candidates[0]
        : candidates.find((i) => i.id === current[kind]?.instanceId);
    if (!chosen) fail(`ambiguous_${kind}_instance`);
    target[kind] = chosen.id;
  }
  return target;
}
/** `--tools`: `all` (default), `none`, or a comma list of tool kinds. */
export function parseToolScope(value = 'all') {
  if (value === 'all' || value === 'none') return value;
  const kinds = String(value)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (!kinds.length || !kinds.every((k) => TOOL_KINDS.includes(k)))
    throw new Error(`--tools takes all, none or a comma list of ${TOOL_KINDS.join(', ')}`);
  return TOOL_KINDS.filter((k) => kinds.includes(k));
}
/** Whether a scenario needing `needs` runs in `scope`. */
export function inToolScope(needs, scope) {
  if (scope === 'all') return true;
  return needs.every((k) => scope !== 'none' && scope.includes(k));
}
export function loadLive(root) {
  // `test:stack:up` records the mode; before the first start it is unknown.
  const mode = readModelMode(root) ?? fail('model_mode_unknown_start_with_test_stack_up');
  const d = deployment(path.join(root, '.env.testing'), { modelMode: mode });
  const file = path.join(root, '.env.e2e');
  if ((fs.statSync(file).mode & 0o077) !== 0) fail('harness_env_must_be_private');
  const env = readEnvFile(file);
  for (const [key, pattern] of [
    ['E2E_SLACK_TEAM_ID', /^T[A-Z0-9]+$/],
    ['E2E_SLACK_CHANNEL_ID', /^[CG][A-Z0-9]+$/],
  ])
    if (!pattern.test(env[key] ?? '')) fail(`missing_${key}`);
  if (!env.E2E_SLACK_SENDER_TOKEN?.trim() || /<operator:/i.test(env.E2E_SLACK_SENDER_TOKEN))
    fail('missing_E2E_SLACK_SENDER_TOKEN');
  if (Object.values(d.env).includes(env.E2E_SLACK_SENDER_TOKEN))
    fail('sender_credential_not_harness_only');
  // Optional settings-service API token for channel tool changes; harness only.
  if (env.E2E_ADMIN_TOKEN && Object.values(d.env).includes(env.E2E_ADMIN_TOKEN))
    fail('admin_token_not_harness_only');
  return { d, env };
}
/** GitLab fixture values from `.env.e2e`, substituted for `{{gitlab.*}}` in a scenario. */
const GITLAB_FIXTURE = {
  host: ['E2E_GITLAB_HOST', /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/],
  project: ['E2E_GITLAB_PROJECT', /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/],
  projectId: ['E2E_GITLAB_PROJECT_ID', /^[1-9][0-9]{0,15}$/],
  targetBranch: ['E2E_GITLAB_TARGET_BRANCH', /^[A-Za-z0-9_./-]{1,200}$/],
  // A finished CI job of the project and one marker line in the head and the
  // tail of its trace (gitlab-discovery.json).
  traceJobId: ['E2E_GITLAB_TRACE_JOB_ID', /^[1-9][0-9]{0,19}$/],
  traceHeadMarker: ['E2E_GITLAB_TRACE_HEAD_MARKER', /^[A-Za-z0-9][A-Za-z0-9 _.:-]{2,79}$/],
  traceTailMarker: ['E2E_GITLAB_TRACE_TAIL_MARKER', /^[A-Za-z0-9][A-Za-z0-9 _.:-]{2,79}$/],
};
/** Replaces `{{gitlab.<key>}}` in every string. A `projectId` field that is
 * exactly `{{gitlab.projectId}}` becomes a number. A used but missing value is BLOCKED. */
export function resolveScenarioFixtures(value, env) {
  const lookup = (key) => {
    const [name, pattern] = GITLAB_FIXTURE[key] ?? fail('invalid_native_scenario');
    const raw = env[name]?.trim() ?? '';
    if (!pattern.test(raw)) fail(`missing_${name}`);
    return raw;
  };
  const visit = (v, field) => {
    if (typeof v === 'string') {
      if (field === 'projectId' && v === '{{gitlab.projectId}}') return Number(lookup('projectId'));
      return v.replace(/\{\{gitlab\.([A-Za-z]+)\}\}/g, (_, key) => lookup(key));
    }
    if (Array.isArray(v)) return v.map((x) => visit(x));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
    return v;
  };
  return visit(value);
}
/** Fixed method/host allowlist; writes are never retried after an unknown ACK. */
export function slackClient(token, fetcher = fetch) {
  return async (method, params = {}) => {
    if (
      ![
        'auth.test',
        'conversations.replies',
        'chat.postMessage',
        'chat.update',
        'chat.delete',
        'files.info',
        'files.getUploadURLExternal',
        'files.completeUploadExternal',
      ].includes(method)
    )
      fail('unsupported_slack_method');
    const write = [
      'chat.postMessage',
      'chat.update',
      'chat.delete',
      'files.getUploadURLExternal',
      'files.completeUploadExternal',
    ].includes(method);
    const form = method === 'files.getUploadURLExternal';
    const url = new URL(`https://slack.com/api/${method}`);
    if (!write) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let response;
    try {
      response = await fetcher(url, {
        method: write ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          ...(write
            ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }
            : {}),
        },
        ...(write
          ? {
              body: form
                ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
                : JSON.stringify(params),
            }
          : {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new LiveError(write ? 'slack_send_unknown_no_retry' : 'slack_read_unavailable', !write);
    }
    if (!response.ok) throw new LiveError(`slack_http_${response.status}`, !write);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new LiveError('slack_response_invalid');
    }
    if (!body.ok) {
      const known = new Set([
        'missing_scope',
        'invalid_auth',
        'token_revoked',
        'not_in_channel',
        'channel_not_found',
        'not_allowed_token_type',
        'message_not_found',
        'cant_update_message',
        'cant_delete_message',
        'invalid_attachments',
        'invalid_blocks',
        'invalid_arguments',
        'too_many_attachments',
        'msg_too_long',
        'no_text',
      ]);
      // Fixed method/code only: upstream messages and credential fragments stay private.
      const code = known.has(body.error) ? body.error : 'api_refused';
      throw new LiveError(`slack_${method.replace('.', '_')}_${code}`, !write);
    }
    return body;
  };
}
/** Test settings service API for the test channel only: its tool assignments
 * (read, unassign, assign an existing instance) and, for the stub suite, its
 * enabled flag, model, prompt and blocked members. Never creates an instance
 * or sends a credential. A write is never retried after an unknown outcome. */
export function adminClient({ origin, token, teamId, channelId }, fetcher = fetch) {
  if (!token?.trim() || /<operator:/i.test(token)) fail('missing_E2E_ADMIN_TOKEN');
  const installation = `${new URL(origin).origin}/api/installations/${teamId}`;
  const channel = `${installation}/channels/${channelId}`;
  const call = async (method, url, body) => {
    let response;
    try {
      response = await fetcher(url, {
        method,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new LiveError(
        method === 'GET' ? 'admin_api_unavailable' : 'admin_change_unknown_no_retry',
        method === 'GET',
      );
    }
    // Fixed status only: upstream messages stay private.
    if (!response.ok) throw new LiveError(`admin_api_http_${response.status}`, true);
    return response.json();
  };
  const instanceId = (v) => typeof v === 'string' && /^ti_[a-z0-9_-]{1,64}$/.test(v);
  return {
    /** The channel's exact assignment: kind → instance, label and readiness. */
    async assignment() {
      const view = await call('GET', `${channel}/tools`);
      if (
        !Array.isArray(view?.tools) ||
        !view.tools.every((t) => ASSIGNMENT_KINDS.includes(t?.kind) && instanceId(t.instanceId)) ||
        new Set(view.tools.map((t) => t.kind)).size !== view.tools.length
      )
        fail('channel_tools_unreadable');
      return Object.fromEntries(
        ASSIGNMENT_KINDS.flatMap((kind) => {
          const t = view.tools.find((x) => x.kind === kind);
          return t
            ? [[kind, { instanceId: t.instanceId, label: String(t.label ?? ''), ready: !!t.ready }]]
            : [];
        }),
      );
    },
    /** The workspace's existing tool instances: identity, host and readiness
     * only (the settings service never returns a credential). */
    async instances() {
      const view = await call('GET', `${installation}/tools`);
      if (
        !Array.isArray(view?.instances) ||
        // `ready` is the settings service's own readiness; an older service
        // without it is refused rather than read as "not ready".
        !view.instances.every(
          (i) => instanceId(i?.id) && typeof i.kind === 'string' && typeof i.ready === 'boolean',
        )
      )
        fail('tool_instances_unreadable');
      return view.instances
        .filter((i) => TOOL_KINDS.includes(i.kind))
        .map((i) => ({
          id: i.id,
          kind: i.kind,
          label: String(i.label ?? ''),
          host: typeof i.host === 'string' ? i.host : null,
          ready: i.ready,
        }));
    },
    unassign: (kind) => call('DELETE', `${channel}/tools/${kind}`),
    assign: (kind, instanceId) => call('PUT', `${channel}/tools/${kind}`, { instanceId }),
    /** The exact channel settings a stub step may change. */
    async settings() {
      const row = (await call('GET', `${installation}/channels`)).channels?.find(
        (c) => c.channelId === channelId,
      );
      const view = await call('GET', `${channel}/tools`);
      const members = (await call('GET', `${channel}/blocked-members`)).blockedMembers;
      if (
        typeof row?.enabled !== 'boolean' ||
        typeof view?.fingerprint !== 'string' ||
        !view.model ||
        !Array.isArray(view.model.keys) ||
        !view.prompt ||
        !Array.isArray(members)
      )
        fail('channel_settings_unreadable');
      return {
        enabled: row.enabled,
        model: view.model.channel ?? null,
        effectiveModel: view.model.effective ?? null,
        keys: view.model.keys,
        prompt: view.prompt.channel ?? null,
        fingerprint: view.fingerprint,
        blocked: members
          .map((m) => ({ userId: m.userId, displayName: m.displayName }))
          .sort((a, b) => a.userId.localeCompare(b.userId)),
      };
    },
    setEnabled: (enabled) => call('PUT', channel, { enabled }),
    setModel: (key, fingerprint) => call('PUT', `${channel}/model`, { key, fingerprint }),
    setPrompt: (text, fingerprint) => call('PUT', `${channel}/prompt`, { text, fingerprint }),
    block: (userId, displayName) =>
      call('PUT', `${channel}/blocked-members/${userId}`, { displayName }),
    unblock: (userId) => call('DELETE', `${channel}/blocked-members/${userId}`),
  };
}
/** Signed allocation URL and sender token never enter reports or application env. */
export function liveFileTransport(token, fetcher = fetch) {
  const fileUrl = (value) => {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.hostname !== 'files.slack.com' ||
      u.port ||
      u.username ||
      u.password
    )
      throw new LiveError('file_host_refused');
    return u;
  };
  return {
    async upload(slack, files, channel, threadTs, text, record) {
      const allocated = [];
      for (const file of files) {
        const bytes = Buffer.from(file.data, 'base64');
        const a = await slack('files.getUploadURLExternal', {
          filename: file.name,
          length: bytes.length,
        });
        if (!/^F[A-Z0-9]+$/.test(a.file_id ?? '')) throw new LiveError('input_allocation_unknown');
        record({
          fileId: a.file_id,
          name: file.name,
          bytes: bytes.length,
          sha256: hash(bytes),
          state: 'allocated',
        });
        let r;
        try {
          r = await fetcher(fileUrl(a.upload_url), {
            method: 'POST',
            redirect: 'error',
            body: bytes,
            headers: { 'content-type': 'application/octet-stream' },
            signal: AbortSignal.timeout(30000),
          });
        } catch {
          throw new LiveError('input_upload_unknown_no_retry');
        }
        await r.body?.cancel();
        if (!r.ok) throw new LiveError('input_upload_refused');
        allocated.push({ id: a.file_id, title: file.name });
      }
      await slack('files.completeUploadExternal', {
        files: allocated,
        channel_id: channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        initial_comment: text,
      });
      for (let attempt = 0; attempt < 20; attempt++) {
        const info = await slack('files.info', { file: allocated[0].id });
        if (info.file?.id !== allocated[0].id)
          throw new LiveError('input_share_identity_unconfirmed');
        const shares = [
          ...(info.file?.shares?.private?.[channel] ?? []),
          ...(info.file?.shares?.public?.[channel] ?? []),
        ];
        const candidates = shares.filter((s) =>
          threadTs ? s.thread_ts === threadTs : !s.thread_ts || s.thread_ts === s.ts,
        );
        if (candidates.length === 1 && /^\d+\.\d+$/.test(candidates[0].ts ?? ''))
          return { channel, ts: candidates[0].ts };
        if (candidates.length > 1) throw new LiveError('input_share_identity_unconfirmed');
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new LiveError('input_share_identity_unconfirmed');
    },
    async verify(slack, expected, inspected, channel, rootTs, appUser) {
      if (inspected.exports?.length !== expected.length)
        throw new LiveError('export_count_mismatch');
      const result = [];
      for (const e of expected) {
        const matches = inspected.exports.filter((f) => f.name === e.name);
        const f = matches[0];
        if (
          matches.length !== 1 ||
          f.bytes !== e.bytes ||
          f.sha256 !== e.sha256 ||
          f.receipt?.id !== f.id ||
          f.receipt?.sha256 !== e.sha256 ||
          f.receipt?.bytes !== e.bytes
        )
          throw new LiveError('export_receipt_mismatch');
        const info = await slack('files.info', { file: f.receipt.fileId });
        const data = info.file;
        const shares = [
          ...(data?.shares?.private?.[channel] ?? []),
          ...(data?.shares?.public?.[channel] ?? []),
        ];
        if (
          data?.id !== f.receipt.fileId ||
          data.user !== appUser ||
          data.size !== e.bytes ||
          !shares.some((s) => s.thread_ts === rootTs)
        )
          throw new LiveError('export_recipient_mismatch');
        const response = await fetcher(fileUrl(data.url_private_download ?? data.url_private), {
          redirect: 'error',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok || !response.body) throw new LiveError('export_download_unavailable');
        const sha = createHash('sha256');
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > e.bytes) throw new LiveError('export_size_mismatch');
          sha.update(chunk);
        }
        if (size !== e.bytes || sha.digest('hex') !== e.sha256)
          throw new LiveError('export_bytes_mismatch');
        result.push({ name: e.name, fileId: data.id, bytes: size, sha256: e.sha256 });
      }
      return result;
    },
    /** Downloads a long answer's `answer.md` and returns its text after
     * checking app, thread, size and the retained answer hash. */
    async answer(slack, fileId, channel, rootTs, appUser, expected) {
      const info = await slack('files.info', { file: fileId });
      const data = info.file;
      const shares = [
        ...(data?.shares?.private?.[channel] ?? []),
        ...(data?.shares?.public?.[channel] ?? []),
      ];
      if (
        data?.id !== fileId ||
        data.user !== appUser ||
        data.name !== 'answer.md' ||
        data.size !== expected.bytes ||
        expected.bytes > 2 * 1024 ** 2 ||
        !shares.some((s) => s.thread_ts === rootTs)
      )
        throw new LiveError('answer_file_recipient_mismatch');
      const response = await fetcher(fileUrl(data.url_private_download ?? data.url_private), {
        redirect: 'error',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok || !response.body) throw new LiveError('answer_file_download_unavailable');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > expected.bytes) throw new LiveError('answer_file_size_mismatch');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256)
        throw new LiveError('answer_file_bytes_mismatch');
      return bytes.toString('utf8');
    },
  };
}
export async function threadMessages(slack, channel, ts) {
  const messages = [],
    seen = new Set();
  let cursor;
  for (let page = 0; page < 10; page++) {
    const value = await slack('conversations.replies', {
      channel,
      ts,
      limit: 100,
      include_all_metadata: true,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(value.messages)) throw new LiveError('invalid_thread_page');
    messages.push(...value.messages);
    const next = value.response_metadata?.next_cursor;
    if (next === undefined || next === '') return messages;
    if (typeof next !== 'string' || seen.has(next)) throw new LiveError('invalid_thread_cursor');
    seen.add(next);
    cursor = next;
  }
  throw new LiveError('thread_pagination_bound');
}
export function assertAnswer(messages, inspection, bot, expected, citationIds) {
  const d = inspection.delivery;
  if (!d || d.outcome !== 'delivered' || !d.slack_ts) throw new LiveError('delivery_not_confirmed');
  const matches = messages.filter(
    (m) =>
      m.metadata?.event_type === 'support_agent_delivery' &&
      m.metadata.event_payload?.operation_id === d.operation_id,
  );
  if (
    matches.length !== 1 ||
    matches[0].ts !== d.slack_ts ||
    matches[0].user !== bot ||
    matches[0].metadata.event_payload.answer !== true
  )
    throw new LiveError('delivery_identity_or_duplicate');
  // Slack normalizes the notification fallback (including newlines). Verify the
  // visible answer blocks. Recognize only bounded canonical Markdown forms;
  // every reconstructed candidate must match the retained whole-answer hash.
  const message = matches[0];
  let text = message.text;
  let candidates;
  let footer;
  if (message.blocks?.length) {
    const parts = [];
    for (const block of message.blocks) {
      if (block.type === 'markdown' && typeof block.text === 'string') parts.push(block.text);
      // The footer (check mark and model key) is a context line outside the answer.
      else if (block.type === 'context' && Array.isArray(block.elements) && footer === undefined)
        footer = block.elements
          .map((e) => (typeof e?.text === 'string' ? e.text : ''))
          .join(' ')
          .slice(0, 300);
      else if (block.type === 'rich_text' && Array.isArray(block.elements)) {
        const sectionText = (section) => {
          if (section.type !== 'rich_text_section' || !Array.isArray(section.elements))
            throw new LiveError('unsupported_delivery_rendering');
          let part = '';
          for (const node of section.elements) {
            if (
              node.type === 'text' &&
              typeof node.text === 'string' &&
              node.style?.code === true &&
              !/[`\r\n]/.test(node.text) &&
              Object.entries(node.style).every(([k, v]) => k === 'code' || !v)
            ) {
              part += '`' + node.text + '`';
              continue;
            }
            if (
              node.type === 'text' &&
              typeof node.text === 'string' &&
              node.style?.bold === true &&
              Object.entries(node.style).every(([k, v]) => k === 'bold' || !v)
            ) {
              part += `**${node.text}**`;
              continue;
            }
            if (
              node.type === 'link' &&
              typeof node.url === 'string' &&
              !Object.values(node.style ?? {}).some(Boolean)
            ) {
              // Slack abbreviates bare URL labels. The retained whole-answer
              // hash below must still match; a different original cannot pass.
              part +=
                node.truncated === true || !node.text || node.text === node.url
                  ? node.url
                  : '[' + node.text.replace(/[\\[\]]/g, '\\$&') + '](' + node.url + ')';
              continue;
            }
            if (
              node.type !== 'text' ||
              typeof node.text !== 'string' ||
              Object.values(node.style ?? {}).some(Boolean)
            )
              throw new LiveError('unsupported_delivery_rendering');
            part += node.text;
          }
          return part;
        };
        for (const section of block.elements) {
          if (
            section.type === 'rich_text_list' &&
            section.style === 'bullet' &&
            (section.indent ?? 0) === 0 &&
            Array.isArray(section.elements)
          )
            parts.push(section.elements.map((s) => '- ' + sectionText(s)).join('\n'));
          else parts.push(sectionText(section));
        }
      } else throw new LiveError('unsupported_delivery_rendering');
    }
    if (!parts.length) throw new LiveError('unsupported_delivery_rendering');
    candidates = [parts.join('\n'), parts.reduce((a, b) => a + (a.endsWith('\n') ? '' : '\n') + b)];
    text = candidates.find((v) => hash(v) === d.sha256 && Buffer.byteLength(v) === Number(d.bytes));
  }
  // A long answer: the message is a notice and preview; the full answer is the
  // thread file named in the message metadata and the delivery receipt. The
  // caller downloads the file and checks the facts against it.
  const resultFiles = message.metadata.event_payload.result_files;
  if (resultFiles !== undefined || expected.longAnswer) {
    if (!expected.longAnswer) throw new LiveError('unexpected_answer_file');
    if (resultFiles === undefined) throw new LiveError('answer_file_not_attached');
    const receipt = inspection.answerFile;
    if (
      !Array.isArray(resultFiles) ||
      resultFiles.length !== 1 ||
      !/^F[A-Z0-9]+$/.test(resultFiles[0]?.id ?? '') ||
      resultFiles[0].sha256 !== d.sha256 ||
      receipt?.attached !== true ||
      receipt.fileId !== resultFiles[0].id ||
      receipt.sha256 !== d.sha256
    )
      throw new LiveError('answer_file_identity_mismatch');
    const preview = candidates?.[0] ?? message.text;
    if (typeof preview !== 'string' || !preview) throw new LiveError('answer_preview_missing');
    for (const s of expected.longAnswer.previewContains ?? [])
      if (!preview.includes(s)) throw new LiveError('expected_preview_fact_missing');
    for (const s of expected.longAnswer.previewExcludes ?? [])
      if (preview.includes(s)) throw new LiveError('forbidden_preview_fact_present');
    return {
      operationId: d.operation_id,
      ts: d.slack_ts,
      sha256: d.sha256,
      bytes: Number(d.bytes),
      ...(footer ? { footer } : {}),
      file: { fileId: receipt.fileId, sha256: d.sha256 },
      preview,
    };
  }
  if (
    typeof text !== 'string' ||
    hash(text) !== d.sha256 ||
    Buffer.byteLength(text) !== Number(d.bytes)
  )
    throw new LiveError('delivery_bytes_mismatch');
  for (const s of expected.contains)
    if (!text.includes(s)) throw new LiveError('expected_answer_fact_missing');
  for (const s of expected.excludes ?? [])
    if (text.includes(s)) throw new LiveError('forbidden_answer_fact_present');
  if (citationIds !== undefined) assertVisibleCitations(text, citationIds);
  return {
    operationId: d.operation_id,
    ts: d.slack_ts,
    sha256: d.sha256,
    bytes: Number(d.bytes),
    ...(footer ? { footer } : {}),
  };
}
/** The retained answer record keeps the preview's hash, not its text. */
function withoutPreview({ preview: _preview, ...answer }) {
  return answer;
}
/** The preview of a long answer: a notice naming the file, then the head of
 * the full answer and optionally its trailing status paragraphs. Whitespace is
 * compared loosely because Slack may render line breaks differently. */
export function assertLongAnswer(answer, full, expected, citationIds) {
  const norm = (v) => v.replace(/\s+/g, ' ').trim();
  const message = norm(answer.preview),
    whole = norm(full);
  const start = message.indexOf(whole.slice(0, 40));
  const notice = message.slice(0, Math.max(0, start));
  const head = message.slice(start);
  const split = (p) =>
    whole.startsWith(p) ||
    [...p.matchAll(/ /g)].some(
      (m) => whole.startsWith(p.slice(0, m.index)) && whole.endsWith(p.slice(m.index + 1)),
    );
  if (
    start <= 0 ||
    !notice.includes('answer.md') ||
    !/attached/.test(notice) ||
    head.length >= whole.length ||
    !split(head)
  )
    throw new LiveError('answer_preview_mismatch');
  for (const s of expected.contains)
    if (!full.includes(s)) throw new LiveError('expected_answer_fact_missing');
  for (const s of expected.excludes ?? [])
    if (full.includes(s)) throw new LiveError('forbidden_answer_fact_present');
  if (citationIds !== undefined) assertVisibleCitations(full, citationIds);
  return { previewSha256: hash(answer.preview), previewChars: answer.preview.length };
}

/** Match a displayed Markdown link to evidence recorded by the provider annotation renderer. */
function assertVisibleCitations(text, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
    throw new LiveError('provider_citation_evidence_missing');
  const visible = text.replace(/```[\s\S]*?```|`[^`\r\n]*`/g, '');
  const approved = new Set(ids);
  if (
    !markdownCitationLinks(visible).some(
      ({ markdown, label }) => !label.includes('](') && approved.has(hash(markdown)),
    )
  )
    throw new LiveError('provider_citation_not_visible');
}
export function publicationEvidence(inspection, fixture) {
  const receipts = inspection.publications;
  if (
    !Array.isArray(receipts) ||
    receipts.length !== 1 ||
    receipts[0].run_id !== inspection.runId ||
    receipts[0].outcome !== 'confirmed'
  )
    throw new LiveError('publication_not_confirmed');
  const e = receipts[0].evidence;
  if (
    !e ||
    e.state !== 'completed' ||
    e.project !== fixture.project ||
    e.projectId !== fixture.projectId ||
    e.targetBranch !== fixture.targetBranch ||
    !/^[a-f0-9]{40}$/.test(e.commit ?? '') ||
    !e.branch ||
    e.branch === e.targetBranch ||
    !Number.isSafeInteger(e.mrIid) ||
    e.mrIid < 1 ||
    e.mrUrl !== `https://${fixture.host}/${fixture.project}/-/merge_requests/${e.mrIid}`
  )
    throw new LiveError('publication_receipt_identity_mismatch');
  return e;
}
export function assertPublication(inspection, fixture, observed, previous) {
  const e = publicationEvidence(inspection, fixture);
  const { project, mr, files } = observed;
  if (
    project.id !== fixture.projectId ||
    project.path_with_namespace !== fixture.project ||
    project.default_branch !== fixture.targetBranch ||
    mr.project_id !== e.projectId ||
    mr.iid !== e.mrIid ||
    mr.state !== 'opened' ||
    mr.source_branch !== e.branch ||
    mr.target_branch !== e.targetBranch ||
    mr.web_url !== e.mrUrl ||
    mr.sha !== e.commit ||
    !Array.isArray(files) ||
    files.length !== fixture.files.length
  )
    throw new LiveError('published_remote_identity_mismatch');
  if (
    previous &&
    (previous.mrIid !== e.mrIid || previous.branch !== e.branch || previous.commit === e.commit)
  )
    throw new LiveError('publication_followup_not_same_mr_new_commit');
  const verified = fixture.files.map((expected, index) => {
    const file = files[index];
    if (
      file.file_path !== expected.path ||
      file.commit_id !== e.commit ||
      file.encoding !== 'text' ||
      typeof file.content !== 'string'
    )
      throw new LiveError('published_file_identity_mismatch');
    // The tool runtime decodes repository files before redacting them.
    const bytes = Buffer.from(file.content, 'utf8');
    const sha256 = hash(bytes);
    if (bytes.length !== file.size || bytes.length > 200000 || sha256 !== file.content_sha256)
      throw new LiveError('published_file_bytes_mismatch');
    for (const fact of expected.contains)
      if (!file.content.includes(fact)) throw new LiveError('published_file_fact_missing');
    return { path: expected.path, bytes: bytes.length, sha256 };
  });
  return {
    project: e.project,
    projectId: e.projectId,
    branch: e.branch,
    targetBranch: e.targetBranch,
    commit: e.commit,
    mrIid: e.mrIid,
    mrUrl: e.mrUrl,
    files: verified,
  };
}
/** Service credentials are read only inside their existing container, never copied to host. */
export function nativeRead(d, operation, body, execute = compose) {
  if (!['identity', 'inspect', 'publication', 'requests', 'model'].includes(operation))
    fail('unsupported_native_read');
  if (
    operation === 'requests' &&
    (!Array.isArray(body.runIds) ||
      !body.runIds.length ||
      body.runIds.length > 16 ||
      !body.runIds.every(
        (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id),
      ))
  )
    fail('unsupported_native_read');
  if (operation === 'inspect' && !/^[UW][A-Z0-9]+$/.test(body.installationId ?? ''))
    fail('native_inspection_identity_required');
  const code = String.raw`
    const [op,body]=JSON.parse(process.argv[1]);
    const call=async(url,token,data,extra={})=>{const r=await fetch(url,{method:data?'POST':'GET',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json',...extra},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(op==='inspect'?90000:15000)});if(!r.ok){let c='';try{c=(await r.json()).error}catch{}throw Error(typeof c==='string'&&/^[a-z_]{1,64}$/.test(c)?c:'refused')}return r.json()};
    try {
      if(op==='requests') {
        let requests=0;
        const inference=[];
        for(const id of body.runIds){
          const r=await call(process.env.ADMIN_URL.replace(/\/$/,'')+'/internal/costs/requests?runId='+encodeURIComponent(id),process.env.ADMIN_INTERNAL_TOKEN,null);
          if(!Number.isSafeInteger(r.requests)||!Array.isArray(r.inference))throw Error('count');
          requests+=r.requests;
          inference.push({runId:id,models:r.inference});
        }
        console.log(JSON.stringify({requests,inference}));
      } else if(op==='model') {
        console.log(JSON.stringify(await call('http://127.0.0.1:'+process.env.NATIVE_APPLICATION_PORT+'/agents/model',process.env.SERVICE_TOKEN,body)));
      } else if(op==='identity'||op==='publication') {
        const c=await call(process.env.ADMIN_URL.replace(/\/$/,'')+'/internal/config',process.env.ADMIN_INTERNAL_TOKEN,null);
        const i=c.installations.find(i=>i.teamId===body.teamId);
        if(!i)throw Error('missing installation');
        const assigned=c.toolAssignments.filter(a=>a.teamId===body.teamId&&a.channelId===body.channelId);
        if(op==='identity') console.log(JSON.stringify({installation:i,assignedTools:assigned.flatMap(a=>a.tools).length,readyKinds:[...new Set(assigned.flatMap(a=>a.tools).filter(t=>t.ready).map(t=>t.kind))].sort(),version:c.version,hash:c.hash}));
        else {
          const candidates=assigned.flatMap(a=>a.tools).filter(t=>t.kind==='gitlab'&&t.host===body.fixture.host);
          if(candidates.length!==1)throw Error('binding');
          const t=candidates[0];
          const read=async(args)=>{
            if(!['get_project','get_merge_request','get_repository_file'].includes(args.kind))throw Error('operation');
            const r=await call(process.env.CLI_RUNTIME_URL.replace(/\/$/,'')+'/gitlab',process.env.CLI_RUNTIME_TOKEN,{instanceId:t.instanceId,teamId:body.teamId,credentialVersion:t.credentialVersion,operation:args.kind,operationArgs:args,timeoutMs:30000,maxOutputBytes:200000});
            if(r.status!=='completed'||r.exitCode!==0||r.truncated)throw Error('read');
            return JSON.parse(r.output);
          };
          const p=body.fixture, e=body.evidence;
          if(e.project!==p.project||e.projectId!==p.projectId||!/^[a-f0-9]{40}$/.test(e.commit)||!Number.isSafeInteger(e.mrIid))throw Error('receipt');
          const project=await read({kind:'get_project',project:p.project});
          const mr=await read({kind:'get_merge_request',project:p.project,merge_request_iid:e.mrIid});
          const files=[];
          for(const file of p.files)files.push(await read({kind:'get_repository_file',project:p.project,file_path:file.path,ref:e.commit}));
          console.log(JSON.stringify({project,mr,files}));
        }
      } else {
        const base='http://127.0.0.1:'+process.env.NATIVE_APPLICATION_PORT;
        let i,refused;
        try {
          const h=await call(base+'/agents/thread',process.env.SERVICE_TOKEN,body);
          i=await call(base+'/agents/inspect',process.env.SERVICE_TOKEN,{...h,actor:body.userId});
        } catch(e) {
          // Only the service's fixed refusal code leaves the container.
          refused=/^[a-z_]{1,64}$/.test(e?.message??'')?e.message:'unavailable';
        }
        if(refused) console.log(JSON.stringify({refused}));
        else console.log(JSON.stringify({runId:i.runId,messageTs:i.messageTs,delivery:i.delivery,active:i.active,suspended:!!i.suspended,receipt:i.receipt,publications:i.publications,exports:i.exports,answerFile:i.answerFile,webSearch:i.webSearch,webCitations:i.webCitations,webFetch:i.webFetch}));
      }
    } catch {process.exitCode=2;}
  `;
  try {
    const result = JSON.parse(
      execute(d, [
        'exec',
        '-T',
        'native-answer',
        'node',
        '--input-type=module',
        '-e',
        code,
        JSON.stringify([operation, body]),
      ]),
    );
    // The sender has no run in this thread yet. Every other refusal stays
    // visible as `{ refused: code }`; it never reads as an absent run.
    if (operation === 'inspect' && result?.refused === 'thread_owner_required') return null;
    return result;
  } catch {
    if (operation === 'inspect') return { refused: 'unavailable' };
    fail(
      {
        publication: 'publication_readback_unavailable',
        requests: 'model_request_count_unavailable',
        model: 'selected_model_unavailable',
      }[operation] ?? 'native_admin_identity_unavailable',
    );
  }
}
/** The agent's cost ledger posts request rows every few seconds. Reads the
 * count until two reads a flush interval apart agree. */
export async function settledRequestCount(read, delay, attempts = 8) {
  let last = -1;
  for (let i = 0; i < attempts; i++) {
    const current = (await read()).requests;
    if (!Number.isSafeInteger(current) || current < 0) fail('model_request_count_unavailable');
    if (current === last && current > 0) return current;
    last = current;
    await delay(6000);
  }
  fail('model_request_count_unsettled');
}
export function assertWebSearch(inspection, step) {
  const receipts = inspection.webSearch;
  if (
    !Array.isArray(receipts) ||
    receipts.length < step.webSearch.minSearches ||
    receipts.some(
      (r) =>
        !/^[a-f0-9]{64}$/.test(r.id ?? '') || !Number.isSafeInteger(r.results) || r.results < 0,
    ) ||
    new Set(receipts.map((r) => r.id)).size !== receipts.length
  )
    throw new LiveError('confirmed_provider_search_evidence_missing');
  if (
    !step.publication &&
    ((inspection.publications?.length ?? 0) || (inspection.exports?.length ?? 0))
  )
    throw new LiveError('search_discovery_produced_external_artifacts');
  return receipts;
}

export function assertWebFetch(inspection, step) {
  const receipts = inspection.webFetch;
  const expected = hash(new URL(step.webFetch.url).href);
  if (
    !Array.isArray(receipts) ||
    !receipts.some(
      (r) =>
        r.url === expected &&
        /^[a-f0-9]{64}$/.test(r.id ?? '') &&
        /^[a-f0-9]{64}$/.test(r.sha256 ?? '') &&
        Number.isSafeInteger(r.bytes) &&
        r.bytes > 0 &&
        r.bytes <= 48000,
    )
  )
    throw new LiveError('confirmed_direct_fetch_evidence_missing');
  if (!step.webSearch && inspection.webSearch?.length)
    throw new LiveError('direct_fetch_fixture_used_search');
  if (
    !step.publication &&
    ((inspection.publications?.length ?? 0) || (inspection.exports?.length ?? 0))
  )
    throw new LiveError('fetch_discovery_produced_external_artifacts');
  return receipts;
}

export async function runScenario({
  scenario,
  slack,
  identity,
  inspect,
  verifyPublication,
  files,
  report,
  save,
  admin,
  models = {},
  manageTools = false,
  gitlabHost = null,
  signal,
  delay: pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 180000,
}) {
  // An interrupt ends the current wait; the restores below still run.
  const interrupted = () => new LiveError('interrupted');
  const delay = async (ms) => {
    if (signal?.aborted) throw interrupted();
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(interrupted());
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(pause(ms)).then(
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  };
  const auth = await slack('auth.test');
  const trusted = identity.installation.trustedBotSender;
  if (
    auth.team_id !== identity.installation.teamId ||
    auth.user_id !== trusted?.userId ||
    auth.bot_id !== trusted?.botId ||
    auth.user_id === identity.installation.botUserId
  )
    fail('sender_identity_not_designated');
  const channel = trusted.channelId;
  const bot = identity.installation.botUserId;
  /** Kind → instance ID of an assignment view. */
  const ids = (view) =>
    Object.fromEntries(Object.entries(view ?? {}).map(([k, v]) => [k, v.instanceId]));
  const sameAssignment = (view, wanted) =>
    ASSIGNMENT_KINDS.every((k) => (view[k]?.instanceId ?? null) === (wanted[k] ?? null));
  /** Sets the channel's assignment to exactly `wanted` (kind → instance ID):
   * assigns or unassigns existing instances only. */
  async function setAssignment(wanted) {
    const now = await admin.assignment();
    for (const kind of ASSIGNMENT_KINDS) {
      const want = wanted[kind] ?? null;
      if ((now[kind]?.instanceId ?? null) === want) continue;
      if (want) await admin.assign(kind, want);
      else await admin.unassign(kind);
    }
  }
  /** Driver-managed tools: reads the channel's exact assignment and the
   * workspace's instances, then assigns exactly what the scenario needs. The
   * original is restored at the end of the scenario, also after a failure. */
  async function assignTools() {
    const needs = neededTools(scenario);
    const original = await admin.assignment();
    report.toolAssignment = { needs, original, state: 'read' };
    save();
    const target = toolTarget(needs, await admin.instances(), original, gitlabHost);
    Object.assign(report.toolAssignment, { target, state: 'changing' });
    save();
    if (!sameAssignment(original, target)) await setAssignment(target);
    const applied = await admin.assignment();
    report.toolAssignment.applied = applied;
    if (!sameAssignment(applied, target)) {
      save();
      throw new LiveError('channel_tool_assignment_unconfirmed');
    }
    report.toolAssignment.state = 'applied';
    save();
    return {
      assignedTools: Object.keys(applied).length,
      readyKinds: Object.keys(applied).filter((k) => applied[k].ready),
    };
  }
  async function restoreTools() {
    const ta = report.toolAssignment;
    if (!ta || ta.state === 'read') return;
    const original = ids(ta.original);
    ta.restored = false;
    save();
    try {
      await setAssignment(original);
      ta.restoredState = await admin.assignment();
      ta.restored = sameAssignment(ta.restoredState, original);
    } catch {
      ta.restored = false;
    }
    // What to set in the channel's tool settings by hand.
    if (!ta.restored)
      ta.restoreByHand = {
        assign: Object.entries(ta.original).map(([kind, t]) => ({
          kind,
          instanceId: t.instanceId,
          label: t.label,
        })),
        unassign: ASSIGNMENT_KINDS.filter((k) => !ta.original[k]),
      };
    save();
  }
  /** The checks before anything is posted, on the channel's current (or
   * managed) assignment. */
  async function prepare() {
    // The installed application checks current channel sharing, membership and
    // source authority before inference and delivery. The harness sender has only
    // its designated posting/history role; it does not need application scopes.
    const tools = manageTools
      ? await assignTools()
      : { assignedTools: identity.assignedTools, readyKinds: identity.readyKinds };
    const ready = new Set(tools.readyKinds ?? []);
    const searches = [...scenario.steps, ...(scenario.isolation ? [scenario.isolation] : [])].some(
      (s) => s.webSearch,
    );
    if (searches && !ready.has('webSearch')) fail('ready_search_assignment_required');
    const fetches = [...scenario.steps, ...(scenario.isolation ? [scenario.isolation] : [])].some(
      (s) => s.webFetch,
    );
    if (fetches && !ready.has('webFetch')) fail('ready_fetch_assignment_required');
    for (const kind of scenario.requires ?? [])
      if (!ready.has(kind)) fail(`ready_${kind}_assignment_required`);
    if (scenario.mode !== 'coding' && !searches && !fetches && tools.assignedTools !== 0)
      fail('answer_fixture_requires_channel_without_tools');
    if (
      scenario.mode === 'coding' &&
      (!tools.assignedTools || (scenario.steps.some((s) => s.publication) && !verifyPublication))
    )
      fail('coding_fixture_requires_publication_verification');
    report.identity = {
      teamId: auth.team_id,
      channelId: channel,
      sender: auth.user_id,
      application: identity.installation.botUserId,
    };
    save();
  }
  if ((manageTools || scenario.steps.some((s) => s.channelSettings)) && !admin)
    fail('missing_E2E_ADMIN_TOKEN');
  // Channel settings (stub suite only): the exact prior state is read before
  // any change and restored at the end, also after a failure.
  const usesSettings = scenario.steps.some(
    (s) => s.channelSettings || JSON.stringify([s.contains, s.excludes]).includes('{{channel.'),
  );
  if (usesSettings) {
    if (!admin) fail('missing_E2E_ADMIN_TOKEN');
    const original = await admin.settings();
    report.channelSettings = { original, current: original, changed: {}, changes: [] };
    save();
  }
  const modelId = (key) => models[key] ?? fail('channel_model_id_unknown');
  /** `{{channel.modelId}}`: the model ID of the channel's current effective model. */
  const withChannel = (value) => {
    const fill = (list) =>
      list?.map((x) =>
        x.replaceAll('{{channel.modelId}}', () =>
          modelId(report.channelSettings?.current.effectiveModel),
        ),
      );
    return { ...value, contains: fill(value.contains), excludes: fill(value.excludes) };
  };
  async function applySettings(change) {
    const cs = report.channelSettings;
    const o = cs.original;
    const sender = auth.user_id;
    for (const [key, v] of Object.entries(change)) {
      const now = await admin.settings();
      const record = { key, value: v, before: now, state: 'changing' };
      cs.changes.push(record);
      cs.changed[key] = true;
      save();
      if (key === 'enabled') await admin.setEnabled(v === 'restore' ? o.enabled : false);
      else if (key === 'blocked') {
        const was = o.blocked.find((m) => m.userId === sender);
        if (v === true) await admin.block(sender, was?.displayName ?? 'Live test sender');
        else if (was) await admin.block(sender, was.displayName);
        else await admin.unblock(sender);
      } else if (key === 'model') {
        let target = o.model;
        if (v === 'alternate') {
          const from = models[o.effectiveModel];
          target =
            now.keys.find((k) => models[k] && models[k] !== from) ??
            fail('alternate_model_required');
        }
        await admin.setModel(target, now.fingerprint);
      } else await admin.setPrompt(v === 'restore' ? o.prompt : v, now.fingerprint);
      cs.current = await admin.settings();
      Object.assign(record, { after: cs.current, state: 'changed' });
      save();
    }
  }
  const sameSettings = (a, b) =>
    a.enabled === b.enabled &&
    a.model === b.model &&
    a.prompt === b.prompt &&
    JSON.stringify(a.blocked) === JSON.stringify(b.blocked);
  async function restoreSettings() {
    const cs = report.channelSettings;
    if (!cs || !Object.keys(cs.changed).length) return;
    const o = cs.original;
    cs.restored = false;
    save();
    try {
      let now = await admin.settings();
      if (now.prompt !== o.prompt) {
        await admin.setPrompt(o.prompt, now.fingerprint);
        now = await admin.settings();
      }
      if (now.model !== o.model) {
        await admin.setModel(o.model, now.fingerprint);
        now = await admin.settings();
      }
      const was = o.blocked.find((m) => m.userId === auth.user_id);
      const is = now.blocked.find((m) => m.userId === auth.user_id);
      if (JSON.stringify(was) !== JSON.stringify(is)) {
        if (was) await admin.block(auth.user_id, was.displayName);
        else await admin.unblock(auth.user_id);
      }
      if (now.enabled !== o.enabled) await admin.setEnabled(o.enabled);
      cs.restoredState = await admin.settings();
      cs.restored = sameSettings(cs.restoredState, o);
    } catch {
      cs.restored = false;
    }
    if (!cs.restored)
      cs.restoreByHand = {
        enabled: o.enabled,
        model: o.model,
        prompt: o.prompt,
        blocked: o.blocked,
      };
    save();
  }
  /** The thread's current run, or null before the sender has one. A refused
   * inspection (for example while the channel is disabled or the sender is
   * blocked) is recorded on `entry` and returns null; it is never taken for
   * an absent or an earlier run. */
  async function observe(rootTs, entry) {
    const current = await inspect(rootTs, auth);
    if (current?.refused) {
      if (entry && entry.inspectionRefused !== current.refused) {
        entry.inspectionRefused = current.refused;
        save();
      }
      return null;
    }
    // Steps are correlated by the request's message; a run without it is unusable.
    if (current && !/^\d+\.\d+$/.test(current.messageTs ?? ''))
      throw new LiveError('native_inspection_message_identity_missing');
    return current ?? null;
  }
  /** Watches a thread for `seconds`: no run other than the scenario's earlier
   * runs, and no new app message or working reaction on `messageTs`. */
  async function settle(rootTs, messageTs, seconds, appBefore, excludes, code) {
    const known = new Set(report.attempts.map((a) => a.runId).filter(Boolean));
    for (let i = 0; i < Math.ceil(seconds / 2); i++) {
      await delay(2000);
      const current = await observe(rootTs);
      if (current && !known.has(current.runId)) throw new LiveError(`${code}_started_run`);
      const thread = await threadMessages(slack, channel, rootTs);
      const own = thread.find((m) => m.ts === messageTs);
      if (
        own?.reactions?.some((r) => r.name === 'hourglass_flowing_sand' && r.users?.includes(bot))
      )
        throw new LiveError(`${code}_started_run`);
      const app = thread.filter((m) => m.user === bot);
      if (app.some((m) => !appBefore.includes(m.ts))) throw new LiveError(`${code}_answered`);
      if (app.some((m) => (excludes ?? []).some((x) => String(m.text ?? '').includes(x))))
        throw new LiveError('forbidden_answer_fact_present');
    }
    return threadMessages(slack, channel, rootTs);
  }
  /** Edits or deletes the sender's own message of an earlier step (stub only).
   * The message's timestamp and hash are recorded before the change. */
  async function change(value, index) {
    const kind = value.edit ? 'edit' : 'delete';
    const targetStep = value[kind].step;
    const retained = report.attempts[index];
    if (retained) {
      if (retained.change !== kind || retained.targetStep !== targetStep)
        fail('retained_attempt_identity_unconfirmed');
      if (retained.state === 'passed') return retained.rootTs;
      fail('retained_message_change_unconfirmed');
    }
    const target = report.attempts[targetStep];
    if (!target?.messageTs || !target.rootTs || !['passed', 'held'].includes(target.state))
      fail('change_target_unconfirmed');
    const rootTs = target.rootTs;
    const thread = await threadMessages(slack, channel, rootTs);
    const message = thread.find((m) => m.ts === target.messageTs);
    if (
      !message ||
      message.user !== auth.user_id ||
      (message.bot_id !== undefined && message.bot_id !== auth.bot_id)
    )
      fail('message_change_not_own');
    const appBefore = thread.filter((m) => m.user === bot).map((m) => m.ts);
    const text = String(message.text ?? '');
    const entry = {
      change: kind,
      targetStep,
      rootTs,
      messageTs: target.messageTs,
      before: { sha256: hash(text), bytes: Buffer.byteLength(text) },
      state: 'changing',
    };
    report.attempts.push(entry);
    save();
    if (kind === 'edit') {
      const edited =
        scenario.steps[targetStep].mention === false
          ? value.edit.prompt
          : `<@${bot}> ${value.edit.prompt}`;
      const result = await slack('chat.update', { channel, ts: target.messageTs, text: edited });
      if (result.ts !== target.messageTs) throw new LiveError('message_change_unconfirmed');
      entry.after = { sha256: hash(edited), bytes: Buffer.byteLength(edited) };
    } else {
      const result = await slack('chat.delete', { channel, ts: target.messageTs });
      if (result.ts !== target.messageTs) throw new LiveError('message_change_unconfirmed');
      entry.after = { deleted: true };
    }
    entry.state = 'settling';
    save();
    const after = await settle(
      rootTs,
      target.messageTs,
      value.settleSeconds ?? 20,
      appBefore,
      value.excludes,
      'changed_message',
    );
    const now = after.find((m) => m.ts === target.messageTs);
    if (kind === 'delete') {
      if (now && now.subtype !== 'tombstone') throw new LiveError('message_delete_unconfirmed');
      entry.after.tombstone = !!now;
    } else if (!now?.edited) throw new LiveError('message_edit_unconfirmed');
    entry.state = 'passed';
    save();
    return rootTs;
  }
  /** Downloads a long answer's file and checks the preview and the facts. */
  async function verifyLong(answer, expected, rootTs, citationIds) {
    const full = await files.answer(slack, answer.file.fileId, channel, rootTs, bot, {
      sha256: answer.sha256,
      bytes: answer.bytes,
    });
    return assertLongAnswer(answer, full, withChannel(expected), citationIds);
  }
  async function step(value, rootTs, index) {
    if (isChangeStep(value)) return change(value, index);
    if (value.mention === false && !rootTs) fail('unmentioned_step_requires_thread');
    const retained = report.attempts[index];
    // A resume continues the suspended run of the preceding question step.
    // Every other step accepts only the run admitted for its own message.
    const resumed = value.resume ? report.attempts[index - 1] : undefined;
    if (value.resume && (!resumed?.question || !resumed.runId))
      fail('resume_requires_suspended_question');
    if (retained) {
      if (
        retained.promptHash !== hash(value.prompt) ||
        (retained.mention ?? true) !== (value.mention !== false) ||
        !retained.rootTs ||
        !retained.messageTs ||
        (rootTs && retained.rootTs !== rootTs)
      )
        fail('retained_attempt_identity_unconfirmed');
      rootTs = retained.rootTs;
      if (value.wait === false && ['held', 'passed'].includes(retained.state)) return rootTs;
      if (value.refused && retained.state === 'passed' && retained.refused) return rootTs;
      if (value.cancel && retained.state === 'passed' && retained.cancelled) return rootTs;
      if (retained.state === 'passed' && value.question && retained.question) {
        const asked = (await threadMessages(slack, channel, rootTs)).find(
          (m) => m.ts === retained.question.ts,
        );
        if (
          asked?.user !== identity.installation.botUserId ||
          hash(asked.text) !== retained.question.sha256
        )
          fail('retained_question_evidence_missing');
        return rootTs;
      }
      if (
        retained.state === 'passed' &&
        retained.answer &&
        (!value.publication || retained.publication) &&
        (!value.exports || retained.exports) &&
        (!value.webSearch || retained.webSearch) &&
        (!value.webFetch || retained.webFetch)
      ) {
        if (value.working && (!retained.workingObserved || !retained.workingCleared))
          fail('retained_working_evidence_missing');
        const search = value.webSearch ? await observe(rootTs, retained) : undefined;
        if (value.webSearch && search?.runId !== retained.runId)
          fail('retained_search_run_changed');
        if (search) assertWebSearch(search, value);
        const citations =
          search && report.selectedModel?.route === 'openai'
            ? (search.webCitations ?? [])
            : undefined;
        const answer = assertAnswer(
          await threadMessages(slack, channel, rootTs),
          {
            delivery: {
              ...retained.answer,
              outcome: 'delivered',
              slack_ts: retained.answer.ts,
              operation_id: retained.answer.operationId,
            },
            answerFile: retained.answer.file ? { attached: true, ...retained.answer.file } : null,
          },
          identity.installation.botUserId,
          withChannel(value),
          citations,
        );
        if (answer.file) await verifyLong(answer, value, rootTs, citations);
        if (value.exports) {
          const current = await observe(rootTs, retained);
          if (current?.runId !== retained.runId) fail('retained_export_run_changed');
          await files.verify(
            slack,
            value.exports,
            current,
            channel,
            rootTs,
            identity.installation.botUserId,
          );
        }
        if (value.webFetch) {
          const current = await observe(rootTs, retained);
          if (current?.runId !== retained.runId) fail('retained_fetch_run_changed');
          assertWebFetch(current, value);
        }
        return rootTs;
      }
      const sent = (await threadMessages(slack, channel, rootTs)).filter(
        (m) => m.user === auth.user_id,
      );
      if (sent.at(-1)?.ts !== retained.messageTs) fail('retained_attempt_overtaken');
    } else {
      if (value.channelSettings) await applySettings(value.channelSettings);
      report.attempts.push({
        promptHash: hash(value.prompt),
        mention: value.mention !== false,
        rootTs: rootTs ?? null,
        state: 'posting',
      });
      save();
      const message = {
        channel,
        text:
          value.mention === false
            ? value.prompt
            : `<@${identity.installation.botUserId}> ${value.prompt}`,
        unfurl_links: false,
        unfurl_media: false,
        ...(value.messageAttachments ? { attachments: value.messageAttachments } : {}),
        ...(rootTs ? { thread_ts: rootTs } : {}),
      };
      const sent = value.attachments
        ? await files.upload(slack, value.attachments, channel, rootTs, message.text, (receipt) => {
            const entry = report.attempts.at(-1);
            (entry.inputs ??= []).push(receipt);
            save();
          })
        : await slack('chat.postMessage', message);
      if (sent.channel !== channel || !/^\d+\.\d+$/.test(sent.ts ?? ''))
        throw new LiveError('send_identity_unconfirmed');
      rootTs ??= sent.ts;
      const entry = report.attempts.at(-1);
      Object.assign(entry, { rootTs, messageTs: sent.ts, state: 'waiting' });
      save();
    }
    const entry = report.attempts[index];
    const own = (current) =>
      !!current &&
      (resumed ? current.runId === resumed.runId : current.messageTs === entry.messageTs);
    if (value.refused) {
      // The request must start no run and get no answer (its refusal notice is
      // ephemeral). Only explicit later changes may restore the setting.
      const thread = await threadMessages(slack, channel, rootTs);
      await settle(
        rootTs,
        entry.messageTs,
        value.settleSeconds ?? 20,
        thread
          .filter((m) => m.user === bot && Number(m.ts) < Number(entry.messageTs))
          .map((m) => m.ts),
        value.excludes,
        'refused_request',
      );
      Object.assign(entry, { state: 'passed', refused: { ts: entry.messageTs } });
      save();
      return rootTs;
    }
    if (value.working && !entry.workingObserved) {
      const deadline = Date.now() + 20000;
      for (;;) {
        const message = (await threadMessages(slack, channel, rootTs)).find(
          (m) => m.ts === entry.messageTs,
        );
        if (
          message?.reactions?.some(
            (r) =>
              r.name === 'hourglass_flowing_sand' &&
              r.users?.includes(identity.installation.botUserId),
          )
        ) {
          entry.workingObserved = true;
          save();
          break;
        }
        if (Date.now() >= deadline) fail('working_indication_not_observed');
        await delay(1000);
      }
    }
    const reactionCleared = async (messageTs) => {
      // Presentation removes the reaction after the run's outcome is settled.
      const deadline = Date.now() + 20000;
      for (;;) {
        const message = (await threadMessages(slack, channel, rootTs)).find(
          (m) => m.ts === messageTs,
        );
        if (
          message &&
          !message.reactions?.some(
            (r) => r.name === 'hourglass_flowing_sand' && r.users?.includes(bot),
          )
        )
          return true;
        if (Date.now() >= deadline) fail('working_indication_not_cleared');
        await delay(1000);
      }
    };
    if (value.wait === false) {
      // A held run is not awaited: record its identity once it is admitted.
      const deadline = Date.now() + 60000;
      for (;;) {
        const current = await observe(rootTs, entry);
        if (own(current)) {
          if (current.delivery) throw new LiveError('held_run_delivered_before_cancel');
          Object.assign(entry, { state: 'held', runId: current.runId });
          save();
          return rootTs;
        }
        if (Date.now() >= deadline) throw new LiveError('held_run_not_started');
        await delay(1000);
      }
    }
    if (value.cancel) {
      const held = report.attempts[index - 1];
      const heldStep = scenario.steps[index - 1];
      if (held?.state !== 'held' || !held.runId) fail('cancel_requires_held_run');
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = await observe(rootTs, entry);
        if (
          current?.runId === held.runId &&
          !current.active &&
          /Cancellation recorded/.test(current.receipt ?? '')
        ) {
          if (current.delivery) throw new LiveError('cancelled_run_delivered');
          const thread = await threadMessages(slack, channel, rootTs);
          const own = thread.filter((m) => m.user === bot && typeof m.text === 'string');
          if (own.some((m) => (heldStep.excludes ?? []).some((x) => m.text.includes(x))))
            throw new LiveError('cancelled_answer_delivered');
          const notice = own.find(
            (m) =>
              Number(m.ts) > Number(entry.messageTs) &&
              value.contains.every((x) => m.text.includes(x)),
          );
          if (notice) {
            if (heldStep.working) held.workingCleared = await reactionCleared(held.messageTs);
            Object.assign(entry, {
              state: 'passed',
              runId: held.runId,
              cancelled: { ts: notice.ts, sha256: hash(notice.text) },
            });
            save();
            return rootTs;
          }
        }
        if (Date.now() >= deadline) throw new LiveError('cancel_not_confirmed');
        await delay(2000);
      }
    }
    const until = Date.now() + timeoutMs;
    for (;;) {
      const current = await observe(rootTs, entry);
      if (own(current)) {
        if (value.question && current.delivery?.outcome === 'delivered')
          throw new LiveError('native_question_not_asked');
        if (value.question && current.suspended) {
          // The question is a notice from the app, posted after this request.
          const asked = (await threadMessages(slack, channel, rootTs)).filter(
            (m) =>
              m.user === identity.installation.botUserId &&
              Number(m.ts) > Number(entry.messageTs) &&
              typeof m.text === 'string',
          );
          const notice = asked.find(
            (m) =>
              value.contains.every((s) => m.text.includes(s)) &&
              !(value.excludes ?? []).some((s) => m.text.includes(s)),
          );
          if (notice) {
            Object.assign(entry, {
              state: 'passed',
              runId: current.runId,
              question: { ts: notice.ts, sha256: hash(notice.text) },
            });
            save();
            return rootTs;
          }
          if (asked.length) throw new LiveError('expected_question_fact_missing');
        } else if (current.delivery?.outcome === 'delivered') {
          // A step that declares no publication or export must create none.
          if (
            (!value.publication && current.publications?.length) ||
            (!value.exports && current.exports?.length)
          )
            throw new LiveError('discovery_produced_external_artifacts');
          const webSearch = value.webSearch ? assertWebSearch(current, value) : undefined;
          const citations =
            webSearch && report.selectedModel?.route === 'openai'
              ? (current.webCitations ?? [])
              : undefined;
          const webFetch = value.webFetch ? assertWebFetch(current, value) : undefined;
          const expected = withChannel(value);
          const answer = assertAnswer(
            await threadMessages(slack, channel, rootTs),
            current,
            identity.installation.botUserId,
            expected,
            citations,
          );
          const long = answer.file
            ? await verifyLong(answer, expected, rootTs, citations)
            : undefined;
          // After a model change, the footer names the channel's current model key.
          const key = report.channelSettings?.current.effectiveModel;
          if (
            Object.keys(report.channelSettings?.changed ?? {}).includes('model') &&
            !answer.footer?.includes(`Model: *${key}*`)
          )
            throw new LiveError('answer_footer_model_mismatch');
          const publication = value.publication
            ? await verifyPublication(
                current,
                value.publication,
                report.attempts.at(-2)?.publication,
              )
            : undefined;
          const exports = value.exports
            ? await files.verify(
                slack,
                value.exports,
                current,
                channel,
                rootTs,
                identity.installation.botUserId,
              )
            : undefined;
          if (value.working) {
            // Presentation removes the reaction after the delivery receipt commits.
            const deadline = Date.now() + 20000;
            for (;;) {
              const message = (await threadMessages(slack, channel, rootTs)).find(
                (m) => m.ts === entry.messageTs,
              );
              if (
                message &&
                !message.reactions?.some(
                  (r) =>
                    r.name === 'hourglass_flowing_sand' &&
                    r.users?.includes(identity.installation.botUserId),
                )
              ) {
                entry.workingCleared = true;
                break;
              }
              if (Date.now() >= deadline) fail('working_indication_not_cleared');
              await delay(1000);
            }
          }
          Object.assign(entry, {
            state: 'passed',
            runId: current.runId,
            answer: { ...withoutPreview(answer), ...(long ? { long } : {}) },
            ...(publication ? { publication } : {}),
            ...(exports ? { exports } : {}),
            ...(webSearch ? { webSearch } : {}),
            ...(citations ? { webCitations: citations } : {}),
            ...(webFetch ? { webFetch } : {}),
          });
          save();
          return rootTs;
        }
        // A resume waits while the adapter hands the answer to the suspended run.
        if (
          (current.suspended && !value.question && !value.resume) ||
          (!current.active && current.receipt)
        )
          throw new LiveError('native_request_not_successful');
      }
      if (Date.now() >= until) throw new LiveError('native_answer_timeout_no_retry');
      // Inspection revalidates source bytes and current Slack authority. Avoid
      // exhausting Slack read limits while a coding turn is still running.
      await delay(scenario.mode === 'coding' ? 15000 : 5000);
    }
  }
  let rootTs;
  let failure;
  try {
    await prepare();
    for (const [index, value] of scenario.steps.entries()) {
      if (signal?.aborted) throw interrupted();
      rootTs = await step(value, rootTs, index);
    }
    if (signal?.aborted) throw interrupted();
    if (scenario.isolation) await step(scenario.isolation, undefined, scenario.steps.length);
  } catch (error) {
    failure = error;
  }
  {
    // Every changed channel setting and the tool assignment return to their
    // original, also after a failure. An unconfirmed restore fails the scenario first.
    await restoreSettings();
    // The managed assignment last: it returns the channel to the exact
    // assignment it had before the scenario.
    await restoreTools();
  }
  if (report.toolAssignment?.restored === false)
    throw new LiveError('channel_tool_restore_unconfirmed');
  // The report names the original settings to restore by hand.
  if (report.channelSettings?.restored === false)
    throw new LiveError('channel_settings_restore_unconfirmed');
  if (failure) throw failure;
  // Recheck every delivered operation once more for late duplicates or edits.
  // A question, held or cancel attempt has no answer; a resumed run delivers once.
  const answered = report.attempts.filter((a) => a.answer);
  if (
    answered.length !==
      report.attempts.filter(
        (a) => !a.question && !a.cancelled && !a.refused && !a.change && a.state !== 'held',
      ).length ||
    new Set(answered.map((a) => a.runId)).size !== answered.length ||
    new Set(answered.map((a) => a.answer.operationId)).size !== answered.length
  )
    throw new LiveError('scenario_reused_prior_execution');
  for (const entry of answered) {
    const current = {
      delivery: {
        ...entry.answer,
        outcome: 'delivered',
        slack_ts: entry.answer.ts,
        operation_id: entry.answer.operationId,
      },
      answerFile: entry.answer.file ? { attached: true, ...entry.answer.file } : null,
    };
    assertAnswer(
      await threadMessages(slack, channel, entry.rootTs),
      current,
      identity.installation.botUserId,
      { contains: [], excludes: [], ...(entry.answer.file ? { longAnswer: {} } : {}) },
    );
  }
}
const SWITCH_MODE_HINT =
  'The instance runs in the other model mode. Add --switch-mode to switch it for this run and back afterwards.';
/** Scenario folders of `--suite`. */
export const SUITES = {
  stub: 'tests/live/scenarios/stub',
  gateway: 'tests/live/scenarios',
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Running services and their image IDs: a changed image runs a scenario again. */
export function imageIds(services) {
  return Object.fromEntries(
    services
      .filter((c) => c.running)
      .map((c) => [c.service, c.image])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
const passedFile = (root, sha256) =>
  path.join(root, 'artifacts', 'native-live', 'passed', `${sha256}.json`);
/** The earlier passing report for this scenario hash and these images, if any. */
export function priorPass(root, sha256, images, model) {
  let prior;
  try {
    prior = JSON.parse(fs.readFileSync(passedFile(root, sha256), 'utf8'));
  } catch {
    return null;
  }
  return prior?.sha256 === sha256 &&
    JSON.stringify(prior.images) === JSON.stringify(images) &&
    JSON.stringify(prior.selectedModel) === JSON.stringify(model)
    ? prior
    : null;
}
/** Runs or validates one scenario file and writes its report. */
/** How long a run waits for an earlier run's work to settle before it is
 * BLOCKED with `native_test_work_not_idle`, and how often it checks. */
export const IDLE_WAIT_MS = 120000;
const IDLE_POLL_MS = 5000;
export async function runOne({ root, file, values, skipPassed = false, deps = {} }) {
  const output = path.join(root, 'artifacts', 'native-live', randomUUID());
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const report = {
    outcome: 'blocked',
    mode: values.run ? 'live' : 'configuration-only',
    file: path.relative(repoRoot, path.resolve(file ?? '.')),
    attempts: [],
  };
  const save = () =>
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  let release;
  try {
    if (!file) fail('scenario_required');
    const { d, env } = loadLive(root);
    const scenario = validateScenario(
      resolveScenarioFixtures(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')), env),
    );
    report.scenario = { name: scenario.name, sha256: hash(JSON.stringify(scenario)) };
    if (scenario.covers) report.covers = scenario.covers;
    if (scenario.budget) report.budget = scenario.budget;
    // Each mode runs only its own scenarios: directives sent to a real model
    // prove nothing, and stub replies prove no model behavior.
    report.modelMode = d.modelMode;
    const stub = report.modelMode === 'stub';
    if (stub) report.acceptance = 'deterministic, not live acceptance';
    if (stub && scenario.model !== 'stub') fail('gateway_mode_required');
    if (!stub && scenario.model === 'stub') fail('stub_mode_required');
    if (scenario.steps.some((s) => s.webFetch) && !d.env.NATIVE_WEB_RUNTIME_URL)
      fail('direct_fetch_transport_required');
    if (!values.run) {
      report.outcome = 'configuration_valid_live_not_run';
      return { code: 0, report, output };
    }
    if (!stub && !values['gateway-ready']) fail('gateway_availability_confirmation_required');
    release = acquireEnvironmentLock({
      id: path.basename(output),
      composeProject: d.project,
      dockerHost: process.env.DOCKER_HOST,
      onHeld: () => fail('designated_environment_locked'),
    });
    const services = (deps.services ?? requireNativeProject)(d);
    if (
      !['native-answer', 'native-postgres', 'adapter', ...(stub ? ['model-stub'] : [])].every((s) =>
        services.some((c) => c.service === s && c.running),
      )
    )
      fail('native_test_services_not_running');
    // A gateway run must not reach a stub left running from a stub start.
    if (!stub && services.some((c) => c.service === 'model-stub' && c.running))
      fail('model_stub_running_in_gateway_mode');
    report.images = imageIds(services);
    // Work of an earlier run (a failed scenario's last request, a delivery)
    // usually settles within seconds. Wait for it, bounded, before blocking.
    const readStatus = deps.status ?? status;
    const pause = deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let before = readStatus(d);
    let waited = 0;
    while (!before.idle && waited < IDLE_WAIT_MS && !deps.signal?.aborted) {
      await pause(IDLE_POLL_MS);
      waited += IDLE_POLL_MS;
      before = readStatus(d);
    }
    if (waited) report.idleWaitMs = waited;
    if (deps.signal?.aborted) throw new LiveError('interrupted');
    if (!before.idle) {
      report.before = before;
      fail('native_test_work_not_idle');
    }
    const read = deps.nativeRead ?? nativeRead;
    const teamId = env.E2E_SLACK_TEAM_ID;
    const channelId = env.E2E_SLACK_CHANNEL_ID;
    const catalog = stub ? stubModelCatalog(d.catalog) : d.catalog;
    if (stub && values['model-key']) fail('model_key_override_requires_gateway_mode');
    const selection = read(d, 'model', { teamId, channelId });
    const expectedKey = stub ? selection?.key : (values['model-key'] ?? catalog.defaultKey);
    const expected = catalog.models.find(({ key }) => key === expectedKey);
    if (!expected) fail('expected_model_key_not_in_catalog');
    if (
      !selection ||
      selection.key !== expected.key ||
      selection.model !== expected.model ||
      selection.route !== expected.route ||
      selection.webSearch !== expected.webSearch ||
      typeof selection.connection !== 'string' ||
      !selection.connection
    )
      fail('preselected_channel_model_required');
    if (scenario.steps.some((step) => step.webSearch) && !selection.webSearch)
      fail('selected_model_hosted_search_unavailable');
    report.selectedModel = selection;
    if (skipPassed && !values['resume-report']) {
      const prior = priorPass(root, report.scenario.sha256, report.images, report.selectedModel);
      if (prior) {
        report.outcome = 'skipped_unchanged';
        report.passedReport = prior.report;
        return { code: 0, report, output };
      }
    }
    report.project = d.project;
    if (values['resume-report']) {
      const prior = JSON.parse(fs.readFileSync(path.resolve(values['resume-report']), 'utf8'));
      if (
        prior.project !== d.project ||
        prior.scenario?.sha256 !== report.scenario.sha256 ||
        JSON.stringify(prior.selectedModel) !== JSON.stringify(selection) ||
        !Array.isArray(prior.attempts) ||
        !prior.attempts.length ||
        prior.attempts.length > scenario.steps.length
      )
        fail('retained_report_scope_mismatch');
      report.resumedFrom = path.resolve(values['resume-report']);
      report.attempts = prior.attempts;
    }
    report.before = before;
    save();
    const identity = read(d, 'identity', { teamId, channelId });
    const manageTools = !!env.E2E_ADMIN_TOKEN?.trim();
    report.toolsManaged = manageTools;
    if (identity.installation.trustedBotSender?.channelId !== channelId)
      fail('designated_channel_not_trusted');
    await (deps.runScenario ?? runScenario)({
      scenario,
      slack: slackClient(env.E2E_SLACK_SENDER_TOKEN),
      files: liveFileTransport(env.E2E_SLACK_SENDER_TOKEN),
      identity,
      report,
      save,
      models: Object.fromEntries(catalog.models.map(({ key, model }) => [key, model])),
      // With the settings-service token the driver manages the channel's tool
      // assignment; without it the channel is checked as it is.
      ...(manageTools || scenario.steps.some((s) => s.channelSettings)
        ? {
            admin: (deps.adminClient ?? adminClient)({
              origin: d.env.ADMIN_PUBLIC_URL,
              token: env.E2E_ADMIN_TOKEN,
              teamId,
              channelId,
            }),
          }
        : {}),
      manageTools,
      gitlabHost:
        scenario.steps.find((s) => s.publication)?.publication.host ??
        (GITLAB_FIXTURE.host[1].test(env.E2E_GITLAB_HOST?.trim() ?? '')
          ? env.E2E_GITLAB_HOST.trim()
          : null),
      signal: deps.signal,
      ...(deps.delay ? { delay: deps.delay } : {}),
      timeoutMs: scenario.mode === 'coding' ? 660000 : 180000,
      verifyPublication: async (current, fixture, previous) => {
        const evidence = publicationEvidence(current, fixture);
        const observed = read(d, 'publication', { teamId, channelId, fixture, evidence });
        return assertPublication(current, fixture, observed, previous);
      },
      inspect: (rootTs, auth) =>
        read(d, 'inspect', {
          installationId: identity.installation.botUserId,
          teamId,
          channelId,
          rootTs,
          userId: auth.user_id,
          authorBotId: auth.bot_id,
        }),
    });
    // Every model request of the scenario's runs, from the settings service's
    // cost ledger. This also proves the agent's ledger reaches the service.
    const runIds = [...new Set(report.attempts.map((a) => a.runId).filter(Boolean))];
    let inference;
    report.modelRequests = await settledRequestCount(
      async () => {
        const snapshot = read(d, 'requests', { runIds });
        inference = snapshot.inference;
        return snapshot;
      },
      deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    );
    report.inference = inference;
    if (
      !stub &&
      (!Array.isArray(inference) ||
        inference.length !== runIds.length ||
        inference.some(
          ({ models }) =>
            models.length !== 1 ||
            models[0].route !== selection.route ||
            models[0].model !== selection.model ||
            models[0].connection !== selection.connection ||
            !Number.isSafeInteger(models[0].requests) ||
            models[0].requests < 1,
        ))
    )
      throw new LiveError('provider_inference_identity_mismatch');
    save();
    if (scenario.budget && report.modelRequests > scenario.budget.modelRequests)
      throw new LiveError('model_request_budget_exceeded');
    report.outcome = 'passed';
    fs.mkdirSync(path.dirname(passedFile(root, report.scenario.sha256)), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      passedFile(root, report.scenario.sha256),
      JSON.stringify({
        scenario: report.scenario.name,
        file: report.file,
        sha256: report.scenario.sha256,
        modelMode: report.modelMode,
        selectedModel: report.selectedModel,
        images: report.images,
        report: output,
        at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return { code: 0, report, output };
  } catch (error) {
    report.outcome = error instanceof LiveError && !error.blocked ? 'failed' : 'blocked';
    if (['gateway_mode_required', 'stub_mode_required'].includes(error?.message))
      report.hint = SWITCH_MODE_HINT;
    report.reason =
      error instanceof LiveError
        ? error.message
        : /^[A-Z][A-Z0-9_]+ is required$/.test(error?.message ?? '')
          ? error.message
          : 'configuration_or_runtime_prerequisite_unavailable';
    return { code: report.outcome === 'blocked' ? 2 : 1, report, output };
  } finally {
    save();
    release?.();
    console.log(
      `Native live evidence: ${output} (${report.outcome}${report.reason ? `: ${report.reason}` : ''}${report.acceptance ? `; stub: ${report.acceptance}` : ''})`,
    );
    if (report.hint && !values.suite) console.log(report.hint);
  }
}
/** Runs `scripts/test-stack.mjs`, the code path of `npm run test:stack:*`.
 * Its messages carry no credentials; the last line is kept. */
export function testStack(action, root, mode) {
  const label = `test:stack:${action}${mode ? ` --model-mode ${mode}` : ''}`;
  console.log(`${label}: running`);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'test-stack.mjs'),
        action,
        '--instance-dir',
        root,
        ...(mode ? ['--model-mode', mode] : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', () => resolve({ ok: false, message: 'test-stack could not start' }));
    child.on('close', (code) => {
      const ok = code === 0;
      const message = ((ok ? stdout : stderr || stdout).trim().split('\n').at(-1) ?? '').slice(
        0,
        300,
      );
      console.log(`${label}: ${message || (ok ? 'done' : 'failed')}`);
      resolve({ ok, message });
    });
  });
}
/** `--switch-mode`: runs `body` with the instance in the `needed` model mode.
 * When the recorded mode differs, it runs `test:stack:down` and
 * `test:stack:up --model-mode <needed>` first and always returns the instance
 * to the recorded mode afterwards with `down` and `up`, also after a failure,
 * a block or an interrupt. `record` receives the switch state; `restored:
 * false` means the instance was left in another state (see `leftIn`). */
export async function inModelMode({ root, needed, values, deps = {}, record }, body) {
  const stack = deps.testStack ?? testStack;
  const from = readModelMode(root);
  // Without a recorded mode the driver blocks (model_mode_unknown_…).
  if (!from || from === needed) {
    record?.({ from, to: needed, switched: false });
    return body();
  }
  const state = { from, to: needed, switched: false, restored: null };
  const note = () => record?.({ ...state });
  if (needed === 'gateway' && !values['gateway-ready']) {
    state.reason = 'gateway_availability_confirmation_required';
    note();
    fail(state.reason);
  }
  note();
  let running = from;
  try {
    const down = await stack('down', root);
    if (!down.ok) {
      state.error = `test:stack:down: ${down.message}`;
      fail('model_mode_switch_failed');
    }
    running = null;
    const up = await stack('up', root, needed);
    if (!up.ok) {
      state.error = `test:stack:up --model-mode ${needed}: ${up.message}`;
      fail('model_mode_switch_failed');
    }
    running = needed;
    state.switched = true;
    note();
    return await body();
  } finally {
    const down = await stack('down', root);
    const up = down.ok ? await stack('up', root, from) : null;
    state.restored = !!up?.ok;
    if (state.restored) state.restoredMode = from;
    else {
      const failed = down.ok
        ? `test:stack:up --model-mode ${from} failed: ${up.message}`
        : `test:stack:down failed: ${down.message}`;
      state.leftIn = down.ok
        ? 'stopped'
        : running
          ? `${running} mode, intake stopped`
          : `partly started in ${needed} mode, intake stopped`;
      state.restoreError = failed;
      state.restoreByHand = [
        `npm run test:stack:down -- --instance-dir ${root}`,
        `npm run test:stack:up -- --instance-dir ${root} --model-mode ${from}`,
      ];
      console.error(
        [
          `MODEL MODE NOT RESTORED: the test instance is left ${state.leftIn === 'stopped' ? 'stopped' : `in ${state.leftIn}`}; it should rest in ${from} mode.`,
          `${failed}.`,
          `Restore it by hand${down.ok ? '' : ' once native execution is idle'}:`,
          ...state.restoreByHand.map((c) => `  ${c}`),
        ].join('\n'),
      );
    }
    note();
  }
}
/** Runs every scenario of a suite folder in name order and writes one summary.
 * `--tools` selects the scenarios whose needed tool kinds are in scope. */
export async function runSuite({ root, suite, values, deps = {} }) {
  const output = path.join(root, 'artifacts', 'native-live', `suite-${randomUUID()}`);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const summary = {
    suite,
    mode: values.run ? 'live' : 'configuration-only',
    rerun: !!values.rerun,
    tools: values.tools ?? 'all',
    startedAt: new Date().toISOString(),
    outcome: 'blocked',
    scenarios: [],
  };
  const save = () =>
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2), {
      mode: 0o600,
    });
  try {
    const scope = parseToolScope(values.tools);
    summary.tools = scope;
    const dir = path.join(deps.repo ?? repoRoot, SUITES[suite] ?? fail('unknown_suite'));
    const files = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((n) => path.join(dir, n));
    if (!files.length) fail('empty_suite');
    // Gate rule 2: no two gateway scenarios claim the same behaviour.
    const claimed = new Map();
    const plan = [];
    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const c of (raw.model ?? 'gateway') === 'gateway' ? (raw.covers ?? []) : []) {
        if (claimed.has(c)) fail('gateway_covers_duplicate');
        claimed.set(c, file);
      }
      const needs = neededTools(raw);
      plan.push({ file, raw, needs, selected: inToolScope(needs, scope) });
    }
    if (!plan.some((p) => p.selected)) fail('no_scenario_in_tool_scope');
    const runAll = async () => {
      for (const { file, raw, needs, selected } of plan) {
        const relative = path.relative(deps.repo ?? repoRoot, file);
        if (!selected) {
          summary.scenarios.push({
            file: relative,
            name: typeof raw.name === 'string' ? raw.name : null,
            outcome: 'not_selected',
            reason: 'tools_outside_scope',
            needs,
          });
          save();
          continue;
        }
        if (deps.signal?.aborted) {
          summary.interrupted = true;
          break;
        }
        const { report, output: scenarioOutput } = await runOne({
          root,
          file,
          values,
          skipPassed: !values.rerun,
          deps,
        });
        summary.scenarios.push({
          file: relative,
          name: report.scenario?.name ?? null,
          outcome: report.outcome,
          ...(report.reason ? { reason: report.reason } : {}),
          ...(report.modelRequests !== undefined ? { modelRequests: report.modelRequests } : {}),
          report: path.join(scenarioOutput, 'report.json'),
          ...(report.passedReport ? { passedReport: report.passedReport } : {}),
        });
        save();
        if (deps.signal?.aborted) {
          summary.interrupted = true;
          break;
        }
      }
    };
    if (values['switch-mode'])
      await inModelMode(
        {
          root,
          needed: suite === 'stub' ? 'stub' : 'gateway',
          values,
          deps,
          record: (state) => {
            summary.modelModeSwitch = state;
            save();
          },
        },
        runAll,
      );
    else await runAll();
    const count = (o) => summary.scenarios.filter((s) => s.outcome === o).length;
    summary.counts = Object.fromEntries(
      [
        'passed',
        'skipped_unchanged',
        'configuration_valid_live_not_run',
        'failed',
        'blocked',
        'not_selected',
      ].map((o) => [o, count(o)]),
    );
    summary.outcome =
      summary.interrupted || count('failed') ? 'failed' : count('blocked') ? 'blocked' : 'passed';
    if (summary.interrupted) summary.reason = 'interrupted';
    if (summary.outcome === 'passed' && !values.run) summary.outcome = 'configuration_valid';
    if (
      summary.scenarios.some((s) =>
        ['gateway_mode_required', 'stub_mode_required'].includes(s.reason),
      )
    )
      summary.hint = SWITCH_MODE_HINT;
  } catch (error) {
    summary.outcome = 'blocked';
    summary.reason = error instanceof LiveError ? error.message : 'suite_unavailable';
  } finally {
    summary.finishedAt = new Date().toISOString();
    save();
    const sw = summary.modelModeSwitch;
    console.log(
      `Native live suite ${suite} (tools ${[summary.tools].flat().join(',')}): ${summary.outcome}${summary.reason ? ` (${summary.reason})` : ''}${sw?.switched || sw?.restored === false ? `; model mode ${sw.restored ? `restored to ${sw.restoredMode}` : `NOT restored (${sw.leftIn})`}` : ''}; summary ${output}/summary.json`,
    );
    if (summary.hint) console.log(summary.hint);
  }
  const code = summary.outcome === 'failed' ? 1 : summary.outcome === 'blocked' ? 2 : 0;
  return summary.modelModeSwitch?.restored === false && code === 0 ? 1 : code;
}
/** SIGINT or SIGTERM ends the current wait; the driver then restores the
 * channel's tools and the model mode. A second signal exits at once. */
function interruptSignal() {
  const controller = new AbortController();
  const handler = (name) => {
    if (controller.signal.aborted) process.exit(130);
    console.error(
      `${name}: interrupting. Restoring the channel's tools and the model mode; send ${name} again to exit at once without restoring.`,
    );
    controller.abort();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    },
  };
}
/** One scenario with `--switch-mode`; the switch state goes into its report. */
async function runOneInMode({ root, values, deps }) {
  let needed = 'gateway';
  try {
    if (JSON.parse(fs.readFileSync(path.resolve(values.scenario), 'utf8')).model === 'stub')
      needed = 'stub';
  } catch {
    // An unreadable scenario is reported by runOne.
  }
  let result, state;
  try {
    await inModelMode(
      { root, needed, values, deps, record: (s) => (state = s) },
      async () => (result = await runOne({ root, file: values.scenario, values, deps })),
    );
  } catch (error) {
    console.error(
      `Native live scenario: blocked (${error instanceof LiveError ? error.message : 'model_mode_switch_failed'})`,
    );
  }
  if (result && state) {
    result.report.modelModeSwitch = state;
    fs.writeFileSync(
      path.join(result.output, 'report.json'),
      JSON.stringify(result.report, null, 2),
      { mode: 0o600 },
    );
  }
  const code = result?.code ?? 2;
  return state?.restored === false && code === 0 ? 1 : code;
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'instance-dir': { type: 'string' },
      scenario: { type: 'string' },
      suite: { type: 'string' },
      run: { type: 'boolean' },
      rerun: { type: 'boolean' },
      'gateway-ready': { type: 'boolean' },
      'model-key': { type: 'string' },
      'resume-report': { type: 'string' },
      tools: { type: 'string' },
      'switch-mode': { type: 'boolean' },
    },
  });
  if (!values['instance-dir'])
    throw new Error('--instance-dir is required; configuration lives outside the checkout');
  if (values.suite && (values.scenario || values['resume-report']))
    throw new Error('--suite runs a whole folder; it takes no --scenario or --resume-report');
  if (values.rerun && !values.suite) throw new Error('--rerun applies to --suite only');
  if (values.tools !== undefined && !values.suite)
    throw new Error('--tools applies to --suite only');
  parseToolScope(values.tools);
  if (values['switch-mode'] && !values.run) throw new Error('--switch-mode requires --run');
  const root = path.resolve(values['instance-dir']);
  const interrupt = deps.signal ? null : interruptSignal();
  deps = { ...deps, signal: deps.signal ?? interrupt.signal };
  try {
    if (values.suite) return await runSuite({ root, suite: values.suite, values, deps });
    if (values['switch-mode'] && values.scenario) return await runOneInMode({ root, values, deps });
    return (await runOne({ root, file: values.scenario, values, deps })).code;
  } finally {
    interrupt?.dispose();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
