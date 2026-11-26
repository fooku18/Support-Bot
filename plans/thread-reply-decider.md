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
- **Mentions of others:** a message that mentions another user, a user group,
  `@channel`, `@here` or `@everyone` is meant for them. It stays silent
  without calling the model. In the evaluation the model misread such
  messages as requests.
- **Files without text** (a screenshot) start the follow-up without calling
  the model. An empty message without files stays silent.
- **Request controls** (`continue <answer>`, `cancel`, `status`) skip the
  model.
- **Failure:** on a timeout (2 s), an HTTP error or a malformed answer,
  the message stays silent (fail closed) and the adapter logs a warning
  with a failure code (`http_<status>`, `timeout`, `network`, `malformed`).
  The operator asked that the bot answer an unmentioned message only when
  the model confirmed it (2026-11-26). A mention always works. The
  self-hosted clef-flash pilot is documented for weekdays 8:00–20:00
  Berlin time; outside those hours unmentioned follow-ups stay silent
  if it is off.
- **Socket Mode:** the reply handler runs before the Slack acknowledgement,
  as it already did for `/agents/thread` and admission. The 2 s bound adds
  at most 2 s. A redelivered event that was admitted is deduplicated by the
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

- Deterministic: <pending>
- Live: <pending>

## Rollout

Deploy agent and adapter from the same image. Set the three variables on
the adapter and restart it; in Compose recreate `egress` too. Rollback:
unset `THREAD_REPLY_DECIDER_URL`.

## Open items

- [ ] T5 on the test instance
