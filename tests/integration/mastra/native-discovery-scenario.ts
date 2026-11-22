/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic wire assertions against actual native runtime */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export const discoveryState = {
  assigned: true,
  malformed: false,
  revoke: '' as '' | 'search' | 'execute',
  mode: 'read',
  stage: 0,
};
let serial = 0;

/** Deterministic provider peer, never an authorization substitute. It chooses
 * only from the schemas the actual Agent/processor sent to the Gateway. */
export function discoveryReply(body: any): any[] {
  const names = body.tools.map((t: any) => t.name);
  assert(names.includes('ask_user'), 'clarification must never require discovery');
  assert(names.includes('search_tools'));
  for (const forbidden of [
    'load_tool',
    'publish',
    'run_script',
    'task_exec',
    'create_issue',
    'slack_get_user',
    'datadog_call',
  ])
    assert(!names.includes(forbidden), forbidden);
  const tool = (name: string, input: unknown) => {
    assert(names.includes(name), `provider tried unavailable ${name}`);
    return [{ type: 'tool_use', id: `discovery-${++serial}`, name, input }];
  };
  const stage = discoveryState.stage++;
  if (stage === 0 && !names.includes('get_project')) {
    return tool(
      'search_tools',
      discoveryState.mode === 'bad-query'
        ? {}
        : {
            query: 'get_project',
          },
    );
  }
  if (discoveryState.mode === 'ask' && stage === 1)
    return tool('ask_user', { question: 'Which discovery project?' });
  if (
    discoveryState.mode === 'bad-query' ||
    discoveryState.mode === 'absent' ||
    (discoveryState.mode === 'bad-read' && stage >= 2)
  )
    return [{ type: 'text', text: 'No usable service tool.' }];
  const prompt = JSON.stringify(body.messages);
  const last = body.messages.at(-1);
  const lastText = JSON.stringify(last);
  if (names.includes('get_project') && !lastText.includes('SERVICE_FACT_cobalt_115_'))
    return tool(
      'get_project',
      discoveryState.mode === 'bad-read'
        ? { project: { invalid: true } }
        : { project: 'synthetic/fixture' },
    );
  const fact = [...prompt.matchAll(/SERVICE_FACT_cobalt_115_\d+/g)].at(-1)?.[0];
  return [{ type: 'text', text: fact ? `Read: ${fact}.` : 'No usable service tool.' }];
}

