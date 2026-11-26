# Mastra application

The default deployment in `deploy/compose.yaml` runs the shared Mastra agent,
the native Slack adapter, PostgreSQL and the credential-owning CLI runtime.
Slack and Studio share one agent for answers, on-demand read-tool discovery and
coding.

## Runtime ownership

The agent package is `apps/agent`. Its source has explicit owners:

- `mastra/agents/coding.ts` defines the agent, with shared configuration for model,
  memory and bounded defaults. Mastra owns execution.
- `mastra/tools/` binds framework tools to current application authority.
- `application/` composes trusted configuration, service bindings, agent service,
  HTTP endpoints and Studio. `bootstrap/` contains executable entrypoints.
- `integrations/` owns GitLab, Slack, Atlassian, Datadog, Cloudflare, model providers
  and credential-service adapters. `infrastructure/` owns storage and process helpers.
- `domain/authorization`, `domain/publication`, `domain/files` and
  `domain/delivery` own current policy, verified publication and exact file receipts.
- `contracts/` owns canonical wire vocabulary. The generator produces standalone
  admin/Slack clients so those process images retain their own dependencies.

The Slack receiver runs in `apps/slack`. The credential-owning CLI runtime
runs in `apps/tool-runtime`. Studio and Slack use the same agent definition.

