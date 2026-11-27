# Thread reply decider

Status: In progress

## Summary

With **Automatic thread replies** on, every unmentioned message of the
requester in a thread with a confirmed answer starts a follow-up run. That
includes "thanks", "👍" and messages meant for colleagues, so the bot
answers messages that need no answer.

The adapter now asks a decision model (a "System One" model such as Jev or
its self-hosted clone clef-flash) whether the message is meant for the bot.
It starts the follow-up only when the model says so. A mention still always
starts a run. Without a configured decision model the adapter keeps
the current behaviour.

## Decisions and approach

- **Where:** the adapter's `reply` handler, after `/agents/thread` has
  confirmed the requester and the thread, before the follow-up is admitted.
  `/agents/thread` also returns `autoReplies` (the channel setting) and
  `delivered` (the current answer was delivered). The model is called only
  when both are true, so a message that admission would refuse never leaves
  the system. Admission still rechecks both atomically; an undelivered
  thread keeps its explicit-control notice.
- **API:** the Jev REST API (`POST /v1/systemone`), shared by Jev and its
  clones. One `choice` question, `reply` or `silent`. The bot replies when
  the model's choice is `reply`. Only the message text is sent, bounded to
  2,000 characters.
- **Mentions:** shown to the model as readable text (`@name`, `@someone`,
  `@group`, `@here`), with the "Sent using @app" attribution removed. The
  first version kept every message that mentioned someone else silent
  without asking the model, because raw ids (`<@U024MNGC32P>`) scored
  0.6–0.83 for `reply`. With readable mentions and the thread history the
  model kept all 10 messages aimed at someone else silent (2026-11-27), so
  that rule was dropped in a YAGNI pass; it had also caused the
  "Sent using" bug.
- **Files without text** (a screenshot) start the follow-up without calling
  the model. An empty message without files stays silent.
- **Request controls** (`continue <answer>`, `cancel`, `status`) skip the
  model.
- **Failure:** on a timeout (5 s; 2 s until 2026-11-27, when two cold cluster calls timed out), an HTTP error or a malformed answer,
  the message stays silent (fail closed) and the adapter logs a warning
  with a failure code (`http_<status>`, `timeout`, `network`, `malformed`).
  The operator asked that the bot answer an unmentioned message only when
  the model confirmed it (2026-11-26). A mention always works. The
  self-hosted clef-flash pilot is documented for weekdays 8:00–20:00
  Berlin time; outside those hours unmentioned follow-ups stay silent
  if it is off.
- **Socket Mode:** the reply handler runs before the Slack acknowledgement,
  as it already did for `/agents/thread` and admission. The 5 s bound adds
  at most 5 s. A redelivered event that was admitted is deduplicated by the
  agent. A redelivered event that stayed silent asks the model again; with
  at most three Slack retries that load is accepted.
- **Configuration:** adapter environment `THREAD_REPLY_DECIDER_URL` (full
  endpoint URL), `THREAD_REPLY_DECIDER_MODEL` (required with the URL) and an
  optional `THREAD_REPLY_DECIDER_CLIENT_ID` (sent as `x-client-id`).
  The URL must be `https`. Compose passes them to the adapter, and the
  egress proxy admits the decider's host (port 443) like the operations
  webhook. No preflight check: a missing model fails adapter startup.
- **Context:** the bot's last answer is not sent. In the evaluation it made the
  decision worse (20/24 with context, 21/24 without), and it would cost
  a Slack read per message.
- **Logging:** decisions log the channel, message ts, probability and
  failure code, never the message text.

### Evaluation (2026-11-26, clef-flash staging)

43 synthetic follow-ups (English and German; requests, corrections, answers,
thanks, reactions, remarks), with the final question wording: 43/43 correct
at the model's choice. The lowest `reply` probability of a real request was
0.593 and the highest of a message that should stay silent 0.365.
Messages that mention a colleague scored 0.6–0.83 for `reply`, hence the
mention rule. Latency was about 170 ms per call from the office network and
1.5 s for a first call from the cluster.

### Every participant (2026-11-27)

The operator asked that lumi not ignore relevant messages from anyone in
its threads. With a decider configured, `/agents/thread` and
`/agents/followup` accept `anyParticipant`: any participant's unmentioned
message is judged by the model, and an accepted one runs as its author
(their `task.start` authorization; the thread's owner moves to them, as
with any follow-up). An @mention from a participant already did this, so
no new access is granted. Without a decider it stays requester-only.
Request controls (`cancel`, `status`, `continue`) work for anyone in the
thread (operator, 2026-11-27): `/agents/thread` authorizes the speaker for
the control (`task.cancel`, `task.steer`, `task.read`) and the adapter runs
it on the current request. The run's action log records the requester as
the actor, not the speaker; a participant's file
without text stays silent. The model is told who wrote the message:
"the person who asked the assistant" (43/43 in the evaluation) or
"someone in the thread" (48/51 on the same cases plus 8 multi-party
ones; the misses were terse follow-ups such as "same for SKU 4711",
which only read as requests from the requester).

Context: the model now also gets the three thread messages before the new
one, labelled as the assistant, the requester or another person, with
mentions as readable names. On 18 multi-party cases it decided 15 correctly
with context and 13 without; the 43 requester cases stayed at 43 with
context. The remaining misses are replies to a colleague's question
("could be, did you change anything yesterday?") and "that link is broken".
A stricter criteria wording was worse on both sets (14/18, 40/43).

