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
| DB tables | `goal_sessions` → `hitch_sessions`; `goal_attempts` → `hitch_attempts`; `goal_review_cycles` → `hitch_review_cycles`; `goal_findings` → `hitch_findings`; `goal_close_checks` → `hitch_close_checks`; `goal_convergence_decisions` → `hitch_convergence_decisions`; **all of their indexes** (10, by DROP + CREATE — `ALTER TABLE RENAME TO` does **not** rename indexes). |
| DB columns | `goal_id` → `hitch_id` in **8 columns** (one per `RENAME COLUMN`): the 6 hitch tables' own `goal_id` refs **plus** `workspaces.goal_id` (v17) and `workspace_checkpoints.goal_id` (v18), which are advisory links to a convergence session. |
| CLI | `harness goal …` → `harness hitch …` (start/status/orchestrate/finding/review-cycle/close-check/close/reopen/check-convergence/…). |
| MCP tools | the 16 `harness.goal.*` → `harness.hitch.*` (operation names `goal.*` → `hitch.*`). |
| MCP resources / prompts | resource template `harness://goal/{goalId}` → `harness://hitch/{hitchId}` (`resource-registry.ts`); prompt `harness.prompt.drive_goal_convergence` → `…drive_hitch_convergence` and the tool names embedded in its body (`prompt-registry.ts`). |
| MCP confirmation defaults | `DEFAULT_MCP_CONFIG.requireConfirmation` (`config.ts`) `goal.close`/`goal.cancel`/`goal.expand_scope` → `hitch.*` (**see P1: a stale entry fails the confirmation gate open**). |
| Source | `src/goal/` (22 files) → `src/hitch/`; `src/cli/goal.ts` → `src/cli/hitch.ts`; `src/mcp/tools/goal-tools.ts` → `hitch-tools.ts`; types/functions `Goal*` → `Hitch*`, `goalId` → `hitchId` (convergence-session sense only — see "What does NOT rename"). |
| Workspace layer | the workspace↔session link is convergence-sense and renames: `src/workspace/workspace-goal-link.ts` → `workspace-hitch-link.ts`; the `goal_id` SQL in `src/db/repositories/workspaces.ts` (the v17/v18 columns); the workspace MCP tools' `goalId`; and the **user-facing CLI flag `harness workspace … --goal <id>` → `--hitch <id>`** (a deliberate breaking change, consistent with the rename) plus its `goal=` status display. |
| SCHEMA_VERSION | bump `SCHEMA_VERSION` (`src/db/schema.ts`) 19 → 20 — without it `runMigrations` rejects a migrated DB as "newer than supported". |
| Docs | `docs/specs/goal-convergence.md` → `hitch-convergence.md`; the `goal` vocabulary across the specs that mention it; `GOAL.md`/`GOAL_RULES.md`/`AGENTS.md`/`CLAUDE.md` terminology + `README.md`/`future-features.md`. `docs/reports/` and historical `docs/superpowers/{plans,specs}` stay as historical record (not back-edited). |
| **Unchanged** | finding severity (P0–P3), convergence decisions (`needs_fix`/`close_ready`/…), run/review/operation status values, the convergence logic itself. Behaviour is identical. |

## What does NOT rename (boundary — prevents mechanical-sweep misfires)

Only identifiers that mean **"a convergence session"** rename: `goalId` / `Goal*`
types / `goal_*` tables / `goal.*` MCP operations / the `harness goal` command /
`src/goal/`. The word "goal" in its **plain task sense stays**, because a blind
`goal → hitch` sweep would corrupt unrelated surfaces:

- `harness run --goal <text>` / `harness workflow … --goal` (the coding task
  description, `src/cli/run.ts`).
- `backlog_items.goal` column + the backlog `goal` field (`schema.ts`).
- `recoverGoal` / goal-text params in `workflow-runner.ts`, `rerun.ts`,
  `prompt-builder.ts`, `reviewed-run-workflow.ts`, `pr-creator.ts`.

`src/cli/run.ts` contains **both** senses — rename there must be surgical, not a
file-wide replace.

## Lockstep checklist (hardcoded refs that silently rot if missed)

These reference the old names by string/glob and must change in the same PR —
none are caught by the tool-list or migration tests:

