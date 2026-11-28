# Slack inputs and long answers

Attach bounded UTF-8 text, CSV, TSV, Markdown, PNG, JPEG or WebP to the
request. Attachments are accepted from the authorized Slack source thread.
The app checks the source, uploader, exact bytes and current channel access
before use. The [runtime guide](native-answer.md#attachments) describes the
supported formats. The original input bytes and provenance remain pinned.

## Long answers

Slack shows at most 12,000 characters in the markdown block of one message.
A longer answer is delivered in two parts in the same thread:

1. The full answer as the file `answer.md`.
2. A reply that says the full answer is attached above, followed by a preview
   of about 3,000 characters. The preview ends at a paragraph or line, never
   inside a code block.

The reply's message metadata (`result_files`) names the file and its SHA-256,
which equals the retained answer's hash. A follow-up in the thread still knows
the whole earlier answer: the agent's thread memory holds the full text, not
the preview.

The upload checks a private workspace channel and current delivery authority
before each Slack call, then the exact thread share. If
authority is refused, nothing more is sent. If the upload fails or its outcome
is unknown, the file is not retried. The reply is still posted and says that
the file could not be attached. A follow-up can ask for the rest. Inspection
records the file ID, or `unattached`.

The stub scenarios [`files.json`](../tests/live/scenarios/stub/files.json)
and [`long-reply.json`](../tests/live/scenarios/stub/long-reply.json) cover
inputs and long answers. See [testing](testing.md#scenarios-and-suites).

## Charts

An answer can show up to two charts as Slack's native
[data visualization block](https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block):
line, bar, area or pie. The model writes each chart as a fenced code block
with the language `chart` holding one JSON object:

````markdown
```chart
{"type":"line","title":"PDP requests per hour (M)","categories":["00","01"],
 "series":[{"name":"Today","values":[3.6,3.8]}],"x_label":"Hour (UTC)","y_label":"Requests (M)"}
```
````

The adapter replaces each fence with the block
at the same place, between the answer's Markdown blocks. The notification
text names the chart instead. The format, the limits and the instruction
paragraph come from one module, `apps/agent/src/domain/delivery/slack-charts.ts`,
generated into the adapter. Slack's limits apply: title 50 characters,
category and series names 20, axis labels 50, 1 to 20 categories, 1 to 12
series with one finite number per category, and a pie has one series of
positive values. A fence that breaks a limit, and every chart after the
second, is replaced with the note "Chart not shown". When Slack rejects the
blocks (`invalid_blocks`, so nothing was posted), the reply is posted once
more with that note in place of the charts.

The chart stays part of the answer text, so thread memory, the answer hash
and the long-answer file keep the fence. Thread context and a later fresh
session read a posted chart, this app's or another's, as `[Chart: <title>]`.
A chart past the preview of a long answer is only in `answer.md`.
