# Knip dead code check

Status: Done

## Summary

Nothing reported unused files, exports or dependencies, so dead code stayed
behind after features were removed. Add [Knip](https://knip.dev) as a T0
static check (`npm run knip`), configure it for this monorepo and delete
the dead code it finds, so the check starts green.

## Decisions and approach

- Knip `6.45.1`, pinned like the other dev tools. That release is two weeks
  old; newer releases were less than a week old.
- `ignoreExportsUsedInFile`: an export that its own file uses is not
  reported. Only symbols that nothing uses are reported.
- Entry points that Knip cannot infer are declared in `knip.json`: the esbuild
  entries of `apps/agent` (`main`, `provision`, `telemetry`, Studio
  observability), the deploy guard hook, the root CLI scripts, the T3
  verticals and qualification scripts, and two test fixtures that tests bundle.
- Generated mirrors are ignored, since their exports serve another app. Their
  canonical sources stay checked, except for five files whose exports only
  their mirror's app uses (`channel-commands`, `slack-message-content`,
  `slack-messages`, `tool-kinds`, `slack-charts`). For those, exports and
  types are not reported. `PROTOCOL_VERSION` carries `@public`, because only
  the generator and the contract test read it, both by regex.
- `ignoreDependencies` covers dependencies that bundled code from another
  workspace needs. `tool-runtime` bundles agent sources (`@modelcontextprotocol/sdk`,
  `ajv`, `undici`). The agent bundles Slack sources for Studio
  (`@slack/web-api`, `https-proxy-agent`), runs the `mastra` CLI and pins
  `@hono/node-server`, which `native-dependencies.test.ts` checks.
- Removed as dead: the unused library barrel `apps/agent/src/index.ts` and
  its `build` script; `refuse`, `realParents`, `authorizationPolicyHash`,
  `isSoftLimitMetric`, the `CONTROL_REPLY_*` receipts, the
  `SoftLimitStateDto`, `SoftLimitValuesDto` and `AdmissionStatsResponse` DTOs, the
  `ChannelMemoryTransport` interface, `UPSTREAM_HOSTS`, and the unused test
  helpers `startGitLab` (fake GitLab server), `FAKE_TRACE_JOB_ID` and
  `staticInstallations`. The protocol mirrors were regenerated. The wire
  contract is unchanged, so `PROTOCOL_VERSION` stays 30.
- No CI job: upstream has no pull request workflow, and T0 runs locally
  before every commit.

## Work

- [x] Add Knip, `knip.json` and `npm run knip`
- [x] Delete the dead code Knip reports
- [x] List `npm run knip` in T0 (`docs/testing.md`, `docs/development.md`)

## Verification

- Deterministic: T0 (`typecheck:all`, `lint`, `knip`, `format:check`) passes.
  A probe with a new unused file and an unused export makes `npm run knip`
  exit 1 and name both.
- Deterministic: T1 (`npm run test:packages`, 1118 tests in five workspaces) and
  T2 (`npm test`, 135 tests) pass in the Linux container.
- T3 not run: the change only deletes code that nothing references, which
  `typecheck:all` proves for sources and tests.
- Live: not applicable. No runtime behaviour changes; the removed code had no
  callers.

## Rollout

Done when the pull request merges. The image workflow republishes because
`apps/**` changed; the runtime behaves the same, so no deployment is needed.
