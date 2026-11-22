import type { NativeAgentOptions, NativeAgentSender } from './agent-options.js';
import { digest, fail, reason } from './agent-support.js';
import { CoordinatorError } from './errors.js';
import type { NativeExport, NativeExportReceipt } from '../domain/delivery/native-exports.js';
import type { createNativeAgentStorage } from '../infrastructure/storage/agent-storage.js';
import type { createNativeAgentAuthority } from './agent-authority.js';
import type { IdentityRow } from './agent-options.js';
import type { readNativeRun } from '../mastra/runtime/inspection.js';
import { buildAnswerFooter } from '../domain/delivery/replies.js';
import { answerPreview, splitLongAnswer } from '../domain/delivery/long-answer.js';

type Inspection = {
  delivery: Record<string, unknown> | null;
  suspended: Awaited<ReturnType<typeof readNativeRun>>['suspended'];
  actions: { action: string }[];
  active: boolean;
};

/** Owns current recipient checks and transport receipts. Unknown effects are never retried.
 * Settings changes apply to new requests: a finished run is presented under the
 * settings it was accepted with. Authorization changes apply immediately. */
export function createNativeAgentDelivery(
  options: NativeAgentOptions,
  receipts: ReturnType<typeof createNativeAgentStorage>,
  authority: ReturnType<typeof createNativeAgentAuthority>,
  callbacks: {
    track<T>(work: Promise<T>): Promise<T>;
    result(runId: string, actor: string, owner: string): Promise<unknown>;
    inspect(runId: string, actor: string, owner: string): Promise<Inspection>;
  },
) {
  const { row, admit, runModel } = receipts;
  const { authorize, recipient, policyCurrent } = authority;
  const { track, result, inspect } = callbacks;
  /** Current recipient authority for an answer in `outcome` (`retained` before
   * admission, `uncertain` after it, nothing sent yet either way). A refusal is
   * final: the answer is withheld, never retained forever, and the run ID and
   * code are logged. Any other error (transport, timeout) is no decision: the
   * answer stays retained for a later presentation. */
  async function currentRecipient(r: IdentityRow, outcome: 'retained' | 'uncertain') {
    try {
      return { cfg: await recipient(r) };
    } catch (error) {
      if (error instanceof CoordinatorError) {
        const withheld = await options.pool.query(
          "UPDATE native_agents.deliveries SET outcome='withheld' WHERE run_id=$1 AND outcome=$2 RETURNING run_id",
          [r.run_id, outcome],
        );
        if (withheld.rowCount) {
          options.log.warn(`native delivery withheld run_id=${r.run_id} reason=${error.code}`);
          return { withheld: error.code };
        }
      } else if (outcome === 'uncertain')
        await options.pool.query(
          "UPDATE native_agents.deliveries SET outcome='retained' WHERE run_id=$1 AND outcome='uncertain'",
          [r.run_id],
        );
      options.log.warn(`native delivery refused run_id=${r.run_id} reason=${reason(error)}`);
      throw error;
    }
  }
  return {
    /** One-shot presentation. Questions/failures are transport notices, not a
     * second execution snapshot. Receipt BEFORE sending means unknown never replays. */
    present(
      runId: string,
      actor: string,
      owner: string,
      send: NativeAgentSender,
    ): Promise<unknown> {
      return track(
        (async () => {
          const r = await row(runId, actor, owner);
          let cancelledBefore = (
            await options.pool.query(
              "SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='cancel'",
              [runId],
            )
          ).rowCount;
          // Joins this process's execution. A refusal here is not fatal: the
          // inspection below decides, but the refusal stays visible.
          if (!cancelledBefore)
            await result(runId, actor, owner).catch((error) =>
              options.log.warn(
                `native presentation result refused run_id=${runId} reason=${reason(error)}`,
              ),
            );
          cancelledBefore = (
            await options.pool.query(
              "SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='cancel'",
              [runId],
            )
          ).rowCount;
          // An answer goes to delivery, which decides on current authority
          // itself, also when inspection would refuse the recipient.
          if (
            !cancelledBefore &&
            (
              await options.pool.query('SELECT 1 FROM native_agents.deliveries WHERE run_id=$1', [
                runId,
              ])
            ).rowCount
          )
            return this.deliver(runId, actor, owner, send);
          const inspected = cancelledBefore
            ? {
                delivery: null,
                suspended: undefined,
                actions: [{ action: 'cancel' }],
                active: false,
              }
            : await inspect(runId, actor, owner);
          if (inspected.delivery) return this.deliver(runId, actor, owner, send);
          // A run still executing here has no outcome yet. A notice would claim
          // one and make its later answer undeliverable.
          if (inspected.active) fail('native_run_still_active');
          const cancelled = inspected.actions.some((a) => a.action === 'cancel');
          const cfg = await authorize(r, 'task.read');
          // A question needs `continue`, and a continue runs only under the
          // run's accepted settings. After a settings change it could never be
          // answered, so the run ends with the failure notice instead.
          const asked = cancelled ? undefined : inspected.suspended;
          const question = asked && (await policyCurrent(r, cfg)) ? asked : undefined;
          const text = cancelled
            ? 'Stopped. Unconfirmed work will not restart or deliver.'
            : question
              ? `${answerPreview(question.question)}\n\nMention me in this thread with \`continue <answer>\` or \`cancel\`.`
              : 'No confirmed answer. Execution stopped or was refused; no automatic replay. Submit a fresh authorized request.';
          const action = cancelled
            ? 'notice:cancel'
            : question
              ? `notice:question:${question.toolCallId}`
              : 'notice:failure';
          const admitted = await options.pool.query(
            'INSERT INTO native_agents.actions(run_id,action,actor,answer_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING action',
            [runId, action, actor, digest(text)],
          );
          if (!admitted.rowCount) return { duplicate: true, notice: action };
          if (action === 'notice:failure')
            options.log.warn(
              asked
                ? `native failure notice run_id=${runId}; question withdrawn reason=execution_policy_changed_start_fresh`
                : `native failure notice run_id=${runId}; no retained answer`,
            );
          await authorize(r, 'task.read');
          try {
            const sent = await send({
              operationId: noticeOperationId(runId, action),
              taskKey: r.task_key,
              channel: r.accepted.channelId,
              rootTs: r.accepted.rootTs,
              requesterUserId: r.accepted.userId,
              text,
            });
            await authorize(r, 'task.read');
            if (sent.ts) await admit(r, `ack:${action}`);
            else options.log.warn(`native notice unconfirmed run_id=${runId} notice=${action}`);
            return { notice: action, outcome: sent.ts ? 'delivered' : 'uncertain' };
          } catch (error) {
            options.log.warn(
              `native notice unconfirmed run_id=${runId} notice=${action} reason=${reason(error)}`,
            );
            return { notice: action, outcome: 'uncertain' };
          }
        })(),
      );
    },
    async deliveryAuthority(runId: string, actor: string, owner: string, operationId: string) {
      const r = await row(runId, actor, owner);
      await recipient(r);
      const admitted = await options.pool.query(
        "SELECT 1 FROM native_agents.deliveries WHERE run_id=$1 AND operation_id=$2 AND outcome='uncertain'",
        [runId, operationId],
      );
      if (!admitted.rowCount) fail('delivery_not_admitted');
      return { ok: true };
    },
    async exportReceipt(
      runId: string,
      actor: string,
      owner: string,
      operationId: string,
      receipt: NativeExportReceipt,
    ) {
      await this.deliveryAuthority(runId, actor, owner, operationId);
      if (
        !receipt ||
        !/^F[A-Z0-9]+$/.test(receipt.fileId) ||
        !receipt.permalink?.startsWith('https://')
      )
        fail('export_receipt_invalid');
      const saved = await options.pool.query(
        `UPDATE native_agents.exports SET receipt=$3
        WHERE run_id=$1 AND id=$2 AND sha256=$4 AND octet_length(content)=$5
        AND (receipt IS NULL OR receipt=$3::jsonb) RETURNING id`,
        [runId, receipt.id, JSON.stringify(receipt), receipt.sha256, receipt.bytes],
      );
      if (!saved.rowCount) fail('export_receipt_mismatch');
      return { ok: true };
    },
    /** Transport owns Slack; this boundary owns current recipient authority and
     * the one-shot delivery identity. Unknown sends stay uncertain, never retry. */
    deliver(
      runId: string,
      actor: string,
      owner: string,
      send: NativeAgentSender,
    ): Promise<Record<string, unknown>> {
      return track(
        (async () => {
          const r = await row(runId, actor, owner);
          const before = await currentRecipient(r, 'retained');
          if ('withheld' in before) return { outcome: 'withheld', reason: before.withheld };
          // Every executed run records its model before its first segment, so
          // only a run without an answer lacks one.
          const modelKey = await runModel(r);
          if (
            !modelKey &&
            (
              await options.pool.query(
                "SELECT 1 FROM native_agents.deliveries WHERE run_id=$1 AND outcome='retained'",
                [runId],
              )
            ).rowCount
          )
            fail('run_model_unrecorded');
          const d = (
            await options.pool.query(
              `UPDATE native_agents.deliveries SET outcome='uncertain'
        WHERE run_id=$1 AND outcome='retained' RETURNING *`,
              [runId],
            )
          ).rows[0];
          if (!d) return { duplicate: true, ...(await inspect(runId, actor, owner)).delivery };
          // Recheck after admission. Revocation denies sending and cannot confirm a
          // stale owner even when an external ACK arrives after revocation/cancel.
          const admitted = await currentRecipient(r, 'uncertain');
          if ('withheld' in admitted)
            return { outcome: 'withheld', operationId: d.operation_id, reason: admitted.withheld };
          // Logged once: only one delivery passes admission. An unknown current
          // definition is no reason to log a change.
          if (!(await policyCurrent(r, admitted.cfg).catch(() => true)))
            options.log.info(`native delivery policy_changed_delivered run_id=${runId}`);
          try {
            const files: NativeExport[] = (
              await options.pool.query(
                'SELECT id,name,sha256,content FROM native_agents.exports WHERE run_id=$1 ORDER BY id',
                [runId],
              )
            ).rows.map((f) => ({
              id: f.id,
              name: f.name,
              sha256: f.sha256,
              bytes: f.content.length,
              data: f.content.toString('base64'),
            }));
            // Above Slack's limit the message carries a preview, and the full
            // answer goes to the thread as a file in the same one-shot delivery.
            const long = splitLongAnswer(d.text);
            if (long && long.file.sha256 !== d.sha256) fail('answer_file_identity_mismatch');
            const sent = await send({
              operationId: d.operation_id,
              taskKey: r.task_key,
              channel: r.accepted.channelId,
              rootTs: r.accepted.rootTs,
              text: long ? long.preview : d.text,
              footer: buildAnswerFooter(modelKey!),
              requesterUserId: r.accepted.userId,
              ...(files.length ? { files } : {}),
              ...(long ? { answerFile: long.file } : {}),
              ...(files.length || long ? { authority: { runId, actor, owner } } : {}),
            });
            await recipient(r);
            if (long) {
              // The file outcome is a receipt for inspection; a failed or unknown
              // upload is never retried. The message says so to the user.
              const a = sent.answerFile;
              const attached =
                a?.attached === true &&
                /^F[A-Z0-9]+$/.test(a.fileId) &&
                a.sha256 === d.sha256 &&
                a.bytes === long.file.bytes;
              await options.pool.query(
                'INSERT INTO native_agents.actions(run_id,action,actor,answer_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
                [
                  runId,
                  `answer-file:${attached ? a.fileId : 'unattached'}`,
                  r.accepted.userId,
                  d.sha256,
                ],
              );
            }
            if (files.length) {
              if (sent.files?.length !== files.length) fail('export_delivery_unconfirmed');
              for (const f of files) {
                const receipt = sent.files.find((p) => p.id === f.id);
                if (
                  !receipt ||
                  receipt.sha256 !== f.sha256 ||
                  receipt.bytes !== f.bytes ||
                  !/^F[A-Z0-9]+$/.test(receipt.fileId) ||
                  !receipt.permalink.startsWith('https://')
                )
                  fail('export_delivery_unconfirmed');
                await options.pool.query(
                  'UPDATE native_agents.exports SET receipt=$2 WHERE id=$1 AND receipt IS NULL',
                  [f.id, JSON.stringify(receipt)],
                );
              }
            }
            if (!sent.ts) fail('delivery_receipt_missing');
            const confirmed = await options.pool.query(
              `UPDATE native_agents.deliveries SET outcome='delivered',slack_ts=$2 WHERE run_id=$1 AND outcome='uncertain' AND EXISTS(SELECT 1 FROM native_agents.tasks WHERE task_key=$3 AND owner=$4) AND NOT EXISTS(SELECT 1 FROM native_agents.actions WHERE run_id=$1 AND action='cancel') RETURNING run_id`,
              [runId, sent.ts, r.task_key, r.owner],
            );
            if (!confirmed.rowCount) fail('delivery_confirmation_refused');
            return {
              outcome: 'delivered',
              operationId: d.operation_id,
              sha256: d.sha256,
              bytes: d.bytes,
            };
          } catch (error) {
            // Unknown sends stay uncertain and are never retried; say why.
            options.log.warn(
              `native delivery uncertain run_id=${runId} operation_id=${d.operation_id} reason=${reason(error)}`,
            );
            return { outcome: 'uncertain', operationId: d.operation_id };
          }
        })(),
      );
    },
  };
}

function noticeOperationId(runId: string, action: string) {
  const h = digest(`${runId}:${action}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
