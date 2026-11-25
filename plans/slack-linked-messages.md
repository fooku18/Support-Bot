# Slack linked messages and thread context

Status: Human review

## Summary

The agent received only the text of the mention. Asked about a linked alert in
another channel, or mentioned below an alert, it could not see the alert. It
can now read a linked message with its thread, and a mention inside a thread
supplies the thread's first message.

## Decisions and approach

- The adapter reads Slack: it already owns the bot token, the membership roster
  and the sharing checks. The agent sends the request identity and a parsed
  link to `/native-messages/linked` or `/native-messages/root`.
- Access limits of a linked read, decided by the operator on 2026-11-25:
  - this workspace only, no externally shared channels;
  - the bot and the requester are both members of the linked channel;
  - a private channel is readable only from within that same channel.
- The limits are checked before and after the read. Unknown status refuses.
  A private channel elsewhere reports nothing but `channel_unavailable`.
- `slack_read_message` follows the Slack tool assignment of the channel. It is
  not offered in Studio, which has no Slack thread.
- The thread root needs no tool: it is the request's own thread. It is supplied
  once per model conversation, as marked untrusted data, and is recorded with
  an action receipt. A failed read is logged and does not end the request.
- Message search stays off: it needs the action token, which is not retained.
- No Slack scope changes: the manifest already has the history and read scopes.

## Work

- [x] Shared contract and adapter reads
- [x] Agent client, tool and thread context
- [x] Tests and documentation
- [x] T3 fixture: GitLab contract v6 (`discovery` failed on `c13118e` without it)

## Verification

- Deterministic, branch `feat/slack-linked-messages` on `c13118e`, macOS arm64,
  Node 26.11.1:
  - T0: pass.
  - T1 and T2: no failure beyond those of `c13118e` on the same machine. Those
    are 4 in T1 (`checkouts`, `transfer-links`, `code-mode` memory limit) and 9
    in T2 (`admin-backup-script`, `docker-gc-script`).
  - T3 `application`: pass, 81 records, with the PostgreSQL volume on tmpfs.
  - T3 `tools`, `coding`, `backup`, `telemetry`: **Blocked**. The Docker VM disk
    was full, so the images could not be built.
- Live: **Blocked**. T4 and T5 need the designated test instance.

## Rollout

Deploy adapter and agent from the same image. An agent whose adapter lacks the
endpoints reports linked messages as unreadable and runs without the thread
root. Invite the bot to each channel it should read.

## Open items

- [ ] T3 image suites on a Docker host with free disk space
- [ ] T5 on the test instance
