# Code Mode

Mastra Code Mode lets the shared agent combine authorized read tools in a
single TypeScript computation, `execute_typescript`. It is discoverable when
the coding workspace is available. Mastra generates the tool signatures.

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

Array buffers count against the memory limit. The stack uses V8's default.

## Runtime requirements

`isolated-vm` is a native addon. Its package ships prebuilt binaries per Node
ABI and platform. Node 26 needs isolated-vm 7; `@mastra/isolated-vm` 0.1.4
asks for 6.2, which does not build on Node 26. The root `package.json` pins
7.0.2 with `overrides`. The image keeps only the binary for its Node and
architecture and runs no install script, so no compiler enters an image.

Node must start with `--no-node-snapshot`, or creating an isolate can crash
the process. The `native-answer` and `native-coding` images set
`NODE_OPTIONS=--no-node-snapshot`. So do the agent's T1 tests
(`apps/agent/vitest.config.ts`) and Studio (`scripts/studio.mjs`). The
application refuses to start with a coding store when the flag is missing.

Code Mode checks the current authorization before a script starts. Each read
call then passes the same channel assignments, service schemas and current
authorization as a direct tool call, so a tool revoked during a script is
refused at its next call. The tool runtime owns service credentials; the
script receives neither credentials nor the checkout filesystem. Return the
bounded data needed for the answer.

Use regular workspace tools to edit a repository and run verification. These
commands run in the bubblewrap sandbox of the coding workspace.
Clarification, file export and publication are explicit tools outside the
nested read-tool catalog. See [runtime ownership](native-answer.md#runtime-ownership)
and [development](development.md#agent-boundaries).

T1 `apps/agent/test/runtime/code-mode.test.ts` and T3 `coding` test the
boundary, its limits and that a synchronous loop leaves the event loop free.
