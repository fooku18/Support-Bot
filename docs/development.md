# Development

Use Node 26 and npm. Run `npm ci` once at the repository root; the root
`package-lock.json` locks every workspace. Do not install individual applications
with `--prefix` or create application lockfiles. Runtime libraries belong to the
application that imports them. The root owns lint, formatting, TypeScript,
Vitest, bundling and the cross-service harness dependencies.

## Where to work

| Path                | Responsibility                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/agent`        | Shared Mastra agent, application admission, domain policy and service integrations                           |
| `apps/slack`        | Authenticated Slack intake, source authority, file transport and delivery                                    |
| `apps/admin`        | Operator UI, installation policy and credential-owning tool configuration                                    |
| `apps/tool-runtime` | Isolated, scoped service clients and CLI execution                                                           |
| `apps/egress`       | Network allowlists and the per-instance egress proxy                                                         |
| `deploy`            | Dockerfile, Compose variants, deployment helpers, static configuration, systemd units and Slack manifest     |
| `tests/integration` | Cross-service contracts, deployment refusal checks and PostgreSQL qualification drivers                      |
| `tests/live`        | Scenario driver for the test instance; gateway scenarios in `scenarios/`, stub scenarios in `scenarios/stub` |
| `tests/fixtures`    | Synthetic service files, native input images and the fixture repository                                      |
| `scripts`           | Root development and operator commands                                                                       |

Application unit tests stay in each application's `test` directory and use
Vitest. Tool-runtime's
shared domain tests belong to agent, whose integrations it bundles. The root
Vitest configuration selects cross-service release gates explicitly. Historical
probes remain source evidence and are not included as passing release gates.

## Agent boundaries

`apps/agent/src/mastra/index.ts` is the Studio entrypoint. The `agents` directory
contains the shared coding agent, its configuration and examples;
`tools` and `runtime` use the same native Mastra primitives in deployment and
Studio. Domain policy, external integrations, infrastructure and wire contracts
remain separate from framework configuration.

Coding tools run commands in Mastra's bubblewrap `LocalSandbox`
(`tools/coding.ts`). Code Mode runs scripts in Mastra's in-process isolated-vm
transport (`tools/code-mode.ts`); it needs no sandbox or temporary files. Node
must run with `NODE_OPTIONS=--no-node-snapshot`; the agent's tests set it
themselves. See [Code Mode](code-mode.md).

The application boundary has three focused collaborators:

- `application/agent-authority.ts` checks current owner, policy, tool binding and
  original input provenance. It builds the trusted execution definition used to
  refuse changed-policy resume and delivery.
- `infrastructure/storage/agent-storage.ts` provisions application receipt tables,
  reserves advisory-lock capacity and stores immutable admission/provenance and
  effect receipts. Framework execution state remains in Mastra's PostgreSQL store.
- `application/agent-delivery.ts` owns notices, recipient checks, export receipts
  and one-shot delivery. It records uncertainty before sending and rechecks
  authority after acknowledgement.

`application/agent-service.ts` keeps the admission transaction and owns the native
execution handle. The same PostgreSQL connection holds the task advisory lock
from admission through segment completion. Moving these boundaries must preserve
that lifetime, duplicate-event atomicity and the refusal to replay an uncertain
start, resume, publication or send. Service contracts are in `agent-options.ts`;
consumers import provisioning from the storage module directly.

## Commands

```sh
npm run typecheck:all
npm run lint
npm run format:check
SUPPORT_AGENT_TEST_RETAIN_EVIDENCE=1 npm run test:packages
SUPPORT_AGENT_TEST_RETAIN_EVIDENCE=1 npm test
npm run test:native:integration
npm run test:native:integration -- --suite application
npm run build
npm test --workspace @support-agent/agent -- test/runtime/provider-search.test.ts
```

The application suite adds current-source admission/lock, cancellation,
revocation, uncertain delivery, shutdown and file-provenance scenarios to the
real-PostgreSQL discovery and cold-process checks. It uses synthetic peers,
creates a fresh bounded PG fixture and retains logs, reports and a logical dump.
It makes no Slack, Gateway or tool-provider calls. The `coding`, `backup` and
`telemetry` suites also need a local `native-coding` image (`--image-tag`). See
[testing.md](testing.md) for all suites, live qualification and evidence rules.

Generate canonical transport mirrors with `npm run generate:protocol`; edit
`apps/agent/src/contracts` and the canonical domain definitions rather than the
generated admin/Slack files.

Build one affected image at a time, checking available disk space first:

```sh
docker build -f deploy/Dockerfile --target native-answer -t support-agent/native-answer:<tag> .
```

Other targets are `native-coding`, `adapter`, `cli-runtime`, `admin` and
`egress`. Each image installs only its selected workspace from the same
root lock. Runtime bundles keep their workspace dependency tree, for example
`/app/apps/agent/dist/native/main.mjs`. Separate images, privileges, credentials
and private networks remain separate security boundaries.

## Private configuration and evidence

Keep instance configuration outside the checkout. A designated test directory
contains `.env.testing` and `.env.e2e` (see the
[live test setup](live-test-setup.md)). Their values remain operator-owned. Always select the instance explicitly:

```sh
npm run env:parity -- --instance-dir /absolute/test-instance
npm run test:stack:ps -- --instance-dir /absolute/test-instance
npm run test:native:live -- --instance-dir /absolute/test-instance --scenario tests/live/scenarios/answer-continuity.json
npm run studio -- start --instance-dir /absolute/test-instance --state-dir /absolute/retained-studio-state
```

Studio starts no Slack receiver and retains its own database and workspaces.
When source or dependency paths change, use a fresh explicitly named Studio
state directory; preserve the earlier stopped containers and state for evidence.
Never restart a historical container whose bind mounts refer to removed source
paths. Use the current driver and images instead. See [mastra-studio.md](mastra-studio.md).

Production preflight always takes `--env-file /absolute/production-instance/.env`.
Systemd backup and GC units must use `deploy/docker/`; installed unit changes
require `systemctl daemon-reload`, without starting a job. Before relocating a
production env file, update its installed backup service's `SUPPORT_AGENT_ENV_FILE`
reference. Moving source must not silently break scheduled backups.

Tests retain new evidence under ignored `artifacts` directories. Existing
historical evidence may be archived outside the checkout with a checksummed
path inventory; its original commands and outcomes remain unchanged. Follow
[AGENTS.md](../AGENTS.md) and [live-test-rules.md](live-test-rules.md) for retention, production isolation and release gates.

## Agent configuration parity

`AGENTS.md` is the shared project instruction entrypoint. Claude Code must support
its `AGENTS.md` fallback; do not add a competing `CLAUDE.md`. Project skills live
in `.agents/skills/`, with relative directory symlinks in `.claude/skills/`.
Both clients invoke the shared deployment guard from their respective hook
configurations. Work plans live in `plans/` and are reviewed with the code.

Run the configuration and hook behavior checks with:

```sh
SUPPORT_AGENT_TEST_RETAIN_EVIDENCE=1 npx --no-install vitest run tests/integration/agent-config.test.ts tests/integration/native-deployment.test.ts
```

These checks validate repository configuration, not a developer's local trust.
Codex enables hooks in `.codex/config.toml`, but each checkout's exact hook
definitions must also be trusted locally. In a fresh session, use `/hooks` to
review and enable them. Changed definitions require renewed trust; do not commit
user trust records. Claude also requires a trusted checkout and no hook-disable
override. After changing local trust, verify in a fresh client session; an
already-running client may retain its earlier configuration.
