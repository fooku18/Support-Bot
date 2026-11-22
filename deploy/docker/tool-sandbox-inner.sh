#!/bin/bash
set -eu
umask 077
# Inner stage of the credentialed CLI sandbox (run inside the bubblewrap
# namespace). Still root here: source the root-owned provider environment
# file (mode 0400, bound at /run/support-agent-env — never argv), then drop to the
# CLI uid for the pinned binary invocation.
uid=$1
file_blocks=$2
shift 2
env_file="${CLI_SANDBOX_ENV_FILE:-/run/support-agent-env}"
if [ ! -r "$env_file" ]; then
  echo "provider environment file is unavailable" >&2
  exit 126
fi
set -a
. "$env_file"
set +a
exec setpriv --reuid="$uid" --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
  bash -c 'ulimit -f "$1"; shift; exec "$@"' bash "$file_blocks" "$@"