## Work

- [x] Decider module with unit tests (`apps/slack/src/reply-decider.ts`)
- [x] Wire it into the adapter's reply handler; `/agents/thread` reports
      `autoReplies` and `delivered`
- [x] Compose environment and egress host
- [x] Documentation: `docs/thread-replies.md`, `.env.example`
- [x] Review: Gemini 4 Neon (2026-11-26). Fixed: decider called with replies
      off or before delivery, `<@U…|label>` mentions, failure codes, https
      only, docs placement. Declined: an in-memory cache of skipped event IDs
      (retry load is bounded) and a preflight check (startup already fails).

## Verification

- Every participant, history and readable mentions, on `71285ac`:
  - T0: pass. Slack package: 169 tests pass. Agent package: no failure
    beyond the 55 of `origin/main` on this machine. T3 `application`: the
    same 69 checks pass and the same `input-context-tripwire` check fails
    as on `origin/main`.
  - The real `reply-decider.ts` against clef-flash, with history as the
    adapter builds it: 10 of 10 (requester and other participants;
    thanks, follow-ups, questions to a colleague, `@here`).
  - Live after deployment `b9d0acae` (2026-11-27), in a thread another
    person started: "Madrid" answered for the other participant
    (p=0.562), the colleague's remarks stayed silent (p=0.085, 0.098). Two
    calls timed out at the 2 s bound after idle gaps (cold connection from
    the cluster), so the timeout is now 5 s. `status` posted through
    Claude's Slack app ("status _Sent using_ <@app>") went to the model
    instead of the control path; controls now ignore the attribution.
    After that fix (`7585b1c`) `status` still went to the model: for a
    short message `canonicalText` repeats the block text on a second line
    ("status _Sent using_ <@app>
    status"), because the dedupe skips keys
    under 20 characters. Controls are now read from the plain event text.
    Review of that fix: the event text arrives HTML-escaped, so a
    `continue` answer kept `&amp;`, `&lt;` and `&gt;`. Controls now read the
    decoded event text, and the flattened content when Slack sends no text.
    Accepted: an app message whose short fallback text is `status` while
    its blocks say more now counts as a control.
  - Since participants count (#11), every untagged remark in a thread
    whose answer was not yet delivered got the private notice "Request
    refused or unavailable". Unmentioned messages other than controls, the
    requester's included, now stay silent when the service refuses them
    (409 with a code); the adapter logs the code. Outages and other
    failures still post the notice. Slack package: 171 tests pass, the new
    one fails before the change.
- Deterministic, Windows 11, Node 26.13.1, Docker Desktop 29.9.3:
  - T0 on `1b33a18`: pass.
  - T1 and T2 on `1b33a18`: the Slack package (163 tests, 19 new) and
    egress pass. No failure beyond those of `origin/main` (`9ebe4d3`) on
    the same machine: 55 in the agent package (publication, Code Mode) and
    31 in T2 (backup and GC scripts, agent hooks), all Windows-specific.
  - T3 `application` on `1b33a18` and on `9ebe4d3`: both stop at the same
    check, `input-context-tripwire-is-explicit-failure-without-delivery`
    (`inputs-corrections`), after the same 69 passing checks. The later
    checks of the suite did not run on either revision.
  - T3 `tools`: not run; the egress change is one host rule, covered by its
    unit test.
  - T4 stub suite on `62b090d` images, decider unset: 8 of 8 passed. With the
    decider set, the stub scenario's follow-up (`STUB_HOLD 5…`, a stub
    directive, not a message) scores 0.46 and would stay silent.
- Live:
  - The adapter pod on the Kubernetes staging cluster reaches clef-flash
    (`POST /v1/systemone` returned 200 in 1.5 s, 2026-11-26).
  - T5: not applicable as is. The driver cannot assert that the bot stayed
    silent, so no gateway scenario covers the decider. Live acceptance is a
    check in the deployment's test channel after rollout: a mention, then
    "thanks!" (silent, `automatic reply skipped` in the adapter log), then
    a follow-up question (answered).
  - Passed on 2026-11-26 after deployment `5bcdb8b` (upstream `6f90d07`):
    a mention was answered, "thanks!" stayed silent (`automatic reply
skipped reason=decider p=0.106`), and the next unmentioned question was
    answered in 7 s (`automatic reply accepted reason=decider p=0.866`).
    Three model requests since the deploy, all 200.

## Rollout

Deploy agent and adapter from the same image. Set the three variables on
the adapter and restart it; in Compose recreate `egress` too. Rollback:
unset `THREAD_REPLY_DECIDER_URL`.

Deployed to the Kubernetes staging deployment, which serves the productive
Slack app, on 2026-11-26: image `4364d0c` with the decider settings
(deployment MR !6, `52d4493`, 22:30 UTC), then `6f90d07` (MR !7, `5bcdb8b`,
22:47 UTC). Database backups were taken before each rollout. Rollback: pin
the earlier image digest or unset the three variables.

## Open items

- [x] Live check in the deployment's test channel after rollout. First
      attempt (2026-11-26, deployment `52d4493`): both unmentioned replies
      stayed silent with `reason=mentions_others`. The test sender posts
      through Claude's Slack app, which appends `*Sent using* <@U…>` to
      every message. Fixed in #9; see Live.
