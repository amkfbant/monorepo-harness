# Real-codex smoke test — DB-canonical runtime

**Date:** 2026-06-04
**Trigger:** Production-readiness step 2 (real codex × real repo smoke). First
real-codex run since Phase 7; all of Phase 7–19 runtime had only been exercised
through the fake codex runner.
**codex:** codex-cli 0.133.0
**Result:** PASS — every checked behavior matched the simulated suite.

## Goal

Run one real `harness run` against a throwaway target repo to confirm that the
DB-canonical runtime (Phase 7–8), default-OFF file export (Phase 9), and asset
attribution (Phase 14/17) behave on real codex output the same way they do under
the fake runner.

## Setup (throwaway)

- Target repo: `/tmp/harness-smoke-20260604-004206/target` — `git init -b main`,
  a single `src/greeting.ts` and `README.md`, one initial commit.
- Harness root: `/tmp/harness-smoke-.../harness-root` — copied `global.yaml`
  plus a minimal `policies/repos/smoke.yaml` (domain `src`, `write: src/**`,
  `deny_write: [.git/**, README.md]`).
- `HARNESS_EXPORT_FILES` left unset (exercises the Phase 9 default-OFF path).

## Command

```bash
HARNESS_ROOT=$HR harness run --repo $TGT --repo-id smoke --domain src \
  --goal "Add a farewell(name: string): string function to src/greeting.ts \
          that returns a goodbye message, mirroring the existing greeting function."
```

Result line:

```
run=run-20260603-src-mpy8j7120d38298b status=needs_review safetyStatus=allowed \
  ignoredUntrackedCount=0 secretSuspectCount=0 commands=0/0
```

## Verification

| Check | Expectation | Result |
|-------|-------------|--------|
| Final status | `needs_review` + `safetyStatus=allowed` | PASS |
| DB-canonical | `.harness/harness.sqlite` holds run/events/artifacts; `run show` reads from DB | PASS (720 KB DB; artifact listing served from DB) |
| Export OFF | `runs/` empty; `run show` works without files; export-mode warning emitted | PASS (`runs/` empty, note "file export status = disabled") |
| Asset attribution | run links a policy snapshot | PASS (`effectivePolicySnapshotId=1`) |
| Policy enforcement | codex edits only `src/`; no violation | PASS (diff touches only `src/greeting.ts`) |
| Codex output correctness | goal-shaped change | PASS (see diff) |

Generated diff (recovered from the DB blob via `db export-files --scope run --id <run>`):

```diff
 export function greeting(name: string): string {
   return `Hello, ${name}!`;
 }
+
+export function farewell(name: string): string {
+  return `Goodbye, ${name}!`;
+}
```

## Findings

- **No behavioral divergence** between real codex and the fake runner across the
  status machine, DB persistence, export-OFF read path, asset attribution, and
  policy validation. The simulation-first design held on real output.
- The Phase 8 DB-only read path (`run show` / artifact listing from DB with no
  files on disk) worked end-to-end on a real run for the first time.
- `db export-files` uses `--scope run --id <run>`, not `--run <run>` (operator
  note; the latter errors with "unknown option").

## Follow-up smoke (same day)

A second pass exercised the review and agent surfaces against the same run /
a fresh goal root:

- **`review auto`** — the real reviewer codex ran read-only over the
  materialized run and emitted `decision=approved`; the proposal was written to
  `review_proposals` (DB-canonical, run had no files on disk).
- **`review process`** — applied the proposal: `needs_review → approved`,
  surfaced by `run show` reading from the DB.
- **goal loop** — `db init` (schema v16, all 16 migrations) → `goal start`
  (status=open) → `check-convergence` (`decision=continue`, "more validation
  required") → `goal status`, all through the real CLI.
- **MCP server** — `mcp serve` over stdio answered an `initialize` JSON-RPC
  request with `serverInfo` (monorepo-harness 0.1.0) and tools/resources/prompts
  capabilities (protocolVersion 2025-11-25).

No divergence from the fake-runner behavior on any surface.

## Still deferred

- `pr create` — needs a real GitHub remote and creates an external PR; validate
  on a real repo, not a throwaway.
- `rerun --from-review` — bounded retry chain on real codex.

## Cleanup

Throwaway tree under `/tmp/harness-smoke-*` is disposable and may be removed.
