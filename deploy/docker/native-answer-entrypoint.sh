#!/bin/sh
set -eu
# Telemetry is additive maintenance and never invokes fresh native
# provisioning. Provision refuses an existing native database or role; there
# is deliberately no automatic adoption or native recovery.
case "${1:-start}" in
  telemetry) exec node /app/apps/agent/dist/native/telemetry.mjs ;;
  provision) exec node /app/apps/agent/dist/native/provision.mjs ;;
  upgrade) exec node /app/apps/agent/dist/native/upgrade.mjs ;;
  start) exec node /app/apps/agent/dist/native/main.mjs ;;
  *) echo 'unsupported native operation' >&2; exit 1 ;;
esac
