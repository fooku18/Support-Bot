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
  The decision model is only called for messages that would start a run
  today.
- **API:** the Jev REST API (`POST /v1/systemone`), shared by Jev and its
  clones. One `choice` question, `reply` or `silent`. The bot replies when
  the model's choice is `reply`. Only the message text is sent, bounded to
  2,000 characters.
- **Mentions of others:** a message that mentions another user, a user group,
  `@channel`, `@here` or `@everyone` is meant for them. It stays silent
  without calling the model. In the evaluation the model misread such
  messages as requests.
- **Files without text** (a screenshot) start the follow-up without calling the model.
- **Failure:** on a timeout (2 s), an HTTP error or a malformed answer,
  the bot replies (fail open) and logs a warning. Silence would hide real
  follow-ups whenever the model is down. The self-hosted pilot can be off
  outside office hours.
- **Socket Mode:** the reply handler runs before the Slack acknowledgement.
  The 2 s bound keeps it within Slack's 3 s window in the normal case.
  A late acknowledgement is already safe: the agent deduplicates redelivered
  event IDs.
- **Configuration:** adapter environment `THREAD_REPLY_DECIDER_URL` (full
  endpoint URL), `THREAD_REPLY_DECIDER_MODEL` (required with the URL) and an
  optional `THREAD_REPLY_DECIDER_CLIENT_ID` (sent as `x-client-id`).
  Compose passes them to the adapter. The egress proxy admits the
  decider's host like the operations webhook.
- **Context:** the bot's last answer is not sent. In the evaluation it made the
  decision worse (20/24 with context, 21/24 without), and it would cost
  a Slack read per message.
- **Logging:** decisions log the channel, message ts and probability, never
  the message text.

### Evaluation (2026-11-26, clef-flash staging)

43 synthetic follow-ups (English and German; requests, corrections, answers,
thanks, reactions, remarks), with the final question wording: 43/43 correct
at the model's choice. The lowest `reply` probability of a real request was
0.593 and the highest of a message that should stay silent 0.365.
Messages that mention a colleague scored 0.6–0.83 for `reply`, hence the
mention rule. Latency was about 170 ms per call from the office network and
1.5 s for a first call from the cluster.

## Work

- [ ] Decider module with unit tests (`apps/slack/src/reply-decider.ts`)
- [ ] Wire it into the adapter's reply handler
- [ ] Compose environment and egress host
- [ ] Documentation: `docs/thread-replies.md`, `.env.example`

## Verification

- Deterministic: <pending>
- Live: <pending>

## Rollout

Set the three variables on the adapter and restart it. Rollback: unset
`THREAD_REPLY_DECIDER_URL`.

## Open items

- [ ] T5 on the test instance
