# Fixture repository instructions (coding guidance, not executable setup)

This is a tiny dependency-free fixture for the Slack coding agent (milestone 5).
A coding task edits `greet.js` to implement the requested behavior and verifies
with the configured test command (`npm test --silent`, i.e. `node --test test/greet.test.js`).

Rules for the agent:

- Keep changes small and inside this repository. Do not add dependencies,
  network access, submodules, Git LFS, or executable hooks.
- Read and edit text files with the provided file tools. Run only the
  configured test command to verify; do not run arbitrary shell commands.
- Do not read anything outside the task workspace. Paths escaping the
  workspace are denied.
- Report what changed and the verification outcome in the final summary text.
  Never paste credentials, transcripts, or full patches into the summary.

This file is read as guidance text. It does not grant tools, hooks, plugins,
or MCP servers by itself.
