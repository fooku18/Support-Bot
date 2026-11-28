# Larger step and time budget for answer-only runs

Status: Human review

## Summary

Answer-only runs (Kubernetes, no coding store) stop after 12 steps or 120 s.
Replays of real support threads showed lumi investigating less deeply than
with the 40-step local budget, and the operator approved a larger budget on
2026-11-27.

Goal: give answer-only runs room for a second source and a follow-up read
without changing coding runs.

## Decisions and approach

- `apps/agent/src/bootstrap/application.ts`: answer-only limits go from
  12 steps / 120 s to 25 steps / 300 s. Coding runs keep 40 / 600.
- The built-in instructions already state the limits the run executes with
  (#26), so the model sees the new budget without another change.
- Adapter and tool-runtime timeouts are per request, not per run: local
  600 s coding runs use the same adapter, so nothing else changes.
- A constant, not a setting: one value is in use, and the operator can ask
  for another.

## Verification

- T0: `npm run typecheck:all`, `lint`, `format:check`.
- T1/T2 on Linux: `npm run test:packages`, `npm test`.
- Replay panel (20 real threads from the feedback, support and incident
  channels, answer-only, no channel prompt, `claude-5.5-sonnet` graded by
  `claude-5.5-sonnet`), two runs per budget on the #26 code:

| Budget       | Acceptable | Correct action | Fact recall | Harmful | Est. cost / run | Median s | Runs > 12 steps |
| ------------ | ---------- | -------------- | ----------- | ------- | --------------- | -------- | --------------- |
| 12 / 120 s   | 14, 8      | 4, 3           | 29%, 23%    | 2, 7    | $4.50           | 44       | 0               |
| 25 / 300 s   | 11, 13     | 6, 6           | 29%, 34%    | 5, 5    | $5.83           | 54       | 5, 7            |
| Mean 12 → 25 | 11 → 12    | 3.5 → 6        | 26% → 31.5% | 4.5 → 5 | +30%            |          |                 |

The longest run took 95 s, so 300 s leaves room. Gains are modest and
within run noise for acceptable and harmful; correct actions and recall
improve in both runs.

- T5: BLOCKED as for earlier merges; live check in the staging test channel
  after deploy.
