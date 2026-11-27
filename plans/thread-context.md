# Thread context

Status: In progress

## Summary

A mention inside an existing thread supplies only the thread's first message
(`readThreadRoot`, `apps/slack/src/message-reads.ts`). What people wrote below
it is missing: what the team already tried, a pasted error, who owns the
problem. In feedback, support and incident channels that is most of the
context. The request also misses what others wrote between two requests to
the bot in the same thread.

Result: every request in a thread gets the thread messages its model
conversation has not seen, bounded and marked as untrusted data. No new tool,
scope or setting.

## Decisions and approach

- **What is supplied.** A new model conversation (the first request in a
  thread, or the first after a model change) gets the thread before the
  request message: the first message and the most recent ones fill the
  budget, kept in thread order. A later request in the same conversation gets
  only the messages posted since the newest earlier request of that
  conversation, without the bot's own posts, which the conversation already
  holds. A thread the request itself starts gets nothing.
- **Seen point.** The newest `messageTs` of an earlier request with a
  `thread-seen:<epoch>` action receipt. A run records it after a segment that
  is not uncertain, when its read succeeded or it started the thread. A failed
  read records nothing, so the next request reads the same range again. It
  replaces the `thread-root:<epoch>` receipt; a conversation from before this
  change gets its thread once more.
- **Bounds.** The read limits of `slack_read_message`: 50 messages, about
  24 kB, 8 kB per message. The scan covers up to 20 pages of 100 so the
  newest messages are reached; a longer thread is reported `truncated`.
  `oldest` and `latest` keep the scan between the seen point and the request.
  Messages repeated across pages are kept once; posts without text are not
  counted as omitted.
- **Accepted:** messages the bounds leave out of a new conversation are not
  offered later. After a failed read the next request reads that range again,
  which can repeat a message the conversation holds. Conversations from before
  this change get their thread once more.
- **The bot's own posts** in a new conversation are flattened as its answers
  (`flattenOwnAnswer`: blocks, no footer) and marked `own`, so the
  conversation sees what it said before.
- **Authority.** Unchanged: the request's own thread under the request's
  authority, checked before the read and again before the model call. An
  unavailable read is logged and the request runs without context.
- `/native-messages/root` and `NativeMessageClient.root` are replaced by
  `/native-messages/thread` and `thread()`. Greenfield: no compatibility path.

## Work

- [x] Contract `SlackThreadContext`, adapter read and endpoint
- [x] Agent client, seen point from storage, prompt section
- [x] Unit tests (adapter and agent), T3 scenario in `durable-answer-vertical.ts`
- [x] Documentation: `docs/slack-tool.md`

## Verification

- Deterministic, Windows 11, Node 26.13.1, Docker Desktop, on `03ec828` plus
  this change:
  - T0: `typecheck:all`, `lint`, `format:check` pass.
  - T1: Slack package 176 tests pass (thread context: new conversation, since
    the seen point, bounds, a long paged thread with a repeated parent and an
    empty post, a thread the request starts, a bad seen point, refusals).
    Agent package: the same 55 Windows failures as `main` (publication, Code
    Mode, one inspection subprocess test), 607 pass.
  - T3 `application`: `thread-context-is-supplied-once-per-model-conversation`
    passes (reads `[null, <first request>, null, <own root>, null, null]`). The
    suite then stops at `input-context-tripwire-is-explicit-failure-without-delivery`
    after the same 69 passing checks as `main` (stale fixture, see
    [context-budget](context-budget.md)); the later phases do not configure the
    Slack reader.
- Live: T5 BLOCKED. The designated test instance is in use for the replay eval
  and its gateway budget is exhausted. Live check after rollout: a thread with
  a root, a reply carrying a fact, then a mention asking about that fact.

## Rollout

Adapter and agent ship in one image; both change together. No migration, no
configuration.

## Open items

- [ ] Measure the gain with the replay eval (root only against root plus
      thread).
