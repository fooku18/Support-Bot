# Update the Node runtime for CVE-2026-111497

Status: Human review

## Summary

Move all images that inherit the shared Node base from 26.11.1 to 26.13.1.
Node includes the bundled Brotli decoder fix from 26.12.1. [Security release](https://nodejs.org/en/blog/release/v26.12.1)

## Decisions and approach

Keep Debian 12 slim and pin the linux/amd64 manifest. The new base includes
perl-base 5.36.0-7+deb12u4, so remove the temporary apt upgrade for that package.

## Work

- [x] Update the shared base and build the unified runtime.
- [ ] Qualify the updated images on the designated test stack.

## Verification

- The pinned base reported Node v26.13.1 and perl-base 5.36.0-7+deb12u4.
- On the updated Dockerfile based on `e27a0e9264ea`, `tests/integration/runtime-image.sh support-agent/runtime:tr2941` passed. Running `node --version` in that runtime returned `v26.13.1`.
- T0 typecheck, lint and format checks, T1 package tests and T2 root tests passed. T3 application passed 80 records (evidence ID `7a007d77`) and T3 tools passed 19 (evidence ID `0113b4fd`).
- T4 ran all eight stub scenarios on the images in `0489850` with `--suite stub --run --switch-mode`. Six scenarios timed out waiting for an answer, cancellation failed with `cancel_not_confirmed`, and thread-followup was blocked with `working_indication_not_observed`. The cause is unconfirmed. Retained test-instance report: `artifacts/native-live/suite-f0cfa228-3356-4ea0-9c9f-d86aff34a5d0/summary.json`.
- The driver restored gateway mode. The test instance was then stopped and its original image tag restored.
- Live acceptance is **BLOCKED**. No gateway run has qualified these images.

## Rollout

After merge, the publish workflow qualifies the runtime and records its GHCR
digest. Downstream consumers can pin that digest, verify the running Node
version in staging and promote the same downstream image digest to production.
