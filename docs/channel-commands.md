# Channel commands

Mention Support Agent directly at the start of a message, then use a command:

- `@Support Agent !help`
- `@Support Agent !config`
- `@Support Agent !memory` or `@Support Agent !memory list [page]`
- `@Support Agent !memory remember <literal text>`
- `@Support Agent !memory replace #<id> <literal text>`
- `@Support Agent !memory delete #<id>`

Keywords are case-insensitive. Leading `!` syntax is reserved; an unknown or
invalid command returns usage without running a model. Quoted examples,
mentions of another app, and commands in the middle of ordinary text do not
invoke this surface. Use the [request controls](agent-progress.md) to
cancel or continue agent work.

The native adapter routes these commands directly to the admin command service,
including private configuration interactions and durable receipts. They never
start an answer or coding run. Keep a space after the mention so Slack sends its
mention event. An unmentioned thread reply starting with `!` stays silent;
mention the bot directly to invoke a command or receive usage.

The channel's current **People** list authorizes commands. Membership,
channel enablement and workspace enablement are checked against the admin
store on invocation, opening an editor and saving. The internal service
credential authenticates the controller; it does not replace these checks.

## Configure

`!config` returns a private **Configure channel** button to its requester.
It expires after 15 minutes and cannot be used by someone else. Ephemeral
messages can disappear on reload or fail to arrive; invoke the command again.
Opening the button creates a private editor valid for 60 minutes. Canceling
or opening changes no settings.

The editor writes the same model and system-prompt assignments as the admin
page, plus **Automatic thread replies**: after the
bot is mentioned in a thread it responds to clear follow-ups there without a
new mention; it never responds automatically at channel top level. Off stops
it in every thread of the channel, including joined ones; mentions always
work ([thread-replies.md](thread-replies.md)). The model's **Inherit** option uses the current workspace/deployment
default. For the prompt, enter text to override the workspace prompt; leave
both fields empty to inherit it. Clearing previously saved text restores
inheritance, and whitespace-only text also counts as empty. The two text parts
are joined exactly and normalized once, with a combined 4,000 UTF-16-unit
limit. The model must be in the deployment's current allowlist.

Admin forms, API clients and Slack editors use a fingerprint of the channel's
own overrides. A concurrent channel edit makes an older editor conflict;
reopen it. A workspace-default change does not stale an inherited draft.
API clients read the fingerprint from the channel `/tools` response and
include `fingerprint` with every channel `/model` or `/prompt` PUT. An omitted
fingerprint is refused; single-field writes preserve the other field.

The save commits before the modal success acknowledgement. A timeout can mean
an unknown outcome: check the public receipt, or retry the same form. Exact
retries return the committed result; changing an already saved form requires
reopening. A no-op consumes the form without a public change receipt or a
configuration-version change. Changed settings apply through normal config
refresh and later runs, never by switching an in-flight run.

## Explicit memory

Memory is never learned, summarized, refreshed, expired or changed by a
model. Only an explicit command changes it. Notes are workspace/channel
scoped and have non-reused channel-local IDs. Accepted text is literal,
including spaces and newlines. Exact no-op replacement preserves revision,
content hash and confirmation time. Reads do not confirm a note.

Limits are 50 active notes, 1,000 UTF-16 units per note, 12,000 total raw units
and 24,000 rendered units. Writes exceeding a limit are refused, never
truncated or pruned. Lists show at most ten notes per page in a native Slack table with ID, note
and last-confirmed columns. Note text stays literal and wraps; confirmation
shows a UTC time and the stored People display name (or user ID). Lists label
their revision and page and split long pages into bounded receipt parts.

A real inference run pins an authoritative snapshot at its first claim.
Retries and repairs keep that snapshot. Later newly pinned runs see new
notes; a changed content hash rotates a coding session while preserving its
workspace, branches and merge requests. Notes are reference material below
fixed rules and effective channel instructions. They grant no tool or
publication authority. Direct command messages and command receipts are
excluded from operational conversation history.

If memory cannot be read, the run stays queued and the runner continues
serving other tasks. A durable five-minute outage deadline fails the run
without making a model call. There is no empty or stale fallback. Simulated
runs do not require the memory service.

## Persistence and receipts

Memory, command deduplication, grants, sessions and public receipt intents
live in `admin.sqlite`, outside execution-state purge and thread expiry.
Existing admin SQLite backups include them. Disabling a workspace/channel
retains notes and holds receipts. Re-pairing retains notes but invalidates
old grants/editors. Explicit workspace deletion removes these records.

Memory changes and authorized help/list/error responses are public in the
source thread. Configuration drafts and access denials are private; committed
Slack configuration changes have public receipts. A receipt has a stable
part identity, a persisted delivery lease and reconciliation after ambiguous
posts. Delivery is not exactly-once. Failed/uncertain delivery does not roll
back committed state. Admins can inspect the latest 200 receipt statuses at
`GET /api/channel-command-receipts`. Confirmed receipt bodies are scrubbed
from the queue; compact command outcomes and source identities remain for
purge-safe replay prevention.

Deleting a note removes active memory, not Slack history, earlier answers,
pinned run evidence, prompt audits or backups. This is not secure erasure.
