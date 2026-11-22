# Model stub workspace

A scripted Messages API for the stub model mode
(`npm run test:stack:up -- --model-mode stub`). It replaces the AI Gateway on
a test instance, so the whole stack runs without Gateway access.
Replies are deterministic and cost nothing. Stub results never count as live
acceptance of model, coding or publication behavior.

- `src/directives.ts`: the reply for one request, from directives in the
  latest user message. Pure, no state.
- `src/server.ts`: `POST /v1/messages` (SSE or JSON),
  `POST /v1/messages/count_tokens` and `GET /healthz`. It accepts only the
  fixed synthetic key defined by `STUB_KEY` in `src/directives.ts`.
- `src/index.ts`: entry point on `MODEL_STUB_PORT` (default 9877).

| Directive                | Reply                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| `STUB_REPLY <text>`      | Text `<text>`                                                              |
| `STUB_RECALL <pattern>`  | `STUB_RECALL <match>; …` over the rest of the request, or `STUB_NONE`      |
| `STUB_ASK <question>`    | An `ask_user` call; after the answer, `STUB_ASK_RESULT <answer text>`      |
| `STUB_HOLD <seconds>`    | Waits (at most 120 seconds), then `STUB_HELD <seconds>`                    |
| `STUB_LONG <characters>` | Exactly that many characters (100 to 20000), ending in `STUB_LONG_END <n>` |
| `STUB_MODEL`             | `STUB_MODEL <model ID>` of the request (shows the channel's model)         |
| `STUB_SYSTEM <pattern>`  | `STUB_SYSTEM <matches>` in the system prompt, or `STUB_NONE`               |
| none                     | `STUB_OK <request digest>`                                                 |

Each directive is one line; a message may combine several, for example
`STUB_ASK` with `STUB_RECALL` to recall a fact from an earlier turn.
`<pattern>` is a JavaScript regular expression. The rest of the request is
every message except the directive text itself: earlier turns, attachments,
tool calls and tool results. `STUB_RECALL` never searches the system prompt;
`STUB_SYSTEM` searches only the system prompt (shows the channel's prompt).

`STUB_ASK` needs `ask_user` in the request's `tools`; without it the stub
answers `STUB_ASK_ERROR`, never a guessed call. The stub calls no other tool:
tool paths are tested in the T3 `tools` suite. The stub logs request counts, model IDs and
directive names only.
