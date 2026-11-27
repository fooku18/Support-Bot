# Request progress in Slack

The adapter adds an hourglass reaction to an admitted Slack request. It
removes the reaction after presentation or a terminal outcome. Reactions
are best-effort indicators. For the request's current state, use `status`
in the same thread.

Use `cancel` to stop work or `continue <answer>` to answer the agent's
outstanding question. Anyone in the original thread can use these controls if their own
authorization allows it. A continuation checks current authorization and requires
an answer. Pass files with a normal work request.

The agent can suspend a run with Mastra's `ask_user` tool. The question and
its continuation state are retained across a restart. The app checks the
current suspension and resumes it once on an authorized continuation.
While the run is waiting for input, the requester's next unmentioned reply
in the thread is the answer; a reply of just `cancel` stops the run.

Inspect execution in [Mastra Studio](mastra-studio.md). For authenticated
stack inspection, use the [deployment runbook](production-recovery.md).
