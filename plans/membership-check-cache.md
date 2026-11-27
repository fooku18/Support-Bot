# Membership check cache

Status: In progress

## Summary

The adapter checks the requester's channel membership on every authority check. The agent asks for one before each
model dispatch (`/native-authority/check`), so a run with 12 steps checks membership 12 times or more.
`isChannelMember` pages `conversations.members` 200 IDs at a time with no reuse and gives up after 50 pages.

In a large channel every step therefore costs several Slack calls. Replays of 75 real threads through Studio, which
does the same per-dispatch check, failed 26 runs with Slack's "A rate-limit has been reached". Any channel with more
than 10,000 members always fails, because the roster never fits in 50 pages of 200.

## Decisions and approach

- Reuse a **confirmed** membership for 60 seconds per installation, channel and user, **only for the per-step
  `/native-authority/check`**. Intake, file inputs, linked-message reads and delivery keep checking fresh (the file
  input test `input boundary retains post-download authority: membership` requires it). Absence, unavailable rosters and
  pagination errors are never cached, so the check still fails closed.
- Effect of the cache: a member removed from a channel can keep an already running request alive for up to a minute.
  They cannot start a new one, because they can no longer post in the channel.
- Page with `limit: 1000`, Slack's maximum for `conversations.members`. A 10,000-member channel takes 10 calls instead
  of 50, and the 50-page bound now covers 50,000 members.
- The memo lives in memory in the adapter (`apps/slack/src/native-application.ts`), keyed by team, installation,
  channel and user. Expired entries are swept once it holds 10,000. `isChannelMember` itself stays stateless.
- Still per step: `conversations.info` and up to 10 pages of `conversations.replies` for the root and source check.
- Not done: invalidating on `member_left_channel` events. That needs an event subscription and a reinstall.

## Work

- [x] `isChannelMember` (`apps/slack/src/membership.ts`) pages by 1,000.
- [x] Per-step memo in `apps/slack/src/native-application.ts`, used only by `/native-authority/check`.
- [x] Route tests: three per-step checks page the roster once per minute (fails without the memo); absence is checked
      on every step.
- [x] T0 to T2 on Linux (node 26.13.1 container). T0 passes. T1/T2: 4 failures that also fail on `6f90d07` without
      this change in the same container (`native-startup.test.ts` 3 timeouts, `agent-config.test.ts` skill symlink).
- [ ] T3 suite covering Slack intake.
- [ ] T5 gateway suite on the designated test instance (changes Slack intake authority).

## Verification

T3 and T5 not run yet: T5 needs the designated test instance and a gateway key with budget (BLOCKED).
