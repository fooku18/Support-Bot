# Request progress in Slack

The adapter adds an hourglass reaction to an admitted Slack request. It
removes the reaction after presentation or a terminal outcome. Reactions
are best-effort indicators. For the request's current state, use `status`
in the same thread.

Use `cancel` to stop work or `continue <answer>` to answer the agent's
outstanding question. The thread owner must use these controls in the
original thread. A continuation checks current authorization and requires
an answer. Pass files with a normal work request.

The agent can suspend a run with Mastra's `ask_user` tool. The question and
its continuation state are retained across a restart. The app checks the
current suspension and resumes it once on an authorized continuation.
While the run is waiting for input, ordinary text does not answer it.

Inspect execution in [Mastra Studio](mastra-studio.md). For authenticated
stack inspection, use the [deployment runbook](production-recovery.md).
