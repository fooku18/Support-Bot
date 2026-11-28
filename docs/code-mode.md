# Code Mode

Mastra Code Mode lets the shared agent combine authorized read tools in a
single TypeScript computation, `execute_typescript`. The channel's
**Code Mode** assignment enables it; it also needs at least one available read
tool. Mastra generates the tool signatures.

The script runs in Mastra's isolated-vm transport (`@mastra/isolated-vm`): a
V8 isolate inside the agent process. Each run gets a fresh isolate. The
script has no filesystem, network, process, timer or module access. Its only
capabilities are the `external_*` functions of the read tools. Calls cross
the boundary as JSON; the allow-list and input validation run on the host.
esbuild strips the TypeScript on the host. No runner file and no sandbox
process are created.

The isolate runs the script on its own thread. A synchronous loop does not
hold the agent's event loop: other runs continue and Mastra keeps renewing
their leases. At the time limit a host timer disposes of the isolate.

Limits per run, in
[`code-mode.ts`](../apps/agent/src/mastra/tools/code-mode.ts):

| Limit  | Value  | When exceeded                                                                                              |
| ------ | ------ | ---------------------------------------------------------------------------------------------------------- |
| Time   | 15 s   | `TimeoutError`; also stops a synchronous loop                                                              |
| Memory | 64 MiB | `RangeError: Array buffer allocation failed`, or the isolate is disposed: "disposed … due to memory limit" |
| Stack  | V8     | `RangeError: Maximum call stack size exceeded`, e.g. on recursion                                          |

A script may make at most 50 read calls; further calls are refused. A result
with logs above 48 000 bytes is refused as `OutputLimitError`.

Each `external_*` call resolves to `{ ok: true, data }` with the parsed JSON
of a successful read, or to `{ ok, output }` with the text of a non-JSON
response or of a failed read. GitLab adds `warnings` when `data` is partial:
a full page or a truncated collection. A read that is refused (authorization,
input validation) or cannot run rejects instead. The model-facing copy of the
reply stays out of the script, and the tool description states this shape.

Array buffers count against the memory limit. The stack uses V8's default.

## Runtime requirements

`isolated-vm` is a native addon. Its package ships prebuilt binaries per Node
ABI and platform. Node 26 needs isolated-vm 7; `@mastra/isolated-vm` 0.1.4
asks for 6.2, which does not build on Node 26. The root `package.json` pins
7.0.2 with `overrides`. The image keeps only the binary for its Node and
architecture and runs no install script, so no compiler enters an image.

Node must start with `--no-node-snapshot`, or creating an isolate can crash
the process. The `native-answer` and `runtime` images set
`NODE_OPTIONS=--no-node-snapshot`. So do the agent's T1 tests
(`apps/agent/vitest.config.ts`) and Studio (`scripts/studio.mjs`). The
application refuses to start when the flag is missing.

Code Mode checks the current authorization before a script starts. Each read
call then passes the same channel assignments, service schemas and current
authorization as a direct tool call, so a tool revoked during a script is
refused at its next call. The tool runtime owns service credentials; the
script receives neither credentials nor a filesystem. Return the bounded data
needed for the answer.

Clarification (`ask_user`) stays an explicit tool outside the nested read-tool
catalog. See [runtime ownership](native-answer.md#runtime-ownership) and
[development](development.md#agent-boundaries).

T1 `apps/agent/test/runtime/code-mode.test.ts` tests the boundary, its limits
and that a synchronous loop leaves the event loop free. T3 `backup` runs a
script with the image's own install.
