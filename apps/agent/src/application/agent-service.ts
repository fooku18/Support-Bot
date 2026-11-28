import { providerSearchEnabled } from '../mastra/tools/provider-search.js';
import { nativeCodeModeTools } from '../mastra/tools/code-mode.js';
import { channelToolGranted } from './tool-grant.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { nativeAgentOperations, readNativeRun } from '../mastra/runtime/inspection.js';
import { createNativeRuntime } from '../mastra/runtime/agent.js';
import { runNativeSegment } from '../mastra/runtime/segment.js';
import { createReadServiceTools } from '../mastra/tools/read-services.js';
import { buildTaskKey } from '../contracts/protocol.js';
import {
  nativeInputFiles,
  NATIVE_INPUT_VERSION,
  NATIVE_INPUT_COUNT,
  NATIVE_INPUT_BYTES,
} from '../domain/files/native-inputs.js';
import { withThreadContext } from '../integrations/slack/message-client.js';
import { nativeInputMessage, NativeInputEncodingError } from '../mastra/runtime/native-inputs.js';
import { coordinatorRunConfiguration, resolveChannelModel } from './configuration/config.js';
import { CoordinatorError } from './errors.js';
import type { IdentityRow, NativeAgentInput, NativeAgentOptions } from './agent-options.js';
import { fail, digest, reason } from './agent-support.js';
import { createNativeAgentStorage } from '../infrastructure/storage/agent-storage.js';
import { createNativeAgentAuthority } from './agent-authority.js';
import { createNativeAgentDelivery } from './agent-delivery.js';
import { createRunStatus, RUN_STATUS_START, toolStatus } from '../domain/delivery/run-status.js';

/** An admitted execution of this process, from admission until it settles. */
type ActiveRun = { abort(): Promise<void>; completion?: Promise<unknown> };

/** Thin single-process application boundary. Mastra owns execution and suspension.
 * App admission receipts prohibit repeating an ambiguous start/resume/send. Native
 * recovery is off: a dead process needs a new explicit request, never a replay. */
