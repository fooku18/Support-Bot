# Project status

This application is not live yet. Coding agents can treat it as a greenfield
project: nothing needs to be backwards compatible. Remove obsolete APIs,
configuration aliases, migration code, and compatibility paths instead of
preserving them. The testing and evidence-retention rules below still apply.

# Plans and tracking

Keep one Markdown file per feature, design or work order under `plans/`.
Follow the [planning skill](.agents/skills/plan/SKILL.md) for the template
and status conventions. Update the plan alongside the implementation so
contributors can review both in the same change. Link the plan from the
merge or pull request.

- Record decisions, results, live verification, open items and deployment in
  the same file. Link retained evidence and keep credentials out of Git.
- Record results and live verification status before merging. A missing
  prerequisite is blocked. Use `Done` after merge and any required deployment.
- Drain production before stopping or recreating an execution service.
  Run `node scripts/deploy-preflight.mjs --env-file .env --wait-idle`.
  The deployment guard checks the drain receipt. `SUPPORT_AGENT_DEPLOY_DRAINED=1`
  requires explicit operator consent. See [deployment and recovery](docs/production-recovery.md).

# Shared skills and hooks

Maintain project skills in `.agents/skills/` and expose each skill to
Claude Code with a relative directory symlink under `.claude/skills/`.
Invoke the planning skill as `$plan` in Codex or `/plan` in Claude Code.

Claude's `.claude/settings.json` and Codex's `.codex/hooks.json` register
the deployment guard in `.agents/hooks/`. Run
`npx vitest run tests/integration/agent-config.test.ts tests/integration/native-deployment.test.ts`
to exercise both configurations with synthetic input.

Codex enables hooks in `.codex/config.toml`. In a trusted checkout, use
`/hooks` in a fresh Codex session to review and trust the deployment guard.
Changed commands require renewed trust. See the
[Codex hook documentation](https://learn.chatgpt.com/docs/hooks).

# Feature development and verification

Read [docs/testing.md](docs/testing.md) before changing application behavior.

- The tests form a ladder, T0 to T5. Run T0 to T2 before every commit, T3 for
  agent, storage, policy, Slack intake or delivery changes, T3 `tools` for
  tool, egress or CLI-runtime changes, and the stub suite (T4) for stack or
  settings changes. Prove behaviour at the lowest tier that can prove it.
- Changes to Slack intake or delivery, task orchestration, context,
  inference, coding or publication need a passing gateway suite (T5) on the
  designated test instance before release. Until that is possible, record
  live acceptance as BLOCKED. Stub and synthetic tests never establish live
  acceptance.
- **Before you write, change or run a stub or gateway scenario, read
  [docs/live-test-rules.md](docs/live-test-rules.md).** It defines what tests
  may do with each test service and credential, the live-scenario gate and
  the evidence rules.
- These rules always apply:
  - Run live and stub tests, and any stack command for them, only against the
    test instance named by `.env.testing` and `.env.e2e`, with
    `npm run test:stack:up|ps|down`. Never against `.env` or production.
  - Never use production credentials or productive tools in tests.
  - An agent never types, reads, copies or prints a credential. Keep
    credentials out of logs, reports, commits and images.
    `E2E_SLACK_SENDER_TOKEN` lives only in `.env.e2e`.
  - A value marked `<operator: ...>` or a missing prerequisite is BLOCKED:
    stop and ask the operator. Never substitute a value or report a skip as a
    pass.
  - Never run a second Socket Mode adapter for the same Slack app.
  - The test instance rests in gateway mode. Run the stub suite with
    `--switch-mode`; if you switch modes by hand, switch back before you
    finish.
