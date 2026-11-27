# ask_user: options as Slack buttons

Status: In progress

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
- [ ] T0 to T3 `application`, T4 stub suite, PR, deploy, live click in #test-1234.

## Verification

- Deterministic: pending.
- Live: pending. T5 BLOCKED (no gateway test instance with the needed tools); the
  stub suite cannot click a button, so the click is verified live on staging.

## Rollout

Pending.
