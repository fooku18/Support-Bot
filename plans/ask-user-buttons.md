# ask_user: options as Slack buttons

Status: Done

## Summary

Since [ask-user-plain-answers.md](ask-user-plain-answers.md) the question notice
lists the model's options as bullets and ends with "Reply in this thread with
your answer, or `cancel` to stop." The requester has to type an option to
choose it. The operator asked for one-click choices and for the hint line to go:
"Either the user answers, or not."

## Decisions and approach

A council (Sol, Fable, Kimi, read-only, 2026-11-27) agreed on the mechanism and
the guards. The design below is their common minimum.

- **Buttons, not reactions.** Interactivity is already on and the adapter already
  routes `interactive` envelopes after a channel membership check. Reactions
  would need `reactions:read`, the `reaction_added` event, a reinstall and an
  emoji-to-option mapping.
- **The notice.** A single-select question with 1 to 25 options, each at most 75
  characters (Slack's button limits), is posted as the question plus one
  `actions` block: `block_id` is the tool call ID, each button's `value` is its
  label. Other questions keep the bulleted text. The hint line is gone.
- **A click** (`questionClick` in `native-application.ts`) is acknowledged first,
  turned into the same thread identity a reply has, and looked up with
  `/agents/thread`. It answers only when the clicker is the requester and the
  open question is the button's tool call, so a stale button of an earlier
  question does nothing. It then takes the typed-answer path (`answerQuestion`:
  resume, refusal notice, presentation with the hourglass on the notice). After
  an accepted answer, `chat.update` keeps the posted blocks, drops the buttons
  and adds "✓ label" (best effort). Stale clicks and clicks after the answer
  are acknowledged and ignored. Someone other than the requester gets a private
  "Only the person who asked can answer this question."
- **Double clicks.** The task lock and the `resume:<toolCallId>` receipt already
  prevent a second resume; the adapter also drops a repeat click on a question
  it is answering, so the requester does not get a refusal notice for it.
- **Typed answers** keep working, so no "Other" button. A typed answer leaves the
  buttons; a later click finds no open question and is ignored.
- **Cancel.** Only the hint goes. `cancel` stays the general stop for running
  work. Sol and Kimi would also refuse `cancel` while a question is open so it
  cannot stop the run silently; not built, since nothing advertises it any more
  and it needs code and tests for no reported problem.
- **Deferred:** multi-select buttons (resume takes `string[]`, needs a submit),
  option descriptions, more than 25 options. The projection carries
  `multiSelect` only to keep such questions as text.
- No new scope, event, table, endpoint or setting.

## Work

- [x] Project `multiSelect` in `nativeSuspension`.
- [x] Notice: question only plus `choices` for button questions, bullets
      otherwise, no hint.
- [x] Sender and `postMessage` append the `actions` block.
- [x] `questionClick` answers through `answerQuestion` and updates the notice.
- [x] Tests: projection, notice text and fallbacks, blocks, click routing (requester,
      stale, other person, no open question, refused resume).
- [x] T0 to T3 `application`, PR [#38](https://github.com/fooku18/Support-Bot/pull/38).
- [x] Deploy, live click in #test-1234.

## Verification

- Deterministic (2026-11-28, head `2c220c3`): T0 passes. T1 and T2 pass in a Linux
  container (agent 719 tests, Slack 212, root 135). T3 `application` passes (82
  records). The click test fails without the handler.
- T4: not run. The shared local test instance was locked by another session, and
  the stub suite cannot click a button; `ask-resume.json` only drops the hint text.
- Live: T5 BLOCKED (no gateway test instance with the needed tools). Staging,
  #test-1234, 2026-11-27, image `4eca9d8`: a forced `ask_user` with three options
  (Germany, Poland, Czechia) was posted 7 s after the mention as the question with
  three buttons and no hint line. The requester's click on Germany resumed the run
  (adapter `question answered`, 23:21:37 UTC), the notice showed the choice in place
  of the buttons (no `question buttons not removed` warning), and the answer "You
  picked Germany." followed 4 s later. Not live-checked: a click by another person
  (one human sender available); covered by the adapter test.

## Rollout

Merged as `4eca9d8` (#38). Deployed to staging with deployment MR !23 (merge
`6da43e05`, 2026-11-27 23:14 UTC, image
`sha256:17a7d17504f1678e5c6da48a63a37be6269b3413946da5585cadfdbf28cce774`).
Rollback: pin the previous digest `sha256:7e224c8a…` (upstream `750386f`).
