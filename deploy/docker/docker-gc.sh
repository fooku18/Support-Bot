#!/usr/bin/env bash
# Removes superseded Support Agent images and old build cache from this host.
#
#   sudo deploy/docker/docker-gc.sh [--dry-run]
#
# Every build reuses its instance's image tag (NATIVE_IMAGE_TAG: local for
# prod, test for the test instance). With Docker's classic image store the
# image it replaces stays behind untagged (dangling); with the containerd
# image store (this VM, Docker 29) a build replaces it outright, and images go
# dangling only when a tag moves to another image (`docker tag`). The build
# cache grows either way. The script runs a fixed command list; nothing passes
# through from its caller:
#
# - `docker image prune -f --filter label=org.support-agent.image=1`: dangling images
#   built from the Dockerfile's base stage only (no -a). Tagged images, images
#   any container uses (stopped ones included) and other projects' images stay.
# - `docker image rm support-agent/<name>:ctest` (never -f) for each
#   labelled :ctest image no container uses: the container suites tag them and
#   rebuild them at their next start. Images of the prod and test
#   instances (:local, :test) and rollback tags are never removed.
# - `docker builder prune -f --filter until=168h`: build cache unused for a
#   week; rebuilds within a week stay fast.
# - `docker builder prune -f --max-used-space 10GB`: then least recently used
#   cache until at most 10 GB remain.
#
# Volumes, containers and networks are never touched. --dry-run lists the
# dangling Support Agent images and the :ctest images it would remove, and removes
# nothing. Ends with one summary line:
#   docker-gc: images_removed=N ctest_removed=N ctest_kept=N image_bytes=N cache_bytes=N
# (bytes from Docker's rounded totals, :ctest removals not counted; `unknown`
# when Docker printed none).
#
# Images are host-wide, so one run covers every instance. Run daily by
# support-agent-docker-gc.timer; `npm run test:stack:up` runs the same image prune
# after a successful start. See docs/production-recovery.md.
set -euo pipefail

DRY_RUN=0

die() {
  printf 'docker-gc: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY_RUN=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

LABEL_FILTER=label=org.support-agent.image=1
CTEST_REFERENCE='reference=support-agent/*:ctest'
CACHE_CAP=10GB

# Dangling Support Agent images, one line each, into the array named by $1.
dangling() {
  local listing
  listing=$(docker image ls --no-trunc --filter dangling=true --filter "$LABEL_FILTER" \
    --format '{{.ID}} {{.CreatedSince}} {{.Size}}') || die 'docker image ls failed'
  mapfile -t "$1" < <(printf '%s' "$listing" | grep -v '^$' || true)
}

# Labelled :ctest images no container (running or stopped) uses, into the
# array named by $1.
unused_ctest() {
  local listing ref users
  listing=$(docker image ls --filter "$CTEST_REFERENCE" --filter "$LABEL_FILTER" \
    --format '{{.Repository}}:{{.Tag}}') || die 'docker image ls failed'
  local -a refs=()
  while IFS= read -r ref; do
    [[ $ref == support-agent/*:ctest ]] || continue
    users=$(docker ps -aq --filter "ancestor=$ref") || die 'docker ps failed'
    [ -z "$users" ] && refs+=("$ref")
  done <<<"$listing"
  mapfile -t "$1" < <(if [ ${#refs[@]} -gt 0 ]; then printf '%s\n' "${refs[@]}"; fi)
}

# Docker prints decimal sizes (0B, 512kB, 1.2GB); whole bytes, or `unknown`.
to_bytes() {
  awk -v size="$1" 'BEGIN {
    unit["B"] = 1; unit["kB"] = 1e3; unit["KB"] = 1e3; unit["MB"] = 1e6
    unit["GB"] = 1e9; unit["TB"] = 1e12
    if (match(size, /^[0-9]+(\.[0-9]+)?/) && (substr(size, RLENGTH + 1) in unit))
      printf "%.0f\n", substr(size, 1, RLENGTH) * unit[substr(size, RLENGTH + 1)]
    else
      print "unknown"
  }'
}

# Last whitespace-separated field of the first line starting with $1.
total() {
  awk -v prefix="$1" 'index($0, prefix) == 1 { print $NF; exit }'
}

# Sum of whole-byte values; `unknown` if any is.
sum_bytes() {
  local total=0 value
  for value in "$@"; do
    [ "$value" = unknown ] && { echo unknown; return; }
    total=$((total + value))
  done
  echo "$total"
}

dangling before
unused_ctest ctest

if [ "$DRY_RUN" = 1 ]; then
  for line in "${before[@]}"; do printf 'docker-gc: dangling %s\n' "$line"; done
  for ref in "${ctest[@]}"; do printf 'docker-gc: ctest %s\n' "$ref"; done
  printf 'docker-gc: dry-run images_dangling=%s ctest_unused=%s\n' "${#before[@]}" "${#ctest[@]}"
  exit 0
fi

image_out=$(docker image prune -f --filter "$LABEL_FILTER") || die 'docker image prune failed'
ctest_removed=0
ctest_kept=0
for ref in "${ctest[@]}"; do
  # A container created since the listing makes Docker refuse; it stays.
  if docker image rm "$ref" >/dev/null 2>&1; then
    ctest_removed=$((ctest_removed + 1))
  else
    ctest_kept=$((ctest_kept + 1))
  fi
done
age_out=$(docker builder prune -f --filter until=168h) || die 'docker builder prune failed'
cap_out=$(docker builder prune -f --max-used-space "$CACHE_CAP") || die 'docker builder prune failed'
dangling after

image_total=$(total 'Total reclaimed space:' <<<"$image_out")
age_total=$(total 'Total:' <<<"$age_out")
cap_total=$(total 'Total:' <<<"$cap_out")

printf 'docker-gc: images_removed=%s ctest_removed=%s ctest_kept=%s image_bytes=%s cache_bytes=%s\n' \
  "$((${#before[@]} - ${#after[@]}))" "$ctest_removed" "$ctest_kept" \
  "$(to_bytes "${image_total:-}")" \
  "$(sum_bytes "$(to_bytes "${age_total:-}")" "$(to_bytes "${cap_total:-}")")"
