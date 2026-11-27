# Mastra application

The default deployment in `deploy/compose.yaml` runs the shared Mastra agent,
the native Slack adapter, PostgreSQL and the credential-owning CLI runtime.
Slack and Studio share one agent for answers and on-demand read-tool discovery.

## Runtime ownership

The agent package is `apps/agent`. Its source has explicit owners:

- `mastra/agents/coding.ts` defines the agent, with shared configuration for model,
  memory and bounded defaults. Mastra owns execution.
- `mastra/tools/` binds framework tools to current application authority.
- `application/` composes trusted configuration, service bindings, agent service,
  HTTP endpoints and Studio. `bootstrap/` contains executable entrypoints.
- `integrations/` owns GitLab, Slack, Atlassian, Datadog, Cloudflare, model providers
  and credential-service adapters. `infrastructure/` owns storage and process helpers.
- `domain/authorization`, `domain/files` and `domain/delivery` own current
  policy, exact file receipts and delivery.
- `contracts/` owns canonical wire vocabulary. The generator produces standalone
  admin/Slack clients so those process images retain their own dependencies.

The Slack receiver runs in `apps/slack`. The credential-owning CLI runtime
runs in `apps/tool-runtime`. Studio and Slack use the same agent definition.

Native diagnostics use Mastra's `ConsoleLogger` with bounded segment IDs,
durations and token counts. Studio persists bounded traces, metrics and logs. Slack persists these signals
when the [shared telemetry store](#shared-telemetry) is enabled. Exporters
omit prompts, answers, tool payloads and arbitrary metadata. Application
delivery receipts remain authoritative.

One small version-specific suspension decoder remains in `mastra/runtime/inspection.ts`:
the pinned public observation API does not recover a cold question when its
replay cache is empty. Keep the cold-inspection regression when upgrading Mastra.

Mastra's pinned Agent/createDurableAgent, Memory/PostgresStore, top-level
`ask_user`, native resume/abort, processors and workflow inspection own execution.
Automatic durable/workflow recovery stays off. The four `native_agents` tables
retain identity, admission/input provenance and external-effect receipts. Answer attachments use
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
channel-memory proxy/client runs on loopback, with admin as the source.

Read tools reuse Mastra `createTool`, typed catalogs, validators, and the
credential-owning CLI runtime clients. GitLab reads, Atlassian reads, Datadog
reads, Cloudflare reads and Slack user lookups remain bound to current channel
policy and the assigned instance. Code Mode is available when it is assigned.

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
through the shared agent. Search results do not prove direct page retrieval.

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

Alternatively, `NATIVE_WEB_FETCH_MODEL`, `NATIVE_WEB_FETCH_API_KEY` (or
`_FILE`) and optionally `NATIVE_WEB_FETCH_BASE_URL` read pages with Gemini's URL
context tool. Google retrieves the page, so nothing in this network does, and
no web runtime is needed. The base is the Gemini API's
`https://generativelanguage.googleapis.com/v1beta` by default; a gateway must
serve `POST /models/<model>:generateContent` with `x-goog-api-key`. Use a Flash
model: the request turns thinking off. `web_fetch(url, question)` then returns
the reader model's answer to one question, not the page. It fails unless the
API itself reports the requested page as retrieved. The URL and the question go
to Google; pages behind a login or in a private network cannot be read. Reader
requests are not in the cost ledger. Configure either this or the web runtime.

The pinned Mastra built-in fetch tool cannot use this transport: it owns raw
Node HTTP requests and DNS lookup with no proxy injection. Native fetch
receipts retain hashed call/URL/content identities and byte counts, never page
bodies. `tests/live/scenarios/web-fetch.json` requires fresh direct reads of the
fixture URL on both questions and refuses search substitution.
Studio uses the same binding and optional private network.

The shared agent uses Mastra's `ToolSearchProcessor`. Only the bound read tools
enter its catalog, along with Code Mode when it is assigned.
Code Mode's generated signatures load with its tool. Clarification and provider
search stay directly available when configured. Native keyword search auto-loads at most three matches for the next
model turn. Full service schemas are withheld initially; there is no injected
catalog or separate load turn. Loaded tools derive from framework conversation
context (`storage: 'context'`), survive restart while the discovery result is
retained, and disappear when that context is trimmed. The model can search again.
Search adds one inference before a first read; a retained loaded tool can be
called directly on a follow-up.

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
maintenance. On an existing store, the `upgrade` maintenance entrypoint
(`native-upgrade` in Compose) runs the framework's own additive DDL (new
tables, columns and indexes) and grants the runtime DML on framework tables.
It requires the store's seal at the current version and leaves application
tables, roles and the seal unchanged. `test:stack:up` runs it before the
agent starts. Runtime uses `disableInit`, a non-owner `native_answer` role, no
schema/database creation rights, framework DML and narrow application grants.
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
worker. Commands make no inference run. See
[channel-commands.md](channel-commands.md) for authorization, expiry, conflict and
retry semantics. Unmentioned thread replies starting with `!` stay silent.

