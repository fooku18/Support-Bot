#!/usr/bin/env bash
# Snapshot of one Support Agent instance's admin store (admin.sqlite: paired
# workspaces, channels, members, tool instances with their encrypted
# credentials, admin accounts, audit).
#
#   sudo deploy/docker/admin-backup.sh --env-file PATH --out DIR
#                               [--keep-hours N] [--keep-min N] [--reason LABEL]
#
# The env file (required, parsed, never sourced) names the Compose project
# (COMPOSE_PROJECT_NAME) and the store's host directory (ADMIN_STORE_DIR).
#
# - Admin container running: a consistent snapshot with SQLite `VACUUM INTO`
#   inside the container (includes committed WAL content), checked with
#   `PRAGMA integrity_check`.
# - Admin container stopped: its last close checkpointed the database, so the
#   files are copied as they are (admin.sqlite plus any -wal/-shm).
#
# Writes DIR/admin-<UTC time>-<reason>.tar.gz (./admin.sqlite[-wal|-shm];
# mode 0600, DIR mode 0700) and then prunes archives older than --keep-hours
# (default 72), always keeping the newest --keep-min (default 6). Restore:
# stop the admin service, extract the archive into ADMIN_STORE_DIR (owner uid
# 1000), start it; see docs/production-recovery.md.
#
# Run by admin-backup@<instance>.timer (hourly) and at shutdown by
# admin-backup-shutdown@<instance>.service (before Docker stops the stack).
# The archive holds credentials encrypted with ADMIN_STORE_KEY; treat it like
# the credentials. Nothing secret is printed.
set -euo pipefail
umask 077

ENV_FILE=''
OUT_DIR=''
KEEP_HOURS=72
KEEP_MIN=6
REASON=manual

die() {
  printf 'admin-backup: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case $1 in
    --env-file) ENV_FILE=${2:-}; shift 2 ;;
    --out) OUT_DIR=${2:-}; shift 2 ;;
    --keep-hours) KEEP_HOURS=${2:-}; shift 2 ;;
    --keep-min) KEEP_MIN=${2:-}; shift 2 ;;
    --reason) REASON=${2:-}; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$ENV_FILE" ] || die '--env-file is required'
[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE"
[ -n "$OUT_DIR" ] || die '--out is required'
[[ $KEEP_HOURS =~ ^[1-9][0-9]*$ ]] || die '--keep-hours must be a positive integer'
[[ $KEEP_MIN =~ ^[1-9][0-9]*$ ]] || die '--keep-min must be a positive integer'
[[ $REASON =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die '--reason must be a short lowercase label'

env_value() {
  local line
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)
  line=${line#*=}
  line=${line#"${line%%[![:space:]]*}"}
  line=${line%"${line##*[![:space:]]}"}
  line=${line%\"}; line=${line#\"}; line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

PROJECT=$(env_value COMPOSE_PROJECT_NAME)
STORE_DIR=$(env_value ADMIN_STORE_DIR)
[[ $PROJECT =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die 'COMPOSE_PROJECT_NAME is missing or invalid'
[[ $STORE_DIR == /* ]] || die 'ADMIN_STORE_DIR must be an absolute path'
case "/$STORE_DIR/" in */../*) die 'ADMIN_STORE_DIR must not contain ..' ;; esac
STORE_DIR=${STORE_DIR%/}
[ -d "$STORE_DIR" ] || die "ADMIN_STORE_DIR does not exist: $STORE_DIR"
[[ $OUT_DIR == /* ]] || die '--out must be an absolute path'
OUT_DIR=${OUT_DIR%/}
case "$OUT_DIR/" in "$STORE_DIR"/*) die '--out must not be inside ADMIN_STORE_DIR' ;; esac

mkdir -p "$OUT_DIR"
chmod 0700 "$OUT_DIR"

# One run at a time per output directory (timer and shutdown may overlap).
exec 9>"$OUT_DIR/.lock"
flock -w 60 9 || die 'another backup is still running'

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$OUT_DIR/admin-$STAMP-$REASON.tar.gz"
WORK=$(mktemp -d "$OUT_DIR/.work.XXXXXX")
SNAPSHOT_NAME=".backup-$STAMP-$$.sqlite"
cleanup() {
  rm -rf "$WORK"
  rm -f "$STORE_DIR/$SNAPSHOT_NAME"
}
trap cleanup EXIT

CONTAINER=$(docker ps -q \
  --filter "label=com.docker.compose.project=$PROJECT" \
  --filter 'label=com.docker.compose.service=admin' \
  --filter 'status=running' | head -n 1)

if [ -n "$CONTAINER" ]; then
  MODE=snapshot
  # The container mounts ADMIN_STORE_DIR at /var/lib/support-agent-admin; the
  # snapshot lands there and is moved out immediately.
  docker exec -i "$CONTAINER" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const target = "/var/lib/support-agent-admin/" + process.argv[1];
    const db = new DatabaseSync("/var/lib/support-agent-admin/admin.sqlite");
    db.prepare("VACUUM INTO ?").run(target);
    db.close();
    const copy = new DatabaseSync(target, { readOnly: true });
    const check = copy.prepare("PRAGMA integrity_check").get();
    copy.close();
    if (Object.values(check)[0] !== "ok") { console.error("integrity_check failed"); process.exit(1); }
  ' "$SNAPSHOT_NAME" || die 'snapshot inside the admin container failed'
  [ -s "$STORE_DIR/$SNAPSHOT_NAME" ] || die 'snapshot is missing or empty'
  mv "$STORE_DIR/$SNAPSHOT_NAME" "$WORK/admin.sqlite"
else
  MODE=copy
  [ -f "$STORE_DIR/admin.sqlite" ] || die "no admin.sqlite in ADMIN_STORE_DIR and no running admin container"
  for file in admin.sqlite admin.sqlite-wal admin.sqlite-shm; do
    if [ -f "$STORE_DIR/$file" ]; then cp -p "$STORE_DIR/$file" "$WORK/$file"; fi
  done
fi
# The admin service runs as uid 1000; keep that owner for a direct restore.
chown -R 1000:1000 "$WORK" 2>/dev/null || true

tar -czf "$ARCHIVE.partial" -C "$WORK" .
chmod 0600 "$ARCHIVE.partial"
mv "$ARCHIVE.partial" "$ARCHIVE"

# Retention: archives older than KEEP_HOURS go, but the newest KEEP_MIN stay.
pruned=0
mapfile -t archives < <(find "$OUT_DIR" -maxdepth 1 -type f -name 'admin-*.tar.gz' -printf '%f\n' | sort -r)
for index in "${!archives[@]}"; do
  if [ "$index" -lt "$KEEP_MIN" ]; then continue; fi
  name=${archives[$index]}
  if [ -n "$(find "$OUT_DIR/$name" -mmin "+$((KEEP_HOURS * 60))")" ]; then
    rm -f "$OUT_DIR/$name"
    pruned=$((pruned + 1))
  fi
done

printf 'admin-backup: project=%s mode=%s archive=%s bytes=%s pruned=%s kept=%s\n' \
  "$PROJECT" "$MODE" "$(basename "$ARCHIVE")" "$(stat -c %s "$ARCHIVE")" "$pruned" \
  "$(find "$OUT_DIR" -maxdepth 1 -type f -name 'admin-*.tar.gz' | wc -l)"
