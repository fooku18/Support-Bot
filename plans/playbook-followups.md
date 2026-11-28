# Support playbook follow-ups

Status: Human review

## Summary

Four short rules in the support playbook, from what the replay panels kept getting wrong:

- Start from leads already in the thread (suspected change, service, query, ticket) and confirm or rule them out first.
- When the monitoring itself may be broken, say so in the first sentence, before any reading from that monitor.
- Count the items you list before you state a number (an answer said "Eleven" above a table of twelve).
- Do not repeat customer names, email or IP addresses, customer or order IDs from the thread.

The playbook grows from about 2,200 to 2,622 characters; the compactness test allows 2,800.

## Evidence

Replay panel of 20 real support, feedback and incident threads, no channel prompt, 25 steps / 300 s, two runs per side (`main` `6eb0776` vs this branch):

| Side   | Acceptable | Correct action | Fact recall | Harmful | Est. cost / run |
| ------ | ---------- | -------------- | ----------- | ------- | --------------- |
| main   | 9, 13      | 3, 5           | 25%, 37%    | 5, 3    | $4.82           |
| branch | 12, 13     | 5, 4           | 34%, 34%    | 7, 4    | $5.55           |

The targeted cases improved. The red-flag negative (monitoring broken, no real drop) was harmful in both `main` runs and harmful in one branch run; the other branch run was useful (u2, 3/8 facts). The second red-flag case recalled 8/9 and 5/9 facts against 0/9 and 6/9. The extra harmful grades on the branch are wrong investigations of the same kind `main` makes: the search case blames prod load when the job really hit staging, and the PDP fee case blames an upstream multiplier. They are not caused by the new lines.

## Tests

- T0 (typecheck, lint, format) and T1/T2 on Linux pass on `20da724`; after the rebase onto `09b47a7` the instructions and Studio tests pass.
- T5: BLOCKED as for earlier playbook changes; live check in the staging test channel after deploy.