export function createNativeAgentService(options: NativeAgentOptions) {
  const receipts = createNativeAgentStorage(options.pool);
  const {
    taskLock,
    unlock,
    row,
    stopped,
    admit,
    recordModel,
    threadSeenThrough,
    recordThreadSeen,
    inputReceipts,
    sequence,
    retain,
  } = receipts;
  const authority = createNativeAgentAuthority(options, receipts);
  const { authorize, definition, inputIdentity, checkInputs } = authority;
  const active = new Map<string, ActiveRun>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  function accept<T>(work: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new CoordinatorError(503, 'native_agent_closing'));
    // Register admissions before asynchronous preparation, including work that
    // has not yet obtained a native stream when shutdown begins.
    return track(Promise.resolve().then(work));
  }
  /** The thread messages the model conversation has not seen. `seen` says
   * whether the conversation holds the thread up to this request once its
   * segment finishes. Context only: an unavailable read leaves the request as
   * it is, and the next request reads the same range again. */
  async function threadContext(
    r: IdentityRow,
    conversation: { epoch: string },
    prompt: string,
    signal: AbortSignal,
  ) {
    if (!options.messages) return { seen: false, request: prompt };
    if (r.accepted.messageTs === r.accepted.rootTs) return { seen: true, request: prompt };
    const after = await threadSeenThrough(r, conversation);
    try {
      const context = await options.messages.thread(r.accepted, after, signal);
      return {
        seen: true,
        rootImages: after === null ? context.rootImages : undefined,
        request: context.messages.length ? withThreadContext(prompt, context, after) : prompt,
      };
    } catch {
      signal.throwIfAborted();
      options.log.warn(`native thread context unavailable run_id=${r.run_id}`);
      return { seen: false, request: prompt };
    }
  }
  async function execute(
    r: IdentityRow,
    input: { prompt: string } | { answer: string; toolCallId: string },
    handle: ActiveRun,
    started: () => void,
  ) {
    // Runs before the first await, so a cancellation during preparation aborts it.
    const signal = new AbortController();
    handle.abort = async () => {
      signal.abort();
    };
    await stopped(r);
    const cfg = await authorize(r, 'task.start');
    const current = coordinatorRunConfiguration(cfg, r.accepted.teamId, r.accepted.channelId);
    const trusted = await definition(r.accepted, cfg);
    // core@1.83.0 restores its saved instructions on cold resume. Public resume
    // instructions do not replace them (retained repro). Settings changed before
    // a segment is admitted require a fresh request (the failure notice, or a
    // refused `continue`); never start a segment under stale settings.
    if (trusted.hash !== r.execution_policy_hash) fail('execution_policy_changed_start_fresh');
    // Once admitted, the segment finishes under its accepted settings: later
    // changes apply to new requests. Authorization, cancellation, input
    // receipts and each tool's pinned instance still apply immediately.
    let admitted = false;
    const binding = await options.services(r.accepted, signal.signal);
    for (const { tool, reason } of binding.unavailable)
      options.log.warn(`native tool left out run_id=${r.run_id} tool=${tool} reason=${reason}`);
    // Bind only exact current instance/version. A later replacement is revocation,
    // not permission to reuse the old scoped client's credentials.
    const pins = new Map(
      current.tools.filter((t) => t.ready).map((t) => [t.kind as string, JSON.stringify(t)]),
    );
    const guard = async (capability?: string) => {
      if (signal.signal.aborted) fail('cancelled_no_replay');
      await stopped(r);
      const fresh = await authorize(
        r,
        capability && capability !== 'gitlab' ? 'tool.use' : 'task.start',
        capability,
      );
      if (!admitted && (await definition(r.accepted, fresh)).hash !== r.execution_policy_hash)
        fail('execution_policy_changed_start_fresh');
      if (capability) {
        const tool = coordinatorRunConfiguration(
          fresh,
          r.accepted.teamId,
          r.accepted.channelId,
        ).tools.find((t) => t.kind === capability);
        if (!tool || pins.get(capability) !== JSON.stringify(tool)) fail('service_binding_revoked');
      }
      await checkInputs(r, signal.signal);
    };
    const { model, instructions } = trusted;
    const reads = createReadServiceTools({
      ...binding,
      catalog: { ...binding.catalog, slackSearch: false },
      authorize: guard,
    });
    const codeMode =
      Object.keys(reads).length > 0 && channelToolGranted(cfg, r.accepted, 'codeMode')
        ? nativeCodeModeTools(reads, () => guard('codeMode'))
        : undefined;
    const modelBinding = options.bindModel(model, r.accepted, {
      runId: r.run_id,
      runSeq: await sequence(r),
    });
    const citationIds = new Set<string>();
    const runtime = createNativeRuntime({
      storage: options.storage,
      ...(options.observability
        ? {
            observability: {
              runId: r.run_id,
              threadId: r.task_key,
              resourceId: JSON.stringify([r.accepted.teamId, r.accepted.installationId]),
            },
          }
        : {}),
      model: {
        ...modelBinding,
        onCitation: (markdown) => citationIds.add(digest(markdown)),
      },
      beforeDispatch: () => guard(),
      ...(providerSearchEnabled(cfg, r.accepted)
        ? { webSearch: { authorize: () => guard('webSearch') } }
        : {}),
      instructions,
      tools: reads,
      unavailableTools: binding.unavailable.map((u) => u.tool),
      codeMode,
      nativeInputs: !!options.inputs,
      ...options.limits,
      contextTokens: modelBinding.selection.contextTokens,
    });
    let timer: NodeJS.Timeout | undefined;
    const beganAt = performance.now();
    const logger = runtime.mastra.getLogger();
    try {
      const conversation = await recordModel(r, model);
      await guard();
      const memory = {
        thread: digest(JSON.stringify([NATIVE_INPUT_VERSION, r.task_key, conversation.epoch])),
        resource: digest(JSON.stringify([r.accepted.teamId, r.accepted.installationId])),
      };

      await admit(
        r,
        'prompt' in input ? 'start' : `resume:${input.toolCallId}`,
        'answer' in input ? input.answer : undefined,
      );
      admitted = true;
      logger.info('native.segment.started', { runId: r.run_id });
      // A mention inside a thread is often about what the thread already says.
      // The model gets each thread message once per conversation, as untrusted data.
      const thread =
        'prompt' in input
          ? await threadContext(r, conversation, input.prompt, signal.signal)
          : { seen: false, request: '' };
      const request = thread.request;
      if ('prompt' in input && request !== input.prompt) await guard();
      let prompt: Parameters<typeof runtime.agent.stream>[0] = request;
      const requester = inputIdentity(r.accepted);
      const inputs = (r.accepted.files ?? []).map((file) => ({ file, identity: requester }));
      if (thread.rootImages) {
        const identity = {
          ...requester,
          messageTs: requester.rootTs,
          userId: thread.rootImages.userId,
          authorBotId: null,
        };
        inputs.push(
          ...nativeInputFiles(thread.rootImages.files, identity.messageTs).map((file) => ({
            file,
            identity,
          })),
        );
      }
      if (options.inputs && inputs.length && 'prompt' in input) {
        // Return the admitted handle before downloading. Cancellation and drain
        // cover acquisition too. An ambiguous read is never replayed on this run.
        started();
        timer = setTimeout(() => signal.abort(), options.limits.timeoutMs);
        timer.unref();
        await admit(r, 'input-acquire');
        const prior = await inputReceipts(r);
        const union = new Map(prior.map((p) => [`${p.file.id}:${p.file.sourceTs}`, p.file]));
        for (const { file } of inputs) {
          const key = `${file.id}:${file.sourceTs}`;
          if (union.has(key)) fail('input_already_exposed_follow_up_without_reattachment');
          union.set(key, file);
        }
        if (
          union.size > NATIVE_INPUT_COUNT ||
          [...union.values()].reduce((n, f) => n + f.bytes, 0) > NATIVE_INPUT_BYTES
        )
          fail('input_thread_bounds_start_fresh_thread');
        const acquired = [];
        for (const { file, identity } of inputs) {
          await guard();
          const bytes = await options.inputs.acquire(requester, file, signal.signal, identity);
          await guard();
          acquired.push({
            bytes,
            receipt: {
              identity,
              file,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          });
        }
        prompt = nativeInputMessage(request, acquired, model.route);
        await options.inputs.check(
          inputIdentity(r.accepted),
          acquired.map((a) => a.receipt),
          signal.signal,
        );
        await guard();
        const recorded = await options.pool.query(
          `UPDATE native_agents.requests SET input_receipts=$2 WHERE run_id=$1 AND input_receipts='[]'::jsonb
           AND EXISTS(SELECT 1 FROM native_agents.tasks WHERE task_key=$3 AND owner=$4)
           AND NOT EXISTS(SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='cancel') RETURNING run_id`,
          [r.run_id, JSON.stringify(acquired.map((a) => a.receipt)), r.task_key, r.owner],
        );
        if (!recorded.rowCount) fail('input_receipt_unconfirmed');
        await guard();
      }
      const opts = {
        instructions,
        runId: r.run_id,
        memory,
        closeOnSuspend: true,
        autoResumeSuspendedTools: false,
        abortSignal: signal.signal,
        maxSteps: options.limits.maxSteps,
        modelSettings: { maxOutputTokens: options.limits.outputTokens, maxRetries: 0 },
        toolCallConcurrency: 1,
        maxProcessorRetries: 0,
        disableBackgroundTasks: true,
      };
      const segment =
        'prompt' in input
          ? await runtime.agent.stream(prompt, opts)
          : await runtime.agent.resume(r.run_id, input.answer, {
              ...opts,
              toolCallId: input.toolCallId,
            });
      handle.abort = async () => {
        signal.abort();
        await segment.abort('Authorized cancellation');
      };
      started();
      clearTimeout(timer);
      timer = setTimeout(() => {
        signal.abort();
        void segment.abort('Execution deadline');
      }, options.limits.timeoutMs);
      timer.unref();
      const status = createRunStatus(async (text) =>
        options.status?.({
          taskKey: r.task_key,
          channel: r.accepted.channelId,
          rootTs: r.accepted.rootTs,
          requesterUserId: r.accepted.userId,
          runId: r.run_id,
          text,
        }),
      );
      if (options.status) status.report(RUN_STATUS_START);
      const result = await runNativeSegment(
        segment,
        options.status ? (name, args) => status.report(toolStatus(name, args)) : undefined,
      ).finally(() => status.settled());
      if (thread.seen && !result.uncertain) await recordThreadSeen(r, conversation);
      await guard();
      // Searches and fetches already ran, each authorized at its dispatch. Record
      // them under the run's current authority; a later tool assignment change
      // must not discard the finished answer.
      for (const search of result.webSearch) {
        // Retain only counts and a hashed identity, never queries or result bodies.
        await options.pool.query(
          'INSERT INTO native_agents.actions(run_id,action,actor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [
            r.run_id,
            `web-search:${digest(search.toolCallId)}:${search.results}`,
            r.accepted.userId,
          ],
        );
      }
      if (result.webSearch.length)
        for (const id of citationIds)
          await options.pool.query(
            'INSERT INTO native_agents.actions(run_id,action,actor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [r.run_id, `web-citation:${id}`, r.accepted.userId],
          );
      for (const fetch of result.webFetch) {
        await options.pool.query(
          'INSERT INTO native_agents.actions(run_id,action,actor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [
            r.run_id,
            `web-fetch:${fetch.id}:${fetch.url}:${fetch.sha256}:${fetch.bytes}`,
            r.accepted.userId,
          ],
        );
      }
      let text = result.text ?? '';
      const withConversationNotice = (answer: string) =>
        conversation.changed
          ? `The selected model changed. This reply starts a fresh model conversation in this thread.\n\n${answer}`
          : answer;
      if (!result.suspended && !result.uncertain && text.trim()) {
        text = withConversationNotice(text);
        await retain(r, text);
      }
      logger.info('native.segment.ended', {
        runId: r.run_id,
        durationMs: performance.now() - beganAt,
        ...(typeof result.usage?.inputTokens === 'number'
          ? { inputTokens: result.usage.inputTokens }
          : {}),
        ...(typeof result.usage?.outputTokens === 'number'
          ? { outputTokens: result.usage.outputTokens }
          : {}),
      });
      return { ...result, text, owner: r.owner };
    } catch (error) {
      logger.warn('native.segment.failed', {
        runId: r.run_id,
        durationMs: performance.now() - beganAt,
        errorCount: 1,
      });
      // An admitted segment is never re-started, including on an unknown snapshot
      // outcome. Inspection exposes its admission receipt, not invented success.
      if (error instanceof CoordinatorError) throw error;
      options.log.warn(`native segment failed run_id=${r.run_id} reason=${reason(error)}`);
      if (error instanceof NativeInputEncodingError)
        return {
          runId: r.run_id,
          owner: r.owner,
          uncertain: true,
          failure: 'unsupported_input_encoding',
          receipt: error.message,
        };
      return {
        runId: r.run_id,
        owner: r.owner,
        uncertain: true,
        receipt: 'Execution interrupted; no automatic restart. Inspect retained framework memory.',
      };
    } finally {
      clearTimeout(timer);
      signal.abort();
      // Flush the official exporter after the segment has settled, including
      // failure/cancellation. Shutdown never resumes retained execution.
      await runtime.mastra.shutdown({ drainTimeout: 30000 });
    }
  }
  /** Executes an admitted run. An execution that ends without a result is
   * logged with the run ID and the refusal code. For a fresh request it still
   * returns the admitted handle: the request is recorded and owns its thread,
   * so presentation, not the transport, ends it with a visible notice (for
   * example after the channel's settings changed before execution). A resume
   * refusal leaves the suspended question in place and is returned. */
  async function launch(
    r: IdentityRow,
    input: { prompt: string } | { answer: string; toolCallId: string },
    lock: PoolClient,
  ) {
    return new Promise<{ runId: string; owner: string }>((resolve, reject) => {
      // Register the execution before its first await. Until the native stream
      // exists it still prepares (authority and input rechecks, bindings), and
      // a concurrent result/present (e.g. for a redelivered event's duplicate
      // handle) must join it, not mistake the admitted run for a finished one.
      const handle: ActiveRun = { abort: async () => {} };
      active.set(r.run_id, handle);
      const done = () => resolve({ runId: r.run_id, owner: r.owner });
      const completion = track(
        execute(r, input, handle, done).finally(() => {
          if (active.get(r.run_id) === handle) active.delete(r.run_id);
          return unlock(lock, r.task_key);
        }),
      );
      handle.completion = completion;
      void completion.then(done, (error) => {
        options.log.warn(`native run refused run_id=${r.run_id} reason=${reason(error)}`);
        if ('prompt' in input) done();
        else reject(error);
      });
    });
  }
  async function thread(
    identity: NativeAgentInput,
    anyParticipant = false,
    control?: 'task.cancel' | 'task.steer' | 'task.read',
  ) {
    const found = (
      await options.pool.query<IdentityRow>(
        'SELECT r.* FROM native_agents.tasks t JOIN native_agents.requests r ON r.task_key=t.task_key AND r.owner=t.owner WHERE t.task_key=$1',
        [buildTaskKey(identity)],
      )
    ).rows[0];
    if (!found) fail('thread_owner_required');
    const requester =
      found.accepted.userId === identity.userId &&
      (found.accepted.authorBotId ?? null) === (identity.authorBotId ?? null);
    if (!requester && !anyParticipant) fail('thread_owner_required');
    const cfg = await authorize(found, 'task.read');
    if (!requester && control)
      await authorize(
        {
          ...found,
          accepted: {
            ...found.accepted,
            userId: identity.userId,
            authorBotId: identity.authorBotId ?? null,
          },
        },
        control,
      );
    const delivered = await options.pool.query(
      "SELECT 1 FROM native_agents.deliveries WHERE run_id=$1 AND outcome='delivered'",
      [found.run_id],
    );
    return {
      runId: found.run_id,
      owner: found.owner,
      autoReplies: coordinatorRunConfiguration(cfg, identity.teamId, identity.channelId).channel
        .autoReplies,
      delivered: Boolean(delivered.rowCount),
      requester,
      requesterId: found.accepted.userId,
      question: delivered.rowCount ? undefined : await postedQuestion(found.run_id),
    };
  }
  /** The tool call of a suspended question whose notice was posted and not cancelled. */
  async function postedQuestion(runId: string) {
    const { suspended } = await readNativeRun(options.storage, runId);
    if (!suspended) return undefined;
    const { rows } = await options.pool.query<{ action: string }>(
      "SELECT action FROM native_agents.actions WHERE run_id=$1 AND action IN ('cancel',$2)",
      [runId, `notice:question:${suspended.toolCallId}`],
    );
    return rows.length === 1 && rows[0]!.action !== 'cancel' ? suspended.toolCallId : undefined;
  }
  async function start(accepted: NativeAgentInput, expectedOwner?: string, anyParticipant = false) {
    if ('inputFiles' in accepted || ('files' in accepted && !options.inputs))
      fail('native_files_unavailable');
    let files;
    try {
      files = nativeInputFiles(accepted.files, accepted.messageTs);
    } catch {
      fail('native_input_invalid_unsupported_or_over_bounds');
    }
    // Store only the authenticated author's public identity. Action tokens and
    // arbitrary transport properties never enter application/framework memory.
    const safe: NativeAgentInput = {
      installationId: accepted.installationId,
      teamId: accepted.teamId,
      channelId: accepted.channelId,
      rootTs: accepted.rootTs,
      eventId: accepted.eventId,
      messageTs: accepted.messageTs,
      userId: accepted.userId,
      text: '',
      canonicalText: '',
      authorBotId: accepted.authorBotId ?? null,
      ...(files.length ? { files } : {}),
    };
    const r: IdentityRow = {
      run_id: randomUUID(),
      task_key: buildTaskKey(safe),
      owner: randomUUID(),
      accepted: safe,
      execution_policy_hash: '',
    };
    if (
      !/^[UW][A-Z0-9]+$/.test(safe.userId) ||
      !safe.eventId ||
      safe.eventId.length > 256 ||
      typeof accepted.text !== 'string' ||
      accepted.text.length > 200000 ||
      typeof accepted.canonicalText !== 'string' ||
      accepted.canonicalText.length > 200000
    )
      fail('invalid_input');
    const admissionConfig = await authorize(r, 'task.start', undefined, true);
    if (
      expectedOwner &&
      !coordinatorRunConfiguration(admissionConfig, safe.teamId, safe.channelId).channel.autoReplies
    )
      fail('automatic_replies_disabled');
    r.execution_policy_hash = (await definition(safe, admissionConfig)).hash;
    const previous = async () =>
      (
        await options.pool.query<IdentityRow>(
          'SELECT * FROM native_agents.requests WHERE task_key=$1 AND event_id=$2',
          [r.task_key, safe.eventId],
        )
      ).rows[0];
    const duplicate = (old: IdentityRow) => {
      if (old.accepted.userId !== safe.userId) fail('wrong_actor');
      return { runId: old.run_id, owner: old.owner, duplicate: true };
    };
    const old = await previous();
    if (old) return duplicate(old);
    // Hold the segment lock before changing ownership. A busy refusal must
    // leave the current request usable and the new event eligible for retry.
    const tx = await taskLock(r.task_key, admissionConfig.admission.global);
    let handedOff = false;
    let inserted;
    try {
      await tx.query('BEGIN');
      if (expectedOwner) {
        // Check participation under the same lock that transfers ownership.
        // An ordinary reply cannot hijack another requester or abandon an
        // unresolved native question/uncertain delivery.
        const current = (
          await tx.query<IdentityRow>(
            'SELECT r.* FROM native_agents.tasks t JOIN native_agents.requests r ON r.task_key=t.task_key AND r.owner=t.owner WHERE t.task_key=$1',
            [r.task_key],
          )
        ).rows[0];
        if (
          !current ||
          current.owner !== expectedOwner ||
          (!anyParticipant &&
            (current.accepted.userId !== safe.userId ||
              (current.accepted.authorBotId ?? null) !== safe.authorBotId))
        )
          fail('thread_owner_required');
        const delivered = await tx.query(
          "SELECT 1 FROM native_agents.deliveries WHERE run_id=$1 AND outcome='delivered'",
          [current.run_id],
        );
        if (!delivered.rowCount) fail('thread_requires_explicit_control');
      }
      inserted = await tx.query(
        `INSERT INTO native_agents.requests(run_id,task_key,event_id,owner,accepted,execution_policy_hash) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(task_key,event_id) DO NOTHING RETURNING run_id`,
        [r.run_id, r.task_key, safe.eventId, r.owner, safe, r.execution_policy_hash],
      );
      if (inserted.rowCount)
        await tx.query(
          'INSERT INTO native_agents.tasks VALUES($1,$2) ON CONFLICT(task_key) DO UPDATE SET owner=excluded.owner',
          [r.task_key, r.owner],
        );
      await tx.query('COMMIT');
      if (!inserted.rowCount) return duplicate((await previous())!);
      handedOff = true;
      return launch(r, { prompt: accepted.canonicalText ?? accepted.text }, tx);
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      if (!handedOff) await unlock(tx, r.task_key);
    }
  }
  async function resume(
    runId: string,
    actor: string,
    owner: string,
    toolCallId: string,
    answer: string,
  ) {
    const r = await row(runId, actor, owner);
    if (
      !toolCallId ||
      toolCallId.length > 256 ||
      typeof answer !== 'string' ||
      !answer.trim() ||
      answer.length > 10000
    )
      fail('invalid_resume');
    const current = await authorize(r, 'task.steer');
    return launch(r, { answer, toolCallId }, await taskLock(r.task_key, current.admission.global));
  }
  async function result(runId: string, actor: string, owner: string) {
    const r = await row(runId, actor, owner);
    await authorize(r, 'task.read');
    const completion = active.get(runId)?.completion;
    if (completion) {
      const value = await completion;
      await authorize(r, 'task.read');
      await checkInputs(r, AbortSignal.timeout(90000));
      return value;
    }
    const inspection = await inspect(runId, actor, owner);
    const retained = (
      await options.pool.query('SELECT text FROM native_agents.deliveries WHERE run_id=$1', [runId])
    ).rows[0];
    return { ...inspection, owner, text: retained?.text };
  }
  async function inspect(runId: string, actor: string, owner: string) {
    const r = await row(runId, actor, owner);
    await authorize(r, 'task.read');
    await checkInputs(r, AbortSignal.timeout(90000));
    const { native, status, suspended } = await readNativeRun(options.storage, runId);
    const actions = (
      await options.pool.query(
        'SELECT action,actor,answer_hash,created_at FROM native_agents.actions WHERE run_id=$1 ORDER BY created_at',
        [runId],
      )
    ).rows;
    const delivery =
      (
        await options.pool.query(
          'SELECT operation_id,sha256,bytes,outcome,slack_ts FROM native_agents.deliveries WHERE run_id=$1',
          [runId],
        )
      ).rows[0] ?? null;
    return {
      runId,
      // The Slack message that started the run; callers correlate by it.
      messageTs: r.accepted.messageTs,
      native,
      suspended,
      actions,
      webSearch: actions.flatMap((a) => {
        const match = /^web-search:([a-f0-9]{64}):(\d+)$/.exec(a.action);
        return match ? [{ id: match[1], results: Number(match[2]) }] : [];
      }),
      webCitations: actions.flatMap((a) => {
        const match = /^web-citation:([a-f0-9]{64})$/.exec(a.action);
        return match ? [match[1]] : [];
      }),
      webFetch: actions.flatMap((a) => {
        const match = /^web-fetch:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64}):(\d+)$/.exec(
          a.action,
        );
        return match
          ? [{ id: match[1], url: match[2], sha256: match[3], bytes: Number(match[4]) }]
          : [];
      }),
      delivery,
      // A long answer's file: the Slack file ID, or unattached after a failed upload.
      answerFile:
        actions.flatMap((a) => {
          const match = /^answer-file:(F[A-Z0-9]+|unattached)$/.exec(a.action);
          return match
            ? [
                match[1] === 'unattached'
                  ? { attached: false, sha256: a.answer_hash }
                  : { attached: true, fileId: match[1], sha256: a.answer_hash },
              ]
            : [];
        })[0] ?? null,
      active: active.has(runId),
      receipt: actions.some((a) => a.action === 'cancel')
        ? 'Cancellation recorded. Unconfirmed work will not restart or deliver.'
        : !delivery && !active.has(runId) && status !== 'suspended'
          ? 'No confirmed result. Admitted work is never automatically restarted.'
          : undefined,
    };
  }
  const delivery = createNativeAgentDelivery(options, receipts, authority, {
    track,
    result,
    inspect,
  });
  return {
    thread,
    async selectedModel(teamId: unknown, channelId: unknown) {
      if (
        typeof teamId !== 'string' ||
        !/^T[A-Z0-9]+$/.test(teamId) ||
        typeof channelId !== 'string' ||
        !/^[CGD][A-Z0-9]+$/.test(channelId)
      )
        fail('invalid_channel');
      const selection = resolveChannelModel(await options.configuration(), teamId, channelId);
      if (!selection) fail('model_unavailable');
      return selection;
    },
    /** Operational projection of framework state. No workflow replay or parallel journal. */
    operations() {
      return nativeAgentOperations({
        pool: options.pool,
        storage: options.storage,
        active,
        state: () => ({ admitted: pending.size, accepting: !closing }),
      });
    },
    start(accepted: NativeAgentInput) {
      return accept(() => start(accepted));
    },
    followup(accepted: NativeAgentInput, expectedOwner: string, anyParticipant = false) {
      if (typeof expectedOwner !== 'string' || !expectedOwner) fail('thread_owner_required');
      return accept(() => start(accepted, expectedOwner, anyParticipant));
    },
    resume(runId: string, actor: string, owner: string, toolCallId: string, answer: string) {
      return accept(() => resume(runId, actor, owner, toolCallId, answer));
    },
    async close() {
      closing = true;
      // Native execution already has an abortable deadline. Join it rather than
      // closing its storage while it can still commit snapshots or results.
      while (pending.size) await Promise.allSettled([...pending]);
    },
    result,
    async cancel(runId: string, actor: string, owner: string) {
      const r = await row(runId, actor, owner);
      await authorize(r, 'task.cancel');
      await options.pool.query(
        `INSERT INTO native_agents.actions(run_id,action,actor) VALUES($1,'cancel',$2) ON CONFLICT DO NOTHING`,
        [runId, actor],
      );
      await active.get(runId)?.abort();
      return {
        runId,
        receipt: 'Cancellation recorded. Unconfirmed work will not restart or deliver.',
      };
    },
    inspect,
    ...delivery,
  };
}
export type NativeAgentService = ReturnType<typeof createNativeAgentService>;
