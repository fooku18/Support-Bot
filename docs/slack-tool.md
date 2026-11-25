# Slack tool

The shared agent can read a linked message and look up users. It uses the
installed bot token of the request's workspace. Directory listing, message
search and posting are outside the tool catalog.

1. Include `channels:history`, `groups:history`, `channels:read`,
   `groups:read`, `users:read` and, for email lookup, `users:read.email` in the
   [Slack app configuration](slack-app-setup.md). Reinstall through
   **Add to Slack** after scope changes.
2. Create a **Slack** instance on the workspace's **Tools** page and assign
   it to the intended channel. The instance uses that workspace's installed
   token and requires no additional credential.
3. Check readiness in the admin UI. If the token is invalid or belongs to a
   different workspace, reinstall it through that workspace's settings.

## Linked messages

`slack_read_message` takes one message link and returns that message with its
thread. The text of bot posts, such as alerts, includes their blocks and
attachments. The adapter reads the message and enforces these limits before
and after the read:

- The channel belongs to this workspace only. Externally shared,
  organization-shared and pending shared channels are refused.
- The bot and the asking user are both members of the linked channel. Invite
  the bot to a channel whose messages it should read. The channel does not
  have to be enabled in the settings service.
- A private channel is readable only from within that same channel. Direct
  and group messages are never readable.

An unknown status counts as a refusal. The model gets the reason and tells the
user what to change. For a private channel elsewhere it learns only that the
channel cannot be read. One read returns at most 50 messages and about 24 kB;
the linked message always comes first in that budget.

## Thread context

A mention inside an existing thread supplies the thread's first message as
untrusted context, so a question below an alert needs no link. This needs no
tool assignment: it reads only the request's own thread, under the request's
own authority. Each model conversation gets it once. If it cannot be read, the
request runs without it. Other thread messages are not supplied.

## User lookup

`slack_get_user` resolves a user ID or mention, and
`slack_lookup_user_by_email` a specific address. They return bounded profile
fields for one user at a time.

Treat messages and profile data as untrusted. A Slack answer is visible to
everyone in the thread, so only assign the tool to channels allowed to see what
it can return. Live verification uses only designated fixture users.
See [testing](testing.md#scenarios-and-suites).
