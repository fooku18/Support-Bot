# ask_user: options in the notice, plain replies, sensible defaults

Status: In progress

## Summary

On 2026-11-27 a requester asked for PDP traffic per hour, today against
yesterday. The agent listed nine storefronts and called `ask_user` with three
options. Slack showed only the question and asked for a mention with
`continue <answer>`. The requester replied a plain `De`, which was ignored, and
the run stayed suspended. Three defects:

1. The notice drops the model's `options`: the inspection projection keeps only
   `question`.
2. A suspended question needs a mention or `continue`, although the adapter
   already receives every thread reply.
3. The instructions say "Use ask_user for missing requirements", so the model
   asks where an obvious default exists. The same question was answered for all
   storefronts without asking earlier that day.

## Decisions and approach

- The inspection projection keeps the option labels. The question notice lists
  them as bullets and reads "Reply in this thread with your answer, or `cancel`
  to stop."
- While the thread's current run is suspended on `ask_user`, the requester's
  next unmentioned text reply is the answer. It skips the reply decider and
  works with automatic replies off, like `continue`. Replies from others,
  replies with files and replies that mention the bot keep their current routes.
  The service still checks `task.steer` at resume. A refused resume gets the usual
  private refusal notice. A plain `cancel` is already a control.
- No new Slack scope or event: the adapter already receives unmentioned thread
  replies (the reply decider since PR #8).
- The instructions now say to answer with an obvious default and state it, and to
  use `ask_user` only when no default fits and the choice would materially change
  the answer.

## Work

- [x] Project option labels in `nativeSuspension` and render them in the notice.
- [x] Resume a suspended question on the requester's plain thread reply.
- [x] Instruction for defaults instead of questions.
- [x] Stub scenario `ask-resume.json` answers with a plain unmentioned reply; the
      harness accepts a plain `mention: false` resume step.

## Verification

- Deterministic (2026-11-27, `ed9479f` working tree): T0 passes. T1, T2 and T3
  `application` (81 records) pass in a Linux container. New tests cover the
  projection, the notice text, the adapter route (the requester answers, others
  are ignored, mentions are not handled twice, a refused resume gets the notice)
  and the harness.
- T4 (stub suite on the local test instance, real Slack test app): 7 of 8 pass.
  `stub-ask-user-suspension-and-resume` passes with a plain unmentioned
  `teal-42` (3 model requests). `stub-cancel-control-stops-a-held-run` fails with
  `expected_answer_fact_missing`, as it does on `main` since `cccd7a9` (unrelated
  instance state, under investigation).
- T5: BLOCKED (no gateway test instance with the needed tools). Live acceptance
  on staging in #test-1234 after deployment.
- Live: pending.

## Rollout

Pending: merge, digest bump in the deployment repo, staging live check.

## Open items

- [ ] T1 to T4 results, T5.
