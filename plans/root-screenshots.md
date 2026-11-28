# Screenshots on the thread root

Status: In progress

## Summary

A human posts a screenshot and a teammate asks the bot about it in a reply.
The initial thread read used to return only text; direct attachments worked.

## Decisions and approach

Discover supported human-authored root images on the first thread read. Preserve the actual source author and timestamp independently from the requester. Acquire and recheck bytes through the existing receipt and authority checks, within the existing run limits.

## Verification

- A two-author adapter regression failed against the main implementation at `6c8828b`: the first thread read returned no images.
- T0 passed (typecheck, lint, knip, formatting). Linux T1 and T2 passed. T3 application passed all 82 records (`621f309f`).
- Before the change, a Slack probe with a first mention in a reply failed; a control with the mention on the root read the error code.
- Live acceptance: blocked pending gateway qualification on the designated test instance.

## Rollout

Pending qualification and deployment.