Native diagnostics use Mastra's `ConsoleLogger` with bounded segment IDs,
durations and token counts. Studio persists bounded traces, metrics and logs. Slack persists these signals
when the [shared telemetry store](#shared-telemetry) is enabled. Exporters
omit prompts, answers, tool payloads and arbitrary metadata. Application publication and
delivery receipts remain authoritative.

Inert inspection uses framework storage and exported durable step constants.
One small version-specific suspension decoder remains in `mastra/runtime/inspection.ts`:
the pinned public observation API does not recover a cold question when its
replay cache is empty. Keep the cold-inspection regression when upgrading Mastra.

Mastra's pinned Agent/createDurableAgent, Memory/PostgresStore, top-level
`ask_user`, native resume/abort, processors and workflow inspection own execution.
Automatic durable/workflow recovery stays off. The six `native_agents` tables
retain identity, admission/input provenance and external-effect receipts; there
is no second transcript or execution snapshot journal. Answer attachments use
`nativeInputHandler` and `createNativeInputClient`, then native inline messages.
No file sandbox or FileUploadProcessor is created.

The application resolves the selected key in the deployment catalog and
binds the route, model, connection and hosted-search capability to the
admitted segment. All model SDKs share a guarded in-process HTTP transport.
It checks the exact inference endpoint, request and attachments, current
authority and cancellation at dispatch. The credential files are mounted
in the execution process only. The ledger reports attempts and available
token usage to admin, with billed USD marked unavailable.

Startup uses validated admin synchronization/ETag transport directly,
refusing unavailable, regressing or conflicting config. The existing authenticated
channel-memory proxy/client runs on loopback, with admin as the source. No seed
policy, default authorization, credentials in framework context, or config table
copy is introduced.

Read tools reuse Mastra `createTool`, typed catalogs, validators, and the
credential-owning CLI runtime clients. GitLab reads, Atlassian reads, Datadog
reads, Cloudflare reads and Slack user lookups remain bound to current channel
policy and the assigned instance. Code Mode, workspace commands, exports and
verified publication are available for requests that need them.

Provider web search is available in Slack and Studio when the
channel has a ready assigned `webSearch` instance and the actor has `tool.use`
authority. The selected model must enable hosted search. OpenAI Responses uses
`web_search` with a one-call limit per request. Anthropic Messages and
Vertex Claude use `web_search_20250305` with `maxUses: 1`.
Hosted search executes inside a model request, so current search authority
is rechecked at the final dispatch boundary rather than an application tool hook.
Revocation or replacement fences subsequent dispatches and delivery.

Actual provider-executed call/result pairs produce counts-only receipts in the
existing native action records. Queries and result bodies are not copied there.
The live `tests/live/scenarios/web-search.json` scenario requires a new confirmed
search for each question, service-dependent facts and source URLs. It runs discovery
through the shared agent without cloning, commands, edits, exports or
publication. Search results do not prove direct page retrieval.

Direct page fetching uses the Mastra `web_fetch` read tool through the existing
isolated web runtime. Configure `NATIVE_WEB_RUNTIME_URL`, `WEB_RUNTIME_TOKEN`
and `NATIVE_WEB_NETWORK` together; `native-deployment.mjs` selects
`deploy/compose.web-fetch.yaml`. The extra network is the private web API network,
not the public web egress network. The agent sends only the assigned instance,
workspace, target URL and 48,000-byte output bound; it never downloads the page
itself or passes service authentication to the public target. The isolated
runtime/proxy enforces public destinations and redirect restrictions. Current
assignment/actor checks surround each read; the transport honors cancellation
and refuses redirects of its authenticated internal request. Without transport
configuration or a ready assignment the tool is absent.

The pinned Mastra built-in fetch tool cannot use this transport: it owns raw
Node HTTP requests and DNS lookup with no proxy injection. The retained exception
is the existing typed fetch transport, not a second agent loop. Native fetch
receipts retain hashed call/URL/content identities and byte counts, never page
bodies. `tests/live/scenarios/web-fetch.json` requires fresh direct reads of the
fixture URL on both questions and refuses search substitution or publication.
Studio uses the same binding and optional private network.

The shared agent uses Mastra's `ToolSearchProcessor`. Only the bound read tools
enter its catalog, along with Code Mode when it is assigned or the coding workspace is available.
Code Mode's generated signatures load with its tool. Clarification, provider
search and workspace tools stay directly available when configured. Native keyword search auto-loads at most three matches for the next
model turn. Full service schemas are withheld initially; there is no injected
catalog or separate load turn. Loaded tools derive from framework conversation
context (`storage: 'context'`), survive restart while the discovery result is
retained, and disappear when that context is trimmed. The model can search again.
Search adds one inference before a first read; a retained loaded tool can be
called directly on a follow-up. This does not qualify live model selection or
latency.

The discovery filter checks current policy before exposing tools. Provider
dispatch and service execution also check their own authority. A tool
unassigned or replaced while a run executes is refused at its next call; the
run continues. See [Settings and authorization changes](#settings-and-authorization-changes)
for what a change does to a running request. See the
[development guide](development.md) for workspace and dependency ownership.

## Storage and prerequisites

Provision a **fresh dedicated** native PostgreSQL cluster/database using the
maintenance identity and `native-provision` entrypoint. It refuses an existing
`native_answer` database/role or framework/app schema. Preserve retained databases and require a fresh destination for provisioning. The framework DDL runs only in
maintenance. Runtime uses `disableInit`, a non-owner `native_answer` role, no
schema/database creation rights, framework DML and narrow application grants.
The runtime can insert publication receipts and update their outcome and evidence.
The schema seal records the application store version. Runtime also holds one
database advisory lock for the selected native execution authority, so a second
runtime on the same database is refused. Current Slack source/root authority is
checked on every request.

The Compose file runs the agent, adapter, CLI runtime, PostgreSQL, the settings
service and the egress proxy. It requires explicit secret paths, image tag,
trusted models, the settings service configuration and three private subnets.
Compose creates internal frontend, tools and database networks. The egress
proxy connects the frontend and tools networks to its outbound bridge.
Admin also joins a non-internal ingress bridge for the settings UI, the
only port published by the base stack, on host loopback. The agent uses the
tools-network proxy for outbound provider requests. The maintenance socket is not mounted
into runtime. No credential is created implicitly by application startup.
See the [live test setup](live-test-setup.md) for every value.

For activation, ensure exactly one Socket Mode receiver owns the Slack app. Follow the
[deployment runbook](production-recovery.md) for stop, drain and recovery.

## Slack and operations

The installation registry validates admin installations and Slack
`auth.test`; the existing receiver enforces installation and membership before
mention intake. Native authority also checks channel sharing, current requester
membership, root/source accessibility and source author. Input source/hash checks
remain unchanged. The sender uses the installation's actual bounded Slack client
and exact answer text with delivery metadata.

Mention the bot to start a conversation. An hourglass reaction marks an admitted
request while Mastra runs; it is removed after result/question presentation or
failure. Slack reactions are best-effort UI, not proof of successful execution.
After a confirmed answer, the same requester can send ordinary replies in that
thread without mentioning the bot while **Automatic thread replies** is enabled.
Admission checks the channel's current setting; turning it off silences later
ordinary replies in existing threads. Explicit mentions and `continue`, `cancel`
and `status` remain available. An already admitted run is not canceled by this
preference. Replies use the same Mastra memory. Other
threads, other authors and arbitrary bots do not trigger a follow-up; the exact
configured test sender remains supported. Explicit mentions can start a new
request under normal policy.

Direct `@bot !config`, `!help` and `!memory` channel commands use the retained
admin command service before agent admission. Configuration buttons and modals
remain private; committed changes and usage use the durable command receipt
worker. Commands make no inference or coding run. See
[channel-commands.md](channel-commands.md) for authorization, expiry, conflict and
retry semantics. Unmentioned thread replies starting with `!` stay silent.

In an existing conversation, `continue <answer>`, `cancel` and `status` work with
or without a mention. A suspended question requires `continue <answer>`; ordinary
text cannot silently abandon it. Continuation obtains the current `ask_user`
suspension from framework inspection, including after restart, and resumes only
once. Controls with files or an empty answer refuse without consuming the resume.
Busy or uncertain requests require an explicit control or a new mention.

The adapter calls result/inspection and one-shot presentation for each admitted
request. It runs no redispatch/recovery poller. Confirmed answers use the existing
delivery receipt. Question/failure/cancel notices use admission and acknowledgement
receipts in `actions`, with a deterministic external operation ID. A missing ACK
remains unknown and is never automatically replayed. An unavailable presentation
requires an explicit authorized inspection/status action; no recovery queue is
invented. Private endpoints and all source/recipient boundaries are authenticated.

### Settings and authorization changes

Settings changes apply to new requests. A running request finishes under the
settings it was accepted with. Authorization changes apply immediately.

- **Settings** are the channel's model, prompt, channel memory instructions and
  tool assignment, plus the deployment's limits and versions. Admission stores
  their hash as the run's execution policy. Execution records the model key it
  runs with (`model:<key>` in `actions`); the answer footer names that model,
  not the channel's current one.
- **Before execution starts**, a changed hash refuses the run. The admitted
  request still returns its handle, presentation posts the failure notice, and
  the agent logs `native run refused run_id=… reason=execution_policy_changed_start_fresh`.
  The user retries and gets the new settings.
- **During and after execution**, a change does not stop the run. Its answer,
  export files, long-answer file (`answer.md`) and publication results are
  delivered under the accepted settings. The agent logs
  `native delivery policy_changed_delivered run_id=…` once. A tool unassigned
  or replaced during the run is refused at its next call, because its
  credentials are revoked; the run continues without it. Provider web search
  runs inside the model request, so unassigning or revoking it refuses the
  run's next model call, and the run ends with the failure notice.
- **Questions**: a `continue` runs only under the accepted settings and is
  refused after a change. Presentation therefore posts the failure notice
  instead of a question the user could not answer
  (`native failure notice run_id=…; question withdrawn reason=execution_policy_changed_start_fresh`).
- **Authorization** is the installation whitelist, the channel being enabled,
  the sender not being blocked, the authorization policy, the thread's current
  owner, Slack membership and source authority, cancellation and the thread's
  input receipts. Every execution step, notice and delivery checks it again.
  A run refused during execution posts nothing to the revoked recipient and
  retains nothing; the agent logs `native run refused run_id=… reason=<code>`.
  An answer whose recipient is refused at delivery time is **withheld** for
  good: the delivery outcome becomes `withheld`, nothing is sent, and the
  agent logs `native delivery withheld run_id=… reason=<code>`. A withheld
  answer no longer counts as undelivered, so the instance becomes idle, and a
  later grant does not revive it. The Slack adapter's membership, source and
  input checks answer over HTTP and cannot tell a refusal from an outage: such
  a failure leaves the answer retained for a later presentation and is logged
  as `native delivery refused run_id=… reason=<error class>`.

The candidate admits at most eight concurrent task segments. Admission reserves
a slot before acquiring a task lease or changing request ownership. The pool
includes a singleton-lease connection and two additional connections for storage
and authority queries. Excess requests are refused without an admission receipt
and can be explicitly retried after capacity becomes available; there is no queue.

`GET /healthz`, `/readyz` and `/native/status` identify `runtime=native-answer`.
Readiness checks actual restricted storage, validated current admin config,
channel memory and authenticated adapter authority. Native
status includes admitted work, active runs, framework suspension waits, unconfirmed
execution, retained/uncertain answers and unacknowledged notices. These receipts
are not execution snapshots. The deploy-drain survey detects this runtime and
uses native status; it cannot infer idle from old task tables. Suspended questions
are reported separately under the retained `never` policy.

Shutdown disconnects intake, joins admitted native execution/presentation and
HTTP delivery, then closes memory, provider ledger and storage dependencies. The
adapter keeps its authenticated byte/delivery listener and installations alive
while admitted work drains. The candidate grants a 180-second container stop
window; live shutdown latency remains unqualified.

## Bounded qualification

Use the [test guide](testing.md) for the release checks. The native
integration suites use real PostgreSQL and synthetic service peers:

```sh
npm run test:native:integration
npm run test:native:integration -- --suite application
npm run test:native:integration -- --suite coding --image-tag <tag>
npm run test:native:integration -- --suite backup --image-tag <tag>
npm run test:native:integration -- --suite telemetry --image-tag <tag>
```

The default and `application` suites run the agent from source in one Node
process per phase. `coding` and `backup` run the provision, application and
adapter entrypoints, bundled from the current source, inside the
`native-coding` image with the tag you give. `telemetry` runs the telemetry
maintenance entrypoint in that image.

Qualify the designated Slack test instance and direct model connection separately. Record the tested
revision and the evidence in the corresponding work plan.

## Quiesced logical backup and fresh restore

Use the same application/framework locks and PostgreSQL 17, a quiesced source,
and a fresh isolated destination. For coding, also retain the
[Workspace archive](#coding-database-and-workspace-backup). Stop and
fence intake, execution **and delivery** writers before the snapshot; wait for
joined shutdown and verify no runtime database sessions remain. Keep the source
fenced throughout inspection and any explicit destination continuation. There
must be one active owner across both stores: the database advisory lock cannot
fence a different cluster. No post-snapshot external effects may be omitted from
the archive. An arbitrary stale backup is not safe to replay external writes.

Back up the whole dedicated `native_answer` database. Mastra owns `framework`,
including messages, threads, durable snapshots and memory/run ownership fences.
Keep all six `native_agents` tables: `tasks`, `requests` (including input
provenance), `actions`, `deliveries`, `exports`, and `publications` (the last two
are empty in ANSWER).
Preserve schema comments, ownership, constraints and table/column/database ACLs.
Do not select individual framework tables or reconstruct framework state.

Use standard [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) and
[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html), with private
maintenance service/password files outside the evidence/archive directory:

```sh
umask 077
PGSERVICE=native-source-maintenance pg_dump --dbname=native_answer \
  --format=custom --file="$archive"
sha256sum "$archive"
pg_restore --list "$archive" > "$archive.toc"
# Destination: fresh dedicated cluster, native_answer database absent.
# Prepare only the native_answer non-owner LOGIN separately, with a fresh secret:
# NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION, no role memberships.
PGSERVICE=native-restore-maintenance pg_restore --dbname=postgres \
  --create --exit-on-error --verbose "$archive" 2> "$restore_report"
```

The archive contains no cluster roles/passwords; do not add `pg_dumpall` globals,
env files or secret mounts. Keep it private: conversation/input bytes are data.
Use maintenance owner `postgres`; keep the restored runtime login `native_answer`
non-owner. Do not use `--clean`, `--no-acl`, or `--no-owner`. A failed target is
retained for inspection, never overwritten or implicitly reset. Initial source
setup uses `native-provision`; do **not** run its schema creation over the restore.

Retain the archive hash, exact source/image/lock identity, schema seal,
full logical row hashes/counts and ACL/ownership inventory. Compare source before
and after dumping, then destination before runtime; every framework/application
row and grant must match. Keep **current** admin policy outside this restore;
never replace it with a backup-era copy. A schema seal mismatch requires
operator resolution, not changing the seal to make startup pass. Existing
readiness checks restricted grants, framework access and current admin/adapter
dependencies.

Begin with authenticated status/inspection only. Startup and inspection must
produce no inference, recovery or send. Keep automatic workflow/durable recovery
disabled. Inspect the retained answer, `ask_user` suspension and delivery/notice
receipts; preserve uncertain outcomes without retry. Only a new explicit action
by the currently authorized original owner may resume the exact saved question
once. Current revocation and source authority still apply.
This does not reconcile effects absent from a stale archive or authorize cutover.

`npm run test:native:integration -- --suite backup --image-tag <tag>` follows
this recipe with synthetic services. It compares rows and catalog before and
after the dump and after the restore, refuses credentials in the archive, and
checks cold inspection, current revocation and one explicit continuation.
Check release-specific restore evidence before authorizing a cutover.

## Native deployment with a coding workspace

The base stack uses the `native-coding` image and the retained
`native-coding-data` volume. For initial setup, provision a fresh Compose
project and database. The application checks the `coding-application@2` store
seal and retains existing coding stores.

Mastra Agent, DurableAgent, Workspace and LocalSandbox own coding. The workspace
and publication tools require a ready GitLab binding. Plain answers and other
assigned read tools remain available when that binding is unavailable.
Nested Code Mode exposes read-only tools; clarification and publication remain
explicit top-level tools. Code Mode runs in an in-process V8 isolate
(isolated-vm), not in the Workspace sandbox (see [Code Mode](code-mode.md)).
The images set `NODE_OPTIONS=--no-node-snapshot` for it. Trusted clone/verification/publication operations pin
the assigned GitLab host, instance and credential version. Credentials remain in
application/domain closures and the tool runtime, outside model memory and the
Workspace.

The base stack starts the `native-cli-runtime` image for typed service
operations. Configure the approved host allowlists. The egress proxy decides by
source network: the coding application and tool service reach it as
`egress-tools`, an alias that exists only on the tools network, so their
tunnels get the tools policy. The Slack adapter uses `egress` on the frontend
network.

On the qualified Linux Docker host, Mastra's native bubblewrap launcher needs a
root controller with `SYS_ADMIN`/`NET_ADMIN`, unconfined seccomp/AppArmor and
`no-new-privileges`. There is no privileged container, host namespace, Docker
socket or host-filesystem mount. A three-line bwrap packaging wrapper adds
`--cap-drop ALL`: the pinned framework otherwise retained these controller
capabilities in commands. Mastra still owns all mounts and execution.
The sandbox runs workspace commands and verification. Startup tests the actual sandbox for zero capabilities, a separate network
namespace, a minimal environment and hidden application/secrets paths. A failure
refuses startup. This documented framework exception is not a second sandbox
engine. Mount the application secrets so they are readable by the root controller.

Build the three selected targets with the same immutable tag (`native-coding`,
`adapter`, `cli-runtime`). No CI builds or scans them yet. Fresh designated provisioning
and live qualification use:

```sh
npm run test:stack:up -- --instance-dir /private/designated-coding --provision
npm run test:native:live -- --instance-dir /private/designated-coding \
  --scenario tests/live/scenarios/thread-followup.json --run --gateway-ready
```

The live fixture uses the previously approved test project. It retains an unmerged
MR and verifies the receipt's project, commit, branches and MR identity using
current assigned-instance reads. Every required file is fetched at the exact
published commit and checked for bytes/hash and scenario facts. A second turn
must publish a new commit to the same MR. Slack operation identity, unique send
and confirmed delivery are checked independently. Failed/unknown writes are never
retried by the driver. Reports and remote artifacts remain retained.

## Coding attachments and explicit exports

The shared agent accepts bounded UTF-8 text/CSV/TSV/Markdown and
PNG/JPEG/WebP inputs as ANSWER. PDF and leading-BOM text remain unsupported.
Mastra Memory retains exact original bytes and provenance. Native Workspace
receives editable copies under `.slack-inputs/<run>/<file>/<name>`; editing those
copies does not change original receipts. Current source, requester, channel
sharing and byte checks apply before provider/tool dispatch and delivery.

A top-level native `export_file` tool designates a Workspace file for delivery.
It snapshots exact bytes, name and SHA-256 into the restricted application store:
up to four files, each at most 2 MiB. It does not publish a repository or expose
arbitrary workspace files. Later edits do not change a registered snapshot.
The adapter rechecks current authority around allocation, transfer and completion,
then confirms the app-owned file in the exact thread and records its receipt
before posting the summary. Unknown external outcomes remain uncertain without
automatic resend. Read-only Slack authority calls honor a definite bounded
`Retry-After`; writes and unknown transport failures are never retried there.

The live scenario includes original CSV/PNG inputs, verified GitLab files and
exact downloaded export bytes:

```sh
npm run test:native:live -- --instance-dir /private/designated-coding \
  --scenario tests/live/scenarios/coding-files.json --run --gateway-ready
```

Saved-artifact recovery remains disabled. The @2 application seals require fresh
stores; no upgrade of retained @1 evidence is performed.

## Coding database and Workspace backup

Apply the same quiescence and current-authority requirements above to coding.
Back up the **whole database and the whole coding Workspace together**, after
joined shutdown of intake, execution and delivery. Keep the source fenced until
the restore is retired or explicitly adopted. Include `.git`, original working
copies, native Workspace metadata and retained domain receipts. Use GNU tar's
sparse/PAX, ACL and xattr support; preserve ownership, permissions, links and
mtimes. Restore into a fresh isolated directory with the same in-container mount
path, `/var/lib/native-coding`. Never overlay another retained workspace.

Use the standard logical PostgreSQL archive/restore commands above, retaining
all six application tables including export bytes and receipts. Record and
compare the entire source/destination row and catalog/ACL inventories and the
complete Workspace archive hash. Keep runtime secrets and **current** admin
policy separate; a backup must not restore old
authority or turn uncertain effects into permission to replay.

The `backup` suite (see above) archives the database and the Workspace
together. It restores both into a fresh cluster and directory, compares the
Workspace archive of source and destination, and checks retained export
receipts and an authorized continuation. Review the retained result before
using it to support a production rollout.

## Shared telemetry

Persisted Slack-agent telemetry is optional. Set `NATIVE_OBSERVABILITY_SOURCE=native`
and `NATIVE_OBSERVABILITY_PASSWORD_FILE` to an absolute private file containing a
separately generated database password (at least 24 characters). It must differ
from the primary runtime password file. Omitted or `off` leaves native persisted
telemetry disabled. Never place secrets in source control or command output.

Compose bind mounts retain the secret's host ownership and permissions. Both
images drop filesystem-bypass capabilities; coding runs as UID/GID 0 and answer
as UID/GID 1000. A root-owned file with group 1000 and mode 0640 supports both
templates and Studio without making it world-readable. Keep its host directory
private. The deployment preflight refuses a file unreadable by the selected
image user before stopping services.

Use a qualified current image, stop the designated test stack through
`test:stack:down`, update the private instance configuration, and start it through
`test:stack:up`. The normal supported restart remounts the current PostgreSQL HBA
file. The observability overlay starts a network-disabled maintenance service
before the agent; do not run `native-provision` against existing data.

This additive provisioner creates only `native_observability`, its restricted
role, and Mastra's official signal tables and partitions. It does not alter
primary application/framework schemas, credentials or configuration.
Existing observability passwords are not rotated. The runtime receives telemetry
DML and sequence usage, without deletion, DDL or primary schema access. Maintenance
uses only the existing PostgreSQL Unix socket, creates future partitions every
six hours, and receives no application/network credentials.

The application flushes exporters at shutdown; supported test shutdown stops
intake, drains application work, then stops application, telemetry maintenance and
PostgreSQL in dependency order. Telemetry and old application records are retained.
See [Studio source selection](mastra-studio.md#metrics-traces-and-logs) to inspect
Slack and Studio activity together without sharing their conversation stores.
