#!/bin/sh
# Build and exercise the production target with the workload security context.
set -eu
if [ "${1:-}" = --prebuilt ]; then
  image=${2:?supply the image to test}
else
  image=${1:-support-agent/runtime:qualification}
  docker build -f deploy/Dockerfile --target runtime -t "$image" .
fi
run() {
  docker run --rm --network none --read-only --tmpfs /tmp:exec --cap-drop ALL \
    --security-opt no-new-privileges "$@"
}
run --entrypoint sh "$image" -ec '
  test "$(id -u)" = 1000
  test "$(stat -c %u:%g /var/lib/support-agent-admin)" = 1000:1000
  test ! -e /app/apps/model-stub
  node -e "const ivm=require(\"isolated-vm\"); if(new ivm.Isolate({memoryLimit:8}).createContextSync().evalSync(\"6*7\") !== 42) process.exit(1)"
  # Use an argv probe to check exec dispatch and existence of each built file.
  printf "%s\n" "#!/bin/sh" "test -f \"\$1\" || exit 1" "printf \"%s\\\\n\" \"\$@\"" > /tmp/node
  chmod +x /tmp/node
  export PATH=/tmp:$PATH
  for role in agent provision upgrade telemetry admin admin-cli adapter cli-runtime; do
    case "$role" in
      agent) expected=/app/apps/agent/dist/native/main.mjs ;;
      provision|upgrade|telemetry) expected=/app/apps/agent/dist/native/$role.mjs ;;
      admin) expected=/app/apps/admin/dist/index.js ;;
      admin-cli) expected=/app/apps/admin/dist/cli.js ;;
      adapter) expected=/app/apps/slack/dist/index.js ;;
      cli-runtime) expected=/app/apps/tool-runtime/dist/cli-runtime-service.js ;;
    esac
    test "$(support-agent "$role" "two words" tail)" = "$(printf "%s\n" "$expected" "two words" tail)"
  done
  test "$(support-agent cli-runtime)" = "$(printf "%s\n" "$expected" --serve)"
  test "$(support-agent adapter)" = "$(printf "%s\n" /app/apps/slack/dist/index.js --process-env)"
  if support-agent bogus 2>/tmp/error; then exit 1; fi
  grep -q "Unknown support-agent role" /tmp/error
'
run --entrypoint sh "$image" -ec '
  refuses() {
    if support-agent "$1" > /tmp/result 2>&1; then exit 1; fi
    grep -Fq "$2" /tmp/result
    if grep -Eq "ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError" /tmp/result; then exit 1; fi
  }
  refuses agent "native answer startup refused: SERVICE_TOKEN required"
  refuses adapter "Native adapter startup refused"
  refuses provision "Error: valid NATIVE_PG_HOST required"
  refuses upgrade "Error: valid NATIVE_PG_HOST required"
  refuses telemetry "Error: valid NATIVE_PG_HOST required"
  refuses admin-cli "usage: node dist/cli.js"
'
run --entrypoint sh "$image" -ec '
  export ADMIN_DB=/tmp/settings.sqlite ADMIN_PUBLIC_URL=https://admin.invalid
  export ADMIN_STORE_KEY=$(printf "%064d" 1) ADMIN_SESSION_KEY=$(printf "%064d" 2)
  export ADMIN_INTERNAL_TOKEN=$(printf "%032d" 3)
  export SLACK_CLIENT_ID=fixture SLACK_CLIENT_SECRET=fixture
  support-agent admin &
  child=$!
  trap "kill $child" EXIT
  node -e "for(let i=0;i<40;i++){try{const r=await fetch(\"http://127.0.0.1:9883/healthz\");if(r.status===200)process.exit(0)}catch{} await new Promise(r=>setTimeout(r,250))}process.exit(1)"
'
run --env CLI_RUNTIME_TOKEN=synthetic --entrypoint sh "$image" -ec '
  support-agent cli-runtime &
  child=$!
  trap "kill $child" EXIT
  node -e "for(let i=0;i<40;i++){try{const r=await fetch(\"http://127.0.0.1:9877/healthz\");if((await r.json()).ok)process.exit(0)}catch{} await new Promise(r=>setTimeout(r,250))}process.exit(1)"
'
