# Design: rename harness "goal" mode → "hitch" (SP-0)

Status: approved (brainstorm) — pending implementation plan.
Date: 2026-06-11.

## Problem

The harness's convergence feature is called **goal** (`harness goal`,
`goal_sessions`, `harness.goal.*`, `src/goal/`, GOAL.md). "goal" collides with
(a) the general word, and (b) Claude Code's `/goal` command — this session
repeatedly had to disambiguate "`/goal` (the driver)" from "`harness goal` (the
feature)". The confusion is an active, recurring cost in code, docs, and
operation.

This sub-project (**SP-0**) renames the feature to a harness-themed name and is a
pure refactor: **no behaviour change**. It is the foundation for two follow-on
sub-projects (separate specs): **SP-1** (a DB-managed `course → phase` roadmap
layer above hitches, replacing GOAL.md) and **SP-2** (autonomous
`course orchestrate`). This spec covers SP-0 only.

## Naming (settled)

The harness is "monorepo-**harness**"; the vocabulary unifies on a horse-tack /
driving theme — but **only on the sparse command/brand surface**. High-frequency
words the agent *reads and reasons over* (phase, finding severity, convergence
decision, status, review) stay conventional, so the rename improves clarity
rather than forcing the agent to learn a themed vocabulary.

| Concept | Name | Surface |
|---------|------|---------|
| convergence unit (was **goal**) | **hitch** | command/DB/MCP — themed |
| roadmap layer (SP-1, net-new) | **course** | command — themed |
| phase of a course (SP-1) | **phase** | agent-read structure — **stays "phase"** |
| finding severity / decision / status / review | unchanged | agent-read — **not themed** |

SP-0 renames **goal → hitch** only. `course`/`phase` are introduced by SP-1.

## Scope (SP-0 = goal → hitch, everywhere)

| Surface | Change |
|---------|--------|
| DB tables | `goal_sessions` → `hitch_sessions`; `goal_attempts` → `hitch_attempts`; `goal_review_cycles` → `hitch_review_cycles`; `goal_findings` → `hitch_findings`; `goal_close_checks` → `hitch_close_checks`; `goal_convergence_decisions` → `hitch_convergence_decisions`; their indexes; and the `goal_id` column (16 refs) → `hitch_id`. |
| CLI | `harness goal …` → `harness hitch …` (start/status/orchestrate/finding/review-cycle/close-check/close/reopen/check-convergence/…). |
| MCP tools | the 16 `harness.goal.*` → `harness.hitch.*` (operation names `goal.*` → `hitch.*`). |
| Source | `src/goal/` (22 files) → `src/hitch/`; `src/cli/goal.ts` → `src/cli/hitch.ts`; `src/mcp/tools/goal-tools.ts` → `hitch-tools.ts`; types/functions `Goal*` → `Hitch*`, `goalId` → `hitchId`. |
| Docs | `docs/specs/goal-convergence.md` → `hitch-convergence.md`; the `goal` vocabulary across the 10 docs that mention it; `GOAL.md`/`GOAL_RULES.md`/`AGENTS.md` terminology (these stay as files for now; SP-1 moves the roadmap into the DB). |
| **Unchanged** | finding severity (P0–P3), convergence decisions (`needs_fix`/`close_ready`/…), run/review/operation status values, the convergence logic itself. Behaviour is identical. |

## Settled trade-offs

**Clean cut — no working backward-compat alias.** A working `harness goal` alias
would defeat the entire purpose (two live names = more confusion). Instead:
- `harness goal` is replaced by a **stub that errors** with `goal mode was
  renamed to "hitch" — use 'harness hitch …'` (discoverability for muscle memory
  / automation, for one release; then removed). No working dual command.
- MCP exposes only `harness.hitch.*`. The operator must update `.harness/mcp.yaml`
  `allowedOperations` (`goal.start` → `hitch.start`, etc.) — **called out in the
  migration notes**; a `serve` restart is required (registration change).

