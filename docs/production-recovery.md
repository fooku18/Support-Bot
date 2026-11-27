# Native deployment and recovery

The stack in `deploy/compose.yaml` runs the shared Mastra agent.

## 1. Configuration and fresh provisioning

Use `.env.example` as the native reference. Provide three private subnets, the
settings service configuration and secret-file references. The stack runs the
adapter, agent, CLI runtime, PostgreSQL, settings service and egress proxy.
Provide the HTTPS reverse proxy for the settings UI and the direct provider
connections in the deployment catalog. The model stub is for
test instances only: only `test:stack:up --model-mode stub` starts it. See the [live test setup](live-test-setup.md) for every
value.

Build or promote the exact `native-answer`, `adapter`, `cli-runtime`, `admin`
and `egress` images under the selected
`NATIVE_IMAGE_TAG`. Fresh PostgreSQL setup is a separate `native-provision`
maintenance operation. It refuses an existing native database/schema.
After a new image, dump the native database, then run `native-upgrade`
before the agent starts: it applies the framework's schema changes to an
existing sealed store.
See [native-answer.md](native-answer.md#storage-and-prerequisites).

## 2. Drain before stop or recreate

```sh
node scripts/deploy-preflight.mjs --env-file <explicit-env> --wait-idle
node scripts/inspect.mjs --env-file <explicit-env>
```

Preflight validates the native configuration, resolves
Compose, refuses old/unrelated project members and reads authenticated native
status. Missing/unreachable runtime, active execution and uncertain delivery
block the drain. A config-only `--no-docker` check writes no drain marker.
Suspended questions remain retained and are reported separately.

The deployment guard covers the application, adapter and PostgreSQL,
including direct container commands. Fresh provisioning and overrides
require explicit operator authorization; `SUPPORT_AGENT_DEPLOY_DRAINED=1` is never an
automatic workaround. Hook definitions must be trusted in the active agent
session as described in AGENTS.md.

Stop intake, allow its joined work to finish, confirm native idle, then stop the
application before PostgreSQL. Stop/recreate is not volume removal. Do not use
`down -v`, automatic purge, or old recovery scripts. A failed drain leaves
intake stopped and requires inspection; uncertainty is not permission to replay.

## 3. Backup and restore

Use the [quiesced logical backup and fresh restore recipe](native-answer.md#quiesced-logical-backup-and-fresh-restore).
Retain whole framework/application schemas, bytes, ACLs and current external
authority. Restore into a fresh isolated destination, keep the
source fenced, inspect without inference/sends, and allow only a current
explicit authorized continuation. An old archive cannot prove that later
external effects did not occur. Use the restored environment for
inspection before allowing any explicit continuation.

`npm run test:native:integration -- --suite backup --image-tag <tag>` checks
this recipe against the image you deploy, with synthetic services.

## 4. Release gates

Current-source tests, image checks, exact dependency identities, scan results,
backup/restore evidence, actual provider and Slack acceptance and operator handover
are distinct gates. The default deployment provides the shared agent with
answers and read tools. Optional saved-artifact recovery stays disabled. Production rollout requires operator authorization.
Qualify a non-SQLite settings backend before production rollout.
Record verification and its live outcome in the work plan before merge.
Record the deployed revision, time, rollback reference and evidence in
the same plan before marking the release done.