export async function discoveryScenario(c: any) {
  const {
    root,
    phase,
    caseId,
    check,
    service,
    adapter,
    pool,
    recorded,
    serviceCalls,
    slackBytes,
    makeInput,
    startAndWait,
  } = c;
  let suffix = 910000;
  function mode(value: string) {
    discoveryState.mode = value;
    discoveryState.stage = 0;
  }
  async function run(value = 'read', thread?: any) {
    mode(value);
    const unique = ++suffix;
    const input = makeInput(
      `DISCOVERY_${value}_${caseId}_${unique}`,
      `1794740000.${unique}`,
      `${value}-${unique}`,
    );
    if (thread) input.rootTs = thread.rootTs;
    const result = thread
      ? await (async () => {
          const owner = await service.thread(input);
          const handle = await service.followup(input, owner.owner);
          const result = await service.result(handle.runId, input.userId, handle.owner);
          const calls = c.calls();
          assert.equal((await service.followup(input, owner.owner)).duplicate, true);
          await assert.rejects(
            service.followup({ ...input, eventId: input.eventId + '-stale' }, owner.owner),
            /thread_owner_required/,
          );
          assert.equal(c.calls(), calls);
          return result;
        })()
      : await startAndWait(input);
    return { input, result };
  }
  const inspect = (r: any) => service.inspect(r.runId, 'UOWNER', r.owner);
  const resume = (r: any) =>
    service.resume(
      r.runId,
      'UOWNER',
      r.owner,
      r.suspended.toolCallId,
      'ANSWER_TARGET synthetic/fixture',
    );
  const names = (r: any) => r.tools.map((t: any) => t.name);
  const finish = (r: any) => adapter.deliver({ runId: r.runId, owner: r.owner, actor: 'UOWNER' });
  if (phase === 'discovery') {
    await check('restricted-role-and-no-publication-grants', async () => {
      assert.equal(
        (await pool.query('SELECT current_user AS name')).rows[0].name,
        'fixture_answer',
      );
      await assert.rejects(pool.query('CREATE TABLE framework.discovery_forbidden(id int)'));
      assert.equal(
        (await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]
          .rolsuper,
        false,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT has_table_privilege(current_user,'native_agents.publications','INSERT') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
      return { role: 'fixture_answer', ddl: 'denied' };
    });
    await check('native-search-service-dependent-read-and-followup-context', async () => {
      const offset = recorded.length;
      const before = serviceCalls.length;
      const first = await run();
      assert.equal(first.result.uncertain, false, JSON.stringify(first.result));
      assert.equal(serviceCalls.length, before + 1);
      assert.equal(first.result.text, `Read: SERVICE_FACT_cobalt_115_${before + 1}.`);
      assert.deepEqual(names(recorded[offset]).sort(), ['ask_user', 'search_tools']);
      assert(names(recorded[offset + 1]).includes('get_project'));
      assert.equal(recorded.length - offset, 3, 'search -> read -> answer');
      assert.equal(serviceCalls.at(-1).instanceId, 'ti_1150000000000001');
      assert.equal(serviceCalls.at(-1).teamId, 'TDURABLE');
      await finish(first.result);
      assert.equal(new URLSearchParams(slackBytes.at(-1)).get('text'), first.result.text);
      const nextOffset = recorded.length;
      const next = await run('follow', first.input);
      const followupTurns = recorded.length - nextOffset;
      assert.equal(next.result.text, `Read: SERVICE_FACT_cobalt_115_${before + 2}.`);
      assert(names(recorded[nextOffset]).includes('get_project'), 'context restores loaded tool');
      assert(JSON.stringify(recorded[nextOffset].messages).includes(first.input.text));
      const otherOffset = recorded.length;
      await run();
      assert.deepEqual(names(recorded[otherOffset]).sort(), ['ask_user', 'search_tools']);
      assert(!JSON.stringify(recorded[otherOffset].messages).includes(first.input.text));
      return { initialTurns: 3, followupTurns, reads: serviceCalls.length - before };
    });
    for (const bad of ['bad-query', 'bad-read'])
      await check(`framework-rejects-${bad}-without-service-call`, async () => {
        const before = serviceCalls.length;
        const offset = recorded.length;
        const answer = await run(bad);
        assert.equal(serviceCalls.length, before);
        assert(JSON.stringify(recorded.slice(offset)).match(/validation|invalid/i));
        assert(!answer.result.text.includes('SERVICE_FACT'));
        return { serviceCalls: 0, frameworkValidation: true };
      });
    await check('absent-assignment-hides-all-service-metadata', async () => {
      discoveryState.assigned = false;
      const before = serviceCalls.length;
      const offset = recorded.length;
      await run('absent');
      assert.equal(serviceCalls.length, before);
      assert.deepEqual(names(recorded[offset]).sort(), ['ask_user', 'search_tools']);
      const transcript = JSON.stringify(recorded.slice(offset));
      assert(!transcript.includes("Get a project's metadata"));
      assert(transcript.includes('No tools found'));
      discoveryState.assigned = true;
      return { serviceCalls: 0, searchResults: 0 };
    });
    await check('channel-assignment-applies-at-the-next-run-unassigned-then-restored', async () => {
      // Each run builds its tool list from the channel's current assignment:
      // unassigned, the next run has no service tool; assigned again, the
      // next run reads through the same instance.
      discoveryState.assigned = false;
      const before = serviceCalls.length;
      const offset = recorded.length;
      await run('absent');
      assert.equal(serviceCalls.length, before);
      assert(!names(recorded[offset]).includes('get_project'));
      discoveryState.assigned = true;
      const restoredOffset = recorded.length;
      const restored = await run();
      assert.equal(serviceCalls.length, before + 1);
      assert(names(recorded[restoredOffset + 1]).includes('get_project'));
      assert.equal(restored.result.text, `Read: SERVICE_FACT_cobalt_115_${before + 1}.`);
      assert.equal(serviceCalls.at(-1).instanceId, 'ti_1150000000000001');
      return { unassignedReads: 0, restoredReads: 1 };
    });
    await check('malformed-bound-readiness-refuses-before-inference', async () => {
      discoveryState.malformed = true;
      const before = c.calls();
      const logged = c.warnings.length;
      // The request was admitted: it ends without an answer, and presentation
      // posts the failure notice. Only the error class is logged.
      const { result } = await run();
      assert.equal(result.text, undefined, JSON.stringify(result));
      assert.equal(result.delivery, null);
      assert.equal(c.calls(), before);
      assert.deepEqual(c.warnings.slice(logged), [
        `native run refused run_id=${result.runId} reason=Error`,
      ]);
      assert.equal((await c.present(result)).notice, 'notice:failure');
      assert.match(new URLSearchParams(slackBytes.at(-1)).get('text')!, /No confirmed answer/);
      discoveryState.malformed = false;
      return { providerCalls: 0 };
    });
    for (const at of ['search', 'execute'] as const)
      await check(`current-assignment-revoked-at-${at}-prevents-service-execution`, async () => {
        const before = serviceCalls.length;
        const models = c.calls();
        discoveryState.revoke = at;
        const { result } = await run();
        // The run keeps its accepted settings and is not aborted; the revoked
        // tool itself is refused at every later call and never executes.
        assert.equal(result.uncertain, false, JSON.stringify(result));
        assert.equal(serviceCalls.length, before);
        const errors = result.progress.filter((p: any) => p.type === 'tool-error').length;
        assert(errors >= 1, JSON.stringify(result.progress));
        assert(c.calls() - models <= 4);
        discoveryState.assigned = true;
        discoveryState.revoke = '';
        return { providerCalls: c.calls() - models, serviceCalls: 0 };
      });
    await check('native-top-level-question-retains-search-context-for-cold-resume', async () => {
      const saved = await run('ask');
      assert(saved.result.suspended, JSON.stringify(saved.result));
      assert((await inspect(saved.result)).native);
      await c.present(saved.result);
      assert.match(new URLSearchParams(slackBytes.at(-1)).get('text')!, /Which discovery project/);
      const changed = await run('ask');
      const snapshot = `${root}/discovery-suspensions-${caseId}.json`;
      await fs.writeFile(snapshot, JSON.stringify({ saved, changed }), { flag: 'wx' });
      await fs.writeFile(`${root}/discovery-latest.json`, JSON.stringify({ snapshot }));
      return { questions: 2, tools: ['ask_user', 'search_tools'] };
    });
  } else {
    const { snapshot } = JSON.parse(await fs.readFile(`${root}/discovery-latest.json`, 'utf8'));
    const { saved, changed } = JSON.parse(await fs.readFile(snapshot, 'utf8'));
    await check('cold-inspection-and-changed-definition-refusal-without-inference', async () => {
      assert((await inspect(saved.result)).suspended);
      assert.equal(c.calls(), 0);
      c.changeInstructions();
      await assert.rejects(resume(changed.result), /execution_policy_changed_start_fresh/);
      assert.equal(c.calls(), 0);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action LIKE 'resume:%'",
            [changed.result.runId],
          )
        ).rowCount,
        0,
      );
      // A question a continue can no longer answer is withdrawn: the
      // presentation posts the failure notice instead, so the user starts fresh.
      const posts = slackBytes.length;
      assert.deepEqual(await c.present(changed.result), {
        notice: 'notice:failure',
        outcome: 'delivered',
      });
      assert.equal(slackBytes.length, posts + 1);
      const text = new URLSearchParams(slackBytes.at(-1)).get('text')!;
      assert.match(text, /No confirmed answer/);
      assert.doesNotMatch(text, /Which discovery project/);
      assert.equal(c.calls(), 0);
      return { inference: 0, changedDefinition: 'refused', question: 'withdrawn' };
    });
    // Restore only the trusted fixture instruction, never mutate retained rows.
    c.restoreInstructions();
    await check('cold-native-resume-current-authority-once-and-context-loaded-read', async () => {
      c.setBlocked(true);
      await assert.rejects(resume(saved.result));
      assert.equal(c.calls(), 0);
      c.setBlocked(false);
      mode('read');
      await resume(saved.result);
      const result = await service.result(saved.result.runId, 'UOWNER', saved.result.owner);
      assert.equal(result.uncertain, false, JSON.stringify(result));
      assert.equal(result.text, 'Read: SERVICE_FACT_cobalt_115_1.');
      assert(names(recorded[0]).includes('get_project'));
      assert(JSON.stringify(recorded[0].messages).includes('ANSWER_TARGET'));
      assert.equal(serviceCalls.length, 1);
      await finish(result);
      const before = c.calls();
      await assert.rejects(resume(saved.result));
      assert.equal(c.calls(), before);
      return { sameRun: result.runId, serviceReads: 1, repeatedResume: 'refused' };
    });
  }
}
