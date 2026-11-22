# Slack inputs and exports

Attach bounded UTF-8 text, CSV, TSV, Markdown, PNG, JPEG or WebP to the
request. Attachments are accepted from the authorized Slack source thread.
The app checks the source, uploader, exact bytes and current channel access
before use. The [runtime guide](native-answer.md#coding-attachments-and-explicit-exports)
describes the supported formats and the coding workspace.

In a coding request, Mastra exposes editable copies in the workspace under
`.slack-inputs/<run>/<file>/<name>`. The original input bytes and provenance
remain pinned. An edit to a workspace copy does not change the input receipt.

A user-requested export is designated with `export_file` and snapshotted
before delivery. The agent can designate up to four files, each at most
2 MiB. The adapter confirms app ownership and the exact thread share before
recording delivery. Unknown delivery outcomes remain visible for inspection
and are not automatically replayed.

## Long answers

Slack shows at most 12,000 characters in the markdown block of one message.
A longer answer is delivered in two parts in the same thread:

1. The full answer as the file `answer.md`.
2. A reply that says the full answer is attached above, followed by a preview
   of about 3,000 characters. The preview ends at a paragraph or line, never
   inside a code block. Publication lines of a coding answer stay visible
   under the preview.

The reply's message metadata (`result_files`) names the file and its SHA-256,
which equals the retained answer's hash. A follow-up in the thread still knows
the whole earlier answer: the agent's thread memory holds the full text, not
the preview.

The upload uses the export checks: a private workspace channel and current
delivery authority before each Slack call, then the exact thread share. If
authority is refused, nothing more is sent. If the upload fails or its outcome
is unknown, the file is not retried. The reply is still posted and says that
the file could not be attached. A follow-up can ask for the rest. Inspection
records the file ID, or `unattached`.

For live qualification, use the designated
[`coding-files.json`](../tests/live/scenarios/coding-files.json) scenario.
It verifies the uploaded inputs, exact published files and downloaded
exports against fixture bytes. See [testing](testing.md#scenarios-and-suites).