**DB: in-place rename migration, not new-table-and-copy.** A new schema-version
migration uses `ALTER TABLE … RENAME TO` (tables/indexes) + `ALTER TABLE …
RENAME COLUMN goal_id TO hitch_id` (SQLite ≥ 3.25, bundled in better-sqlite3),
preserving all data. The migration toggles `PRAGMA foreign_keys` off, renames in
FK-safe order, and re-enables. **Historical audit JSON** in `operations`
metadata that stored `goalId`/`goal_id` is left as-is (historical record); new
writes use `hitchId`/`hitch_id`.

## Architecture / approach

A mechanical, atomic rename behind green tests. Order of operations (so the build
never half-breaks):

1. **Migration** (schema version bump): rename tables/indexes/columns in-place.
   Forward-only; the harness has no down-migrations (consistent with existing
   migration style). Add a migration test asserting a pre-rename DB (seeded with
   `goal_*`) ends with `hitch_*` tables holding the same rows.
2. **Repository + core layer**: `src/goal/` → `src/hitch/`; `GoalRepository` →
   `HitchRepository`; `goalId` → `hitchId`; SQL string literals `goal_*` →
   `hitch_*`. Keep function/behaviour identical.
3. **CLI**: `src/cli/goal.ts` → `hitch.ts`; `registerGoalCommands` →
   `registerHitchCommands`; command name `goal` → `hitch`; add the erroring
   `goal` stub.
4. **MCP**: `goal-tools.ts` → `hitch-tools.ts`; tool names + operation strings
   `goal.*` → `hitch.*`; the mutation-gate `GoalLinkedMutationKind` values stay
   semantically the same (`run.start` etc. unchanged); `goal.orchestrate`
   operation → `hitch.orchestrate`.
5. **Docs**: rename `goal-convergence.md`; update vocabulary across specs;
   `GOAL.md`/`GOAL_RULES.md`/`AGENTS.md` terminology + a note that the roadmap
   files themselves are superseded by SP-1.
6. **Tests**: rename test files/fixtures; update assertions referencing `goal_*`
   tables, `harness goal`, `harness.goal.*`.

Because it is a rename, each layer keeps its existing structure and boundaries;
no responsibilities move. `src/cli/hitch.ts` is already large (55 KB) — **not**
split here (out of scope; a split is a separate refactor SP-1 can revisit).

## Safety boundaries (unchanged)

Pure refactor: the post-hoc `git diff` policy verification, harness-only state
transitions, LLM-output distrust, and MCP `confirmation_required` are all
untouched. The convergence gate, close conditions, and orchestrate flow behave
identically — only names change. No new trust surface.

## Error handling / migration safety

- The migration is wrapped in the existing managed-DB transaction; a failure
  rolls back (no half-renamed schema).
- `db check-consistency` must pass post-rename (the consistency checks reference
  table names — update them in lockstep).
- The erroring `goal` CLI stub exits non-zero with the remediation, so scripts
  fail loudly rather than silently no-op.

## Testing

- **Migration test**: seed a DB at the pre-rename schema version with rows in
  every `goal_*` table, run migrations, assert `hitch_*` tables exist with the
  same row counts/ids and `goal_*` are gone.
- **CLI**: `harness hitch …` works (port the existing goal CLI tests); `harness
  goal` errors with the rename guidance.
- **MCP**: `harness.hitch.*` are registered and `harness.goal.*` are absent
  (extend the server-skeleton tool-list test).
- **Regression**: the full suite (renamed) stays green; `npm run typecheck`
  clean. No skipped/weakened tests. This is the primary correctness signal — a
  rename that keeps every behavioural test green is correct by construction.
- `db check-consistency` green on a migrated DB.

## Out of scope (follow-on specs)

- **SP-1**: the `course → phase` DB roadmap layer + GOAL.md→DB importer + read/
  write API (the actual new functionality; #88 epic grouping folds in here).
- **SP-2**: autonomous `course orchestrate` (phase auto-advance), reusing the
  hitch-orchestrate gate one level up.
- Splitting the large `hitch.ts` / `hitch-tools.ts` files.
- Backfilling historical audit JSON `goalId` values.
- The 10 goal-mode feature issues (#84–#93) — they land on SP-1's model.