In an existing conversation, `continue <answer>`, `cancel` and `status` work with
or without a mention. The question notice shows the model's options as buttons;
the requester's click answers with that option and replaces the buttons with the
choice. Others who click get a private note that only the requester can answer. Multi-select questions, more than 25 options and labels over 75
characters are listed as text instead. The requester's next unmentioned reply
answers a suspended question, with or without `continue`; other people answer it
with `continue <answer>`. Continuation obtains the current `ask_user`
suspension from framework inspection, including after restart, and resumes only
once. Controls with files or an empty answer refuse without consuming the resume.
Busy or uncertain requests require an explicit control or a new mention.

Every final answer ends with **Helpful** and **Not helpful** buttons. Any channel
member may vote; the adapter stores the click through the admin
(`/internal/channel-commands/feedback`, table `answer_feedback`, one vote per
user and run, a later click replaces it) and confirms it privately. The admin
**Costs** page lists the latest 50 voted answers with their counts.

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
- **During and after execution**, a change does not stop the run. Its answer
  and long-answer file (`answer.md`) are delivered under the accepted
  settings. The agent logs
  `native delivery policy_changed_delivered run_id=…` once. A tool unassigned
  or replaced during the run is refused at its next call, because its
  credentials are revoked; the run continues without it. Provider web search
  runs inside the model request, so unassigning or revoking it refuses the
  run's next model call, and the run ends with the failure notice.
- **Tool readiness**: each segment asks the tool runtime whether it serves
  every assigned runtime tool (GitLab, Atlassian, Datadog, Cloudflare, Slack)
  with the instance's current credential version. A tool it cannot qualify
  (runtime down or restarting, sync error, instance not yet synced, another
  credential version or contract) is left out of that segment; the model is
  told it is unavailable and the agent logs
  `native tool left out run_id=… tool=<kind> reason=…`. The run answers
  without it. An unassigned or revoked tool is not readiness: it is absent
  from the settings and refused at every call.
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
npm run test:native:integration -- --suite backup --image-tag <tag>
npm run test:native:integration -- --suite telemetry --image-tag <tag>
```

The default and `application` suites run the agent from source in one Node
process per phase. `backup` runs the provision, application and adapter
entrypoints, bundled from the current source, inside the `native-answer`
image with the tag you give. `telemetry` runs the telemetry maintenance
entrypoint in that image.

Qualify the designated Slack test instance and direct model connection separately. Record the tested
revision and the evidence in the corresponding work plan.

## Quiesced logical backup and fresh restore

Use the same application/framework locks and PostgreSQL 17, a quiesced source,
and a fresh isolated destination. Stop and
fence intake, execution **and delivery** writers before the snapshot; wait for
joined shutdown and verify no runtime database sessions remain. Keep the source
fenced throughout inspection and any explicit destination continuation. There
must be one active owner across both stores: the database advisory lock cannot
fence a different cluster. No post-snapshot external effects may be omitted from
the archive. An arbitrary stale backup is not safe to replay external writes.

Back up the whole dedicated `native_answer` database. Mastra owns `framework`,
including messages, threads, durable snapshots and memory/run ownership fences.
Keep all `native_agents` tables: `tasks`, `requests` (including input
provenance), `actions` and `deliveries`. A store provisioned by an earlier
release also has `exports` and `publications`; the runtime no longer uses
them, but the dump keeps them.
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

## Tool service and egress

The base stack starts the `native-cli-runtime` image for typed service
operations. Configure the approved host allowlists. The egress proxy decides by
source network: the application and tool service reach it as
`egress-tools`, an alias that exists only on the tools network, so their
tunnels get the tools policy. The Slack adapter uses `egress` on the frontend
network. Credentials remain in the tool runtime, outside model memory.

## Attachments

The shared agent accepts bounded UTF-8 text/CSV/TSV/Markdown and
PNG/JPEG/WebP inputs. PDF and leading-BOM text remain unsupported.
Mastra Memory retains exact original bytes and provenance. Current source,
requester, channel sharing and byte checks apply before provider/tool dispatch
and delivery. Read-only Slack authority calls honor a definite bounded
`Retry-After`; writes and unknown transport failures are never retried there.

Saved-artifact recovery remains disabled. The @2 application seals require fresh
stores; no upgrade of retained @1 evidence is performed.

## Shared telemetry

Persisted Slack-agent telemetry is optional. Set `NATIVE_OBSERVABILITY_SOURCE=native`
and `NATIVE_OBSERVABILITY_PASSWORD_FILE` to an absolute private file containing a
separately generated database password (at least 24 characters). It must differ
from the primary runtime password file. Omitted or `off` leaves native persisted
telemetry disabled. Never place secrets in source control or command output.

Compose bind mounts retain the secret's host ownership and permissions. The
image drops filesystem-bypass capabilities and runs as UID/GID 1000. A
root-owned file with group 1000 and mode 0640 supports Compose and Studio
without making it world-readable. Keep its host directory
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
