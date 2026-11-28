# Slack SDK 8

Status: In review

## Summary

Update `@slack/web-api` 7.19.0 to 8.5.0 and `@slack/socket-mode` 2.0.7 to
3.2.0, the Slack majors that the
[dependency update](dependency-update-2026-11.md) left out. Both replace their
HTTP and WebSocket transport with `fetch` and undici, so the egress proxy
moves from an `https-proxy-agent` agent to an undici dispatcher.

## Decisions and approach

- **The proxy is an undici `ProxyAgent` with `proxyTunnel: true`.** The SDKs
  dropped the `agent` option and silently ignore it; the adapter would have
  gone around the egress proxy and failed on the internal network. They take
  a `dispatcher` now. A plain `ProxyAgent` forwards `http://` requests as
  absolute-URI requests, and the egress proxy only accepts CONNECT.
  `https-proxy-agent` always tunnelled, so `proxyTunnel: true` keeps that.
- **One dispatcher for the Web API clients, file transfers and the Socket
  Mode websocket**, as the agent was before. `createOutboundDispatcher`
  replaces `createOutboundAgent`; `configureOutbound` (the global `fetch`
  dispatcher with direct routes to Compose services) is unchanged.
- **File uploads use `fetch` with that dispatcher** instead of
  `node:https.request` with the agent: same 30 s timeout, no redirects, the
  same three error messages.
- `https-proxy-agent` leaves both workspaces.

## Work

- `apps/slack/src/outbound.ts`, `installations.ts`, `receiver.ts`,
  `slackclient.ts`, `file-upload.ts`, `native-application.ts` and
  `apps/agent/src/bootstrap/studio.ts`: `dispatcher` instead of `agent`.
- `apps/slack/test/outbound.test.ts`: a plain-HTTP request through a
  CONNECT-only proxy must arrive tunnelled.
- `knip.json`: the `upgrade.ts` entrypoint from #41 (knip failed on `main`)
  and the stale `https-proxy-agent` ignore.

## Verification

- T0: typecheck, lint, knip and format pass.
- T1 and T2 in the Linux container: all package tests and `npm test` pass.
- T3, images `slack8-33fa5dd9b0e9`: discovery (13 records), application (82),
  backup (18), telemetry (8) and tools (19) pass.
- T4 stub suite, images built from this branch: 7 of 8. Only
  `stub-cancel-control-stops-a-held-run` fails (`expected_answer_fact_missing`),
  as on `main` since 2026-11-27.
- T5 gateway `answer-continuity` passes through the egress proxy.
- After the rebase onto `8a7a85d` (#52): T0, T1 and T2 rerun.

## Rollout

Ships with the next digest bump of the deployment repo. No new env, secrets
or Slack scopes. Check after the deploy: exactly one "socket connected" and
an answer in the test channel.

## Open items

- [ ] Deploy and live-check
