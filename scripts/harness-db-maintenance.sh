#!/usr/bin/env bash
#
# Periodic harness DB maintenance — intended to run from cron / systemd timer.
# Backs up the DB, checkpoints the WAL, checks consistency, runs doctor, verifies
# external blobs, prints stats, and prunes old backups.
#
# Env:
#   HARNESS_ROOT          (required) the harness root holding .harness/harness.sqlite
#   HARNESS_BIN           how to invoke the CLI (default: "harness"). For an
#                         in-repo checkout use: HARNESS_BIN="npm run harness --"
#   HARNESS_BACKUP_DIR    backup destination (default: $HARNESS_ROOT/backups)
#   HARNESS_BACKUP_RETAIN how many backups to keep (default: 14)
#
# Exit code is non-zero if any maintenance step fails; per-step warnings are
# logged but do not abort the remaining steps (best-effort maintenance).

set -uo pipefail

: "${HARNESS_ROOT:?set HARNESS_ROOT to the harness root}"
export HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1

# shellcheck disable=SC2206  # intentional word-split so "npm run harness --" works
HARNESS=(${HARNESS_BIN:-harness})

ts="$(date +%Y%m%d-%H%M%S)"
backup_dir="${HARNESS_BACKUP_DIR:-$HARNESS_ROOT/backups}"
retain="${HARNESS_BACKUP_RETAIN:-14}"
mkdir -p "$backup_dir"

rc=0
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
step() { # step <description> <cmd...>
  local desc="$1"; shift
  log "$desc"
  if ! "$@"; then
    log "WARN: step failed: $desc"
    rc=1
  fi
}

step "backup -> $backup_dir/harness-$ts.sqlite" \
  "${HARNESS[@]}" db backup --out "$backup_dir/harness-$ts.sqlite"
step "checkpoint WAL" \
  "${HARNESS[@]}" db checkpoint
step "consistency check" \
  "${HARNESS[@]}" db check-consistency
step "doctor" \
  "${HARNESS[@]}" db doctor
step "stats" \
  "${HARNESS[@]}" db stats

# If you run external (non-DB) blob storage, also verify/GC it here, e.g.:
#   step "verify external blobs" "${HARNESS[@]}" db verify-blobs
# Skipped by default: with no active local blob store, verify-blobs errors.

# Retention: keep the newest $retain backups, remove the rest.
log "prune backups (retain $retain)"
ls -1t "$backup_dir"/harness-*.sqlite 2>/dev/null | tail -n +"$((retain + 1))" | while read -r f; do
  log "remove old backup: $f"
  rm -f "$f"
done

log "maintenance complete (rc=$rc)"
exit "$rc"
