# Egress proxy workspace

The proxy connects the private application networks to the outbound bridge.
Admin also joins a non-internal ingress bridge for its host-published UI.
Services on the
internal networks send their external HTTPS through it as `CONNECT host:443`
tunnels; it admits, per source network (the instance's fixed subnets), the
host names the env file pins, resolves them itself and pipes bytes. TLS stays
end to end; the proxy never parses the tunnel and never holds a credential.

- `src/policy.ts`: host sets per source network, derived from the instance's
  env variables (Slack, Gateway, webhook, extra hosts; GitLab, Atlassian,
  Datadog, Cloudflare, package registries; the web network may reach any
  public host on 80/443).
- `src/proxy.ts`: the CONNECT server (decision, resolution, private-address
  check for the web policy, connect/idle timeouts, per-source limits, an
  `open` and an end log line per tunnel, denial counters).
- `src/forward.ts`: optional inbound TCP relays selected by `EGRESS_FORWARDS`.
  Base Compose configures no relays and keeps the agent port private.
- `src/index.ts`: entry point; `/healthz` and `/metrics` on the loopback
  status port for the Compose healthcheck.

```sh
npm test            # policy and tunnel tests against local servers
npm run typecheck
```