1. **`src/core/automerge-tiers.ts`** — `{ glob: "src/goal/**", tier: 2 }` → `src/hitch/**`. Missing this **silently demotes hitch code's auto-merge sensitivity** from tier 2 to default (a safety regression — violates "behaviour identical").
2. **`src/release/release-git.ts`** — `CLI_PATHS` lists `src/cli/goal.ts`; add/replace with `src/cli/hitch.ts`, or the fail-closed release-surface scanner stops watching the renamed command.
3. **`src/onboard/step-impls.ts`** — the wizard generates/guides `goal.start` / `harness.goal.start`; update to `hitch.start`.
4. **`DEFAULT_MCP_CONFIG.requireConfirmation`** (`src/mcp/security/config.ts`) — see P1.
5. **MCP resources/prompts** (`resource-registry.ts`, `prompt-registry.ts`) — see scope table.
6. **`.harness/mcp.yaml`** (operator's live config) — `allowedOperations` AND `requireConfirmation` AND any `deniedOperations` `goal.*` → `hitch.*`.

(Correction: `db check-consistency` / `src/db/consistency.ts` has **no** goal
references — an earlier draft wrongly listed it.)

## Settled trade-offs

**Clean cut — no working backward-compat alias.** A working `harness goal` alias
would defeat the entire purpose (two live names = more confusion). Instead:
- `harness goal` is replaced by a **stub that errors** with `goal mode was
  renamed to "hitch" — use 'harness hitch …'` (discoverability for muscle memory
  / automation, for one release; then removed — tracked in
  `docs/future-features.md`). No working dual command.
- **MCP has no stub** (asymmetric, deliberate): `harness.goal.*` calls fail with
  the SDK's "unknown tool" — there is no themed feature reason to keep them, and
  a renamed-tool stub would re-introduce the dual name. The operator must update
  `.harness/mcp.yaml`: **both `allowedOperations` AND `requireConfirmation`**
  (and any `deniedOperations`) `goal.*` → `hitch.*`. A stale `requireConfirmation:
  [goal.close, …]` would otherwise leave the renamed `hitch.close`/`cancel`/
  `expand_scope` **unconfirmed (gate fails open)** — so the config loader SHOULD
  warn (or refuse) when it sees a `goal.*` operation string post-rename
  (fail-closed stale-config detection). A `serve` restart is required.

**DB: in-place rename migration, not new-table-and-copy.** A new schema-version
migration (forward-only, inside the existing per-migration transaction):
- `ALTER TABLE goal_<x> RENAME TO hitch_<x>` for the 6 tables.
- `ALTER TABLE hitch_<x> RENAME COLUMN goal_id TO hitch_id` for the 8 `goal_id`
  columns (the 6 tables + `workspaces` + `workspace_checkpoints`). SQLite 3.53
  (bundled in better-sqlite3 12.x) auto-rewrites FK clauses that reference the
  renamed table/column.
- **`DROP INDEX` + `CREATE INDEX`** for the 10 indexes — `RENAME TO` does **not**
  rename indexes, so they must be recreated under `hitch_*` names (and to point
  at the renamed columns).
- **No `PRAGMA foreign_keys` toggling** — it is a no-op inside a transaction
  (and unnecessary; `RENAME` keeps FKs consistent). The migration test instead
  asserts `PRAGMA foreign_key_check` returns empty post-migration.

**Historical audit JSON** in `operations` metadata that stored `goalId`/`goal_id`
is left as-is (historical record); new writes use `hitchId`/`hitch_id`. The
`operations.operation_type` history of `goal.*` rows is likewise left as-is
(see "behaviour caveats").

## Architecture / approach

A mechanical, atomic rename behind green tests. Order of operations (so the build
never half-breaks):

1. **Migration** (schema version bump): rename the 6 tables (`RENAME TO`), the 8
   `goal_id` columns (`RENAME COLUMN`), and recreate the 10 indexes
   (`DROP`/`CREATE`) — see the corrected mechanics above. Forward-only (no
   down-migrations, consistent with existing style). Migration test: a pre-rename
   DB seeded with rows in every `goal_*` table (and `workspaces`/
   `workspace_checkpoints` with `goal_id`) ends with `hitch_*` tables + `hitch_id`
   columns holding the same rows, no `goal_*` tables remain, and
   `PRAGMA foreign_key_check` is empty.
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

## Safety boundaries (unchanged) + behaviour caveats

Pure refactor: the post-hoc `git diff` policy verification, harness-only state
transitions, LLM-output distrust, and MCP `confirmation_required` are all
untouched **provided the lockstep checklist is done** — note that the confirmation
gate, auto-merge tier, and release-surface scanner all key off the old names by
string/glob, so missing one is a real safety regression (hence they are P1
checklist items, not "just docs"). The convergence gate, close conditions, and
orchestrate flow behave identically — only names change.

Behaviour caveats (the only non-identical edges, both benign):
- **Idempotency across the upgrade**: operation dedupe keys on
  `(operation_type, target_id, idempotency_key)`. A pre-rename `goal.*` operation
  retried post-rename as `hitch.*` is not deduped against the old row. Low impact
  (idempotency keys are per-attempt), noted for completeness.
- **Breaking release**: removing the `harness goal` command + 16 MCP tools is
  detected as a breaking change by the release gate (`release-plan.ts`), forcing
  a minor (0.x) bump. This is intended — the rename ships as a breaking release
  and the migration notes double as release notes.

## Error handling / migration safety

- The migration is wrapped in the existing managed-DB transaction; a failure
  rolls back (no half-renamed schema).
- `db check-consistency` stays green on a migrated DB (it does **not** reference
  the goal tables, so no lockstep change there — it is only a regression check).
- The erroring `goal` CLI stub exits non-zero with the remediation, so scripts
  fail loudly rather than silently no-op.

## Testing

- **Migration test**: seed a DB at the pre-rename schema version with rows in
  every `goal_*` table, run migrations, assert `hitch_*` tables exist with the
  same row counts/ids and `goal_*` are gone.
- **CLI**: `harness hitch …` works (port the existing goal CLI tests); `harness
  goal` errors with the rename guidance.
- **MCP**: `harness.hitch.*` tools are registered and `harness.goal.*` are absent
  (extend the server-skeleton tool-list test); the `harness://hitch/{hitchId}`
  resource and `drive_hitch_convergence` prompt are present.
- **Confirmation gate (P1)**: `hitch.close` / `hitch.cancel` / `hitch.expand_scope`
  require confirmation under `DEFAULT_MCP_CONFIG`; a config carrying a stale
  `goal.*` confirmation entry is warned/refused by the loader.
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
