/* eslint-disable @typescript-eslint/no-explicit-any -- shares the synthetic application wire fixture */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

/** Backup and restore cases of the `backup` suite, run by native-image-vertical.ts:
 * `backup-source` leaves state in the source store, `backup-restore` checks it
 * in the restored store. */
export async function backupScenario(c: any) {
  const {
    root,
    phase,
    check,
    waitFor,
    call,
    get,
    event,
    emit,
    row,
    delivered,
    pool,
    posts,
    ephemeral,
    gatewayRequests,
  } = c;
  await check('restricted-restored-or-source-grants-and-single-execution-owner', async () => {
    await assert.rejects(pool.query('CREATE TABLE framework.forbidden_runtime_ddl(id int)'));
    // Only the receipt columns of publications are writable at runtime.
    await assert.rejects(pool.query('UPDATE native_agents.publications SET project=project'));
    const other = await c.launch(c.main, c.baseEnv, 'singleton-refused');
    assert.equal((await other.done).code, 1);
    assert.equal(gatewayRequests.length, 0);
    assert.equal(posts.length, 0);
    return { runtimeDdl: 'refused', publicationProjectWrite: 'refused', secondOwner: 'refused' };
  });
  if (phase === 'backup-source') {
    const saved: any = {};
    await check('source-retains-answer-two-questions-and-uncertain-delivery', async () => {
      for (const kind of ['answer', 'resume', 'revoked', 'uncertain']) {
        c.setDropSend(kind === 'uncertain');
        const e = event(
          ['resume', 'revoked'].includes(kind) ? 'ASK_ASSEMBLED' : 'ANSWER_ASSEMBLED',
        );
        await emit(e);
        const sent = await delivered(e);
        const handle = await row(e);
        if (['resume', 'revoked'].includes(kind)) {
          assert.match(sent.text, /Which assembled target/);
          assert.equal(
            (await call('inspect', { ...handle, actor: e.user })).suspended.toolCallId,
            'ask-assembled',
          );
        } else {
          assert.equal(sent.text, 'Assembled answer — amber 🦊.');
          await waitFor(
            async () =>
              (await call('inspect', { ...handle, actor: e.user })).delivery?.outcome ===
              (kind === 'uncertain' ? 'uncertain' : 'delivered'),
          );
        }
        saved[kind] = { event: e, handle };
      }
      c.setDropSend(false);
      await waitFor(async () => !(await get('/native/status')).active.length);
      await fs.writeFile(`${root}/backup-cases.json`, JSON.stringify(saved, null, 2));
      return { requests: 4, questions: 2, deliveredAnswer: 1, uncertainAnswer: 1 };
    });
  } else if (phase === 'backup-restore') {
    const saved = JSON.parse(await fs.readFile(`${root}/backup-cases.json`, 'utf8'));
    const request = (kind: string) => ({ ...saved[kind].handle, actor: saved[kind].event.user });
    await check('cold-restored-inspection-does-not-recover-or-send', async () => {
      const status = await get('/native/status');
      assert.equal(status.active.length, 0);
      // The two answer questions, plus the coding question of `coding-backup-source`.
      const waits = status.waits.map((w: any) => w.runId);
      assert.equal(waits.length, 3);
      for (const kind of ['resume', 'revoked']) assert(waits.includes(saved[kind].handle.runId));
      assert.equal(
        (await call('inspect', request('resume'))).suspended.toolCallId,
        'ask-assembled',
      );
      assert.equal((await call('inspect', request('answer'))).delivery.outcome, 'delivered');
      assert.equal((await call('inspect', request('uncertain'))).delivery.outcome, 'uncertain');
      assert.equal((await call('result', request('answer'))).text, 'Assembled answer — amber 🦊.');
      assert.equal(gatewayRequests.length, 0);
      assert.equal(posts.length, 0);
      return { active: 0, suspended: waits.length, providerCalls: 0, sends: 0 };
    });
    await check('current-policy-revocation-refuses-restored-resume-and-delivery', async () => {
      for (const kind of ['revoked', 'answer']) {
        c.setBlocked(saved[kind].event.user);
        await assert.rejects(
          call(kind === 'revoked' ? 'resume' : 'deliver', {
            ...request(kind),
            toolCallId: 'ask-assembled',
            answer: 'TARGET_ASSEMBLED',
          }),
        );
      }
      c.setBlocked(undefined);
      assert.equal(gatewayRequests.length, 0);
      assert.equal(posts.length, 0);
      return { refused: 2, providerCalls: 0, sends: 0 };
    });
    await check('restored-uncertainty-and-confirmed-receipt-never-resend', async () => {
      for (const kind of ['uncertain', 'answer']) {
        await call('present', request(kind));
        await call('deliver', request(kind));
      }
      assert.equal((await call('inspect', request('uncertain'))).delivery.outcome, 'uncertain');
      assert.equal(posts.length, 0);
      return { explicitPresentAndDeliver: 4, sends: 0, uncertaintyPreserved: true };
    });
    await check('only-explicit-current-owner-resumes-once-after-fresh-restore', async () => {
      const e = saved.resume.event;
      await assert.rejects(
        call('resume', {
          ...request('resume'),
          actor: 'UWRONGRESTORE',
          toolCallId: 'ask-assembled',
          answer: 'TARGET_ASSEMBLED',
        }),
      );
      assert.equal(gatewayRequests.length, 0);
      await emit(event('continue TARGET_ASSEMBLED', { user: e.user, thread_ts: e.ts }));
      assert.equal((await delivered(e)).text, 'Assembled answer — amber 🦊.');
      const count = ephemeral.length;
      await emit(event('continue TARGET_ASSEMBLED', { user: e.user, thread_ts: e.ts }));
      await waitFor(async () => ephemeral.length > count);
      assert.equal(gatewayRequests.length, 1);
      assert.equal(posts.length, 1);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='resume:ask-assembled'",
            [saved.resume.handle.runId],
          )
        ).rowCount,
        1,
      );
      return { providerCalls: 1, sends: 1, resumeAdmissions: 1, automaticRecovery: false };
    });
  } else throw new Error('backup fixture phase refused');
}
