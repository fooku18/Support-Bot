# Code Mode without the coding workspace

Status: Human review

## Summary

Code Mode runs in an in-process V8 isolate and needs no sandbox, but it was
created only together with the privileged coding workspace. The **Code Mode**
tool kind existed in the settings and did nothing. Answer-only deployments
(the unified Kubernetes image) can now use it per channel.

## Decisions and approach

- Without a workspace, Code Mode is bound when the channel has a ready
  `codeMode` assignment, the actor has `tool.use` on it and at least one read
  tool is available. The grant is checked again before each script; each read
  keeps its own checks.
- With a workspace nothing changes: Code Mode is always discoverable.
- A script may make at most 50 reads and return at most 48 000 bytes (result
  and logs). A direct read costs a model step; a script had no such bound.
- The agent always requires `--no-node-snapshot` at startup. Every image sets it.
- Tradeoff: the isolate shares the agent process, which holds the database
  password and the model key. This is the existing Code Mode boundary.

## Work

- [x] Grant, binding in Slack and Studio runs, script bounds
- [x] Tests and documentation

## Verification

- Deterministic: see the pull request.
- Live: **Blocked**. T4 and T5 need the designated test instance.

## Rollout

Assign **Code Mode** on a channel's Tools page. Unassign it to turn it off.

## Open items

- [ ] T3 `application` and `coding` on a Linux Docker host
- [ ] T5 on the test instance
