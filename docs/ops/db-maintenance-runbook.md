# DB maintenance runbook

The harness DB (`.harness/harness.sqlite`) is the canonical store for run state,
review proposals, audit, and artifact bodies (Phase 7–17). This runbook covers
keeping it healthy in production. The work is automated by
`scripts/harness-db-maintenance.sh`.

## What the script does

Each run, in order (best-effort: a failed step warns and sets a non-zero exit,
but does not abort the rest):

1. **backup** — `db backup --out <dir>/harness-<ts>.sqlite` (consistent
   standalone copy, includes WAL).
2. **checkpoint** — `db checkpoint` (fold WAL into the main file, truncate it).
3. **consistency check** — `db check-consistency` (DB ↔ files drift, export
   tracking, artifact-blob integrity).
4. **doctor** — `db doctor` (check registry; persists findings).
5. **stats** — `db stats` (row counts, blob totals, on-disk sizes).
6. **prune** — keep the newest `HARNESS_BACKUP_RETAIN` backups (default 14).

External blob storage (`db verify-blobs` / `gc-blobs`) is **not** run by default;
with no active local blob store it errors. Enable it in the script only if you
operate external storage.

## Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `HARNESS_ROOT` | yes | — | harness root holding `.harness/harness.sqlite` |
| `HARNESS_BIN` | no | `harness` | how to invoke the CLI; in-repo use `npm run harness --` |
| `HARNESS_BACKUP_DIR` | no | `$HARNESS_ROOT/backups` | backup destination |
| `HARNESS_BACKUP_RETAIN` | no | `14` | backups to keep |

## Schedule — cron

Daily at 03:30, logging to a file:

```cron
30 3 * * *  HARNESS_ROOT=/srv/harness HARNESS_BIN=harness \
  /srv/harness/repo/scripts/harness-db-maintenance.sh \
  >> /var/log/harness-maintenance.log 2>&1
```

## Schedule — systemd timer

`/etc/systemd/system/harness-maintenance.service`:

```ini
[Unit]
Description=Harness DB maintenance

[Service]
Type=oneshot
Environment=HARNESS_ROOT=/srv/harness
Environment=HARNESS_BIN=harness
ExecStart=/srv/harness/repo/scripts/harness-db-maintenance.sh
```

`/etc/systemd/system/harness-maintenance.timer`:

```ini
[Unit]
Description=Run harness DB maintenance daily

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable: `systemctl enable --now harness-maintenance.timer`.

## Concurrency

DB schema-mutating commands take an **exclusive** maintenance lock; read-side
commands take a **shared** lock (Phase 9). The script's commands coexist with
live `harness run` traffic, but `restore`/`vacuum` do not — schedule those in a
quiet window and pass `--wait` / `--timeout` if you want them to queue rather
than fail on contention.

## Alert / response

| Signal | Meaning | Response |
|--------|---------|----------|
| script exit ≠ 0 | a step warned | read the log; identify which step |
| `db consistency` drift/missing | DB ↔ files diverged | `db export-files` to refresh exports; investigate missing-db/missing-file |
| `db doctor` flagged > 0 | a check failed | `db doctor --json` to inspect; `db repair --dry-run <finding>` then apply if safe (repairs are whitelisted + dry-run by default) |
| backup step failed | could not write backup | check disk space / `HARNESS_BACKUP_DIR` perms; **do not** run `restore`/`vacuum` until a good backup exists |
| WAL not shrinking | checkpoint blocked by a long reader | find the long-running reader; retry checkpoint |

## Restore (disaster recovery)

`db restore --from <backup> --force` replaces the live DB atomically after
verifying the backup (sha + size). It is **destructive** — only run with the
service stopped and a known-good backup. See `docs/specs/db.md`.

## Periodic, lower-frequency tasks

- `db vacuum` — monthly or after large deletions, in a quiet window.
- `db upgrade-check --target <phase>` — before a schema/phase upgrade.
- `db stats` trend — watch blob totals; consider external blob storage if the
  DB file grows large.
