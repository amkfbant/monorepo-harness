# Rename `goal` → `hitch` (SP-0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the harness "goal" convergence feature to "hitch" everywhere (DB, CLI, MCP, source, docs) as a pure refactor — no behaviour change.

**Architecture:** A schema-version migration renames the DB in-place, then each layer (core/repo → CLI → MCP → docs → hardcoded lockstep refs) is renamed while the existing behavioural test suite stays green. New code only where the rename adds a surface: the v20 migration, the erroring `harness goal` stub, MCP stale-config detection, and tests for those.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite 3.53), commander, vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-rename-goal-to-hitch-design.md` (Fable-approved). Branch: `feat/rename-goal-hitch`.

**Conventions:** `npm run typecheck` before each commit. Tests: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run <path>`; full suite adds `--poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1`. Conventional Commits, NO Co-Authored-By. ESM `.js` imports.

**Guiding rule for the mechanical bulk:** the existing behavioural tests ARE the spec. A rename that keeps every behavioural test green is correct by construction. Where this plan says "rename X→Y across the layer", do the rename, update that layer's test references, and run the tests — green = done.

**Boundary (do NOT rename — task-sense "goal"):** only convergence-session identifiers rename (`goalId`/`Goal*` types/`goal_*` tables/`goal.*` MCP ops/`harness goal` command/`src/goal/`). The plain task-description sense stays: `harness run --goal <text>`, `backlog_items.goal` + the backlog `goal` field, `recoverGoal` and goal-text params in `workflow-runner.ts`/`rerun.ts`/`prompt-builder.ts`/`reviewed-run-workflow.ts`/`pr-creator.ts`. `src/cli/run.ts` has BOTH senses — never file-wide-replace it.

---

## Task 1: v20 migration — rename DB in-place

**Files:**
- Modify: `src/db/migrations.ts` (add `MIGRATION_V20_STATEMENTS` + a `{ version: 20, … }` entry after v19)
- Modify: `src/db/schema.ts` (the canonical CREATE statements that a fresh DB builds from — rename `goal_*` → `hitch_*`, `goal_id` → `hitch_id`, index names, in the v16/v17/v18 statement blocks so a fresh DB and a migrated DB converge)
- Test: `tests/unit/db/migrate-v20-hitch-rename.test.ts`

- [ ] **Step 1: Enumerate the exact surface (no code yet)**

Run these and record the exact identifiers (the migration must cover all of them):
```bash
grep -nE "goal_(sessions|attempts|review_cycles|findings|close_checks|convergence_decisions)" src/db/schema.ts
grep -noE "CREATE INDEX [a-z_]*goal[a-z_]*" src/db/schema.ts          # every goal index name
grep -nE "goal_id" src/db/schema.ts                                   # every goal_id column (6 hitch tables + workspaces + workspace_checkpoints)
```
Expected: 6 tables, ~10–12 indexes, 8 `goal_id` columns (the 6 tables + `workspaces` + `workspace_checkpoints`).

- [ ] **Step 2: Write the failing migration test `tests/unit/db/migrate-v20-hitch-rename.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrationsUpTo, runMigrations } from "../../../src/db/migrations.js";

// Build a DB at v19 (pre-rename), seed one row per goal_* table + a workspace
// goal_id, then migrate to head (v20) and assert the rename happened losslessly.
function tablesNamed(db: Database.Database, like: string): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? ORDER BY name",
  ).all(like) as Array<{ name: string }>).map((r) => r.name);
}

describe("v20 goal→hitch rename migration", () => {
  it("renames every goal_* table to hitch_* preserving rows, with no goal_* left", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrationsUpTo(db, 19); // <-- see Step 3 note: expose this helper if absent
    // seed a session + a linked finding (ids chosen to survive the rename)
    db.prepare(
      "INSERT INTO goal_sessions (goal_id, title, status, created_at, updated_at) VALUES ('g1','t','open','2026-01-01','2026-01-01')",
    ).run();
    const beforeSessions = (db.prepare("SELECT COUNT(*) n FROM goal_sessions").get() as { n: number }).n;

    runMigrations(db); // to head (v20)

    expect(tablesNamed(db, "goal_%")).toEqual([]); // no goal_* tables remain
    expect(tablesNamed(db, "hitch_%").length).toBeGreaterThanOrEqual(6);
    const afterSessions = (db.prepare("SELECT COUNT(*) n FROM hitch_sessions").get() as { n: number }).n;
    expect(afterSessions).toBe(beforeSessions);
    // the renamed column exists and FKs are consistent
    expect(() => db.prepare("SELECT hitch_id FROM hitch_sessions").get()).not.toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("renames workspaces.goal_id / workspace_checkpoints.goal_id to hitch_id", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() => db.prepare("SELECT hitch_id FROM workspaces LIMIT 0").get()).not.toThrow();
    expect(() => db.prepare("SELECT hitch_id FROM workspace_checkpoints LIMIT 0").get()).not.toThrow();
  });
});
```

> If `runMigrationsUpTo(db, n)` does not exist, either add a tiny exported helper in `migrations.ts` that applies `MIGRATIONS.filter(m => m.version <= n)`, or build the v19 schema by running all migrations except the new v20 (e.g. temporarily slice). Verify the actual `runMigrations` signature/exports in `src/db/migrations.ts` first.

- [ ] **Step 3: Run it, confirm FAIL** (hitch_* tables don't exist yet).

- [ ] **Step 4: Add `MIGRATION_V20_STATEMENTS` to `src/db/migrations.ts`**

Use the identifiers from Step 1. Pattern (fill in the real index defs from Step 1 — recreate each index that referenced a goal table/column, under `hitch_*` names):

```typescript
const MIGRATION_V20_STATEMENTS = [
  // tables (RENAME TO auto-rewrites FK clauses in SQLite 3.53)
  "ALTER TABLE goal_sessions RENAME TO hitch_sessions",
  "ALTER TABLE goal_attempts RENAME TO hitch_attempts",
  "ALTER TABLE goal_review_cycles RENAME TO hitch_review_cycles",
  "ALTER TABLE goal_findings RENAME TO hitch_findings",
  "ALTER TABLE goal_close_checks RENAME TO hitch_close_checks",
  "ALTER TABLE goal_convergence_decisions RENAME TO hitch_convergence_decisions",
  // goal_id columns → hitch_id (8: the 6 tables + workspace links)
  "ALTER TABLE hitch_sessions RENAME COLUMN goal_id TO hitch_id",
  "ALTER TABLE hitch_attempts RENAME COLUMN goal_id TO hitch_id",
  "ALTER TABLE hitch_review_cycles RENAME COLUMN goal_id TO hitch_id",
  "ALTER TABLE hitch_findings RENAME COLUMN goal_id TO hitch_id",
  "ALTER TABLE hitch_close_checks RENAME COLUMN goal_id TO hitch_id",
  "ALTER TABLE hitch_convergence_decisions RENAME COLUMN goal_id TO hitch_id",
  "ALTER TABLE workspaces RENAME COLUMN goal_id TO hitch_id",
  "ALTER TABLE workspace_checkpoints RENAME COLUMN goal_id TO hitch_id",
  // indexes: ALTER TABLE RENAME TO does NOT rename indexes — drop + recreate.
  // List EVERY goal index from Step 1; recreate under hitch_* names on the
  // renamed tables/columns. Example:
  "DROP INDEX IF EXISTS goal_sessions_status_idx",
  "CREATE INDEX hitch_sessions_status_idx ON hitch_sessions(status)",
  // … repeat DROP/CREATE for every index enumerated in Step 1 …
] as const;
```

Add the entry to `MIGRATIONS`:
```typescript
{ version: 20, name: "rename-goal-to-hitch", statements: MIGRATION_V20_STATEMENTS },
```

- [ ] **Step 5: Update `src/db/schema.ts` so a FRESH DB builds `hitch_*` directly**

The v16/v17/v18 CREATE TABLE/INDEX statements in `schema.ts` still say `goal_*`. A fresh DB runs all migrations including v20, so it would create `goal_*` then rename — that works but is wasteful and confusing. Rename the `goal_*` table names, `goal_id` columns, and index names to `hitch_*` **inside the v16/v17/v18 statement blocks** in `schema.ts`. Then v20's `RENAME` only fires on DBs that were already at v16–v19 (real upgrades). **Verify**: a fresh in-memory `runMigrations` ends with `hitch_*` and no `goal_*` (the migration test's second case covers this), AND `PRAGMA foreign_key_check` is empty.

> Subtlety: if v20 `ALTER TABLE goal_sessions RENAME TO …` runs on a fresh DB where schema.ts already created `hitch_sessions`, it errors ("no such table goal_sessions"). Guard each v20 rename with existence, OR (simpler) keep schema.ts creating `goal_*` and let v20 always rename. **Choose the simpler path: leave schema.ts's goal_* CREATEs as-is and let v20 rename on every DB.** Then Step 5 is a no-op — delete it. (Confirm the fresh-DB test still passes.)

- [ ] **Step 6: Run the migration test, confirm PASS. Typecheck. Commit.**
```bash
npm run typecheck
git add src/db/migrations.ts tests/unit/db/migrate-v20-hitch-rename.test.ts
git commit -m "feat: v20 migration renames goal_* tables/columns/indexes to hitch_* (SP-0)"
```

---

## Task 2: core / repository layer rename

**Files:**
- Rename dir: `src/goal/` → `src/hitch/` (22 files); update every importer of `../goal/…` → `../hitch/…`.
- Symbols: `GoalRepository` → `HitchRepository`, `GoalSession` → `HitchSession`, `Goal*` convergence types → `Hitch*`, `goalId` → `hitchId`, SQL string literals `goal_sessions`/`goal_attempts`/`goal_findings`/`goal_close_checks`/`goal_review_cycles`/`goal_convergence_decisions`/`goal_id` → `hitch_*`.
- Tests: rename `tests/unit/goal/` → `tests/unit/hitch/`; update references.

- [ ] **Step 1: Do the directory + symbol rename**

```bash
git mv src/goal src/hitch
git mv tests/unit/goal tests/unit/hitch
```
Then rename the convergence-session symbols and SQL literals across `src/hitch/`, and every file that imports them (use the survey: `grep -rl "src/goal\|from \"../goal\|GoalRepository\|GoalSession\|goalId\|goal_sessions" src tests`). **Do not touch** the task-sense `goal` per the Boundary rule — in `src/cli/run.ts`, `src/core/workflow-runner.ts`, `rerun.ts`, `prompt-builder.ts`, `reviewed-run-workflow.ts`, `pr-creator.ts`, `backlog`, change ONLY symbols that mean a convergence session, never the coding-task `goal` text/field.

- [ ] **Step 2: Typecheck — fix every import/type error until clean**

Run: `npm run typecheck`
Expected: clean. Each error points at a missed `goal`→`hitch` reference (or a wrongly-renamed task-sense one — revert those).

- [ ] **Step 3: Run the hitch unit tests (ported) + the DB tests**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/hitch tests/unit/db`
Expected: all green (behaviour identical). Fix any SQL literal still saying `goal_*`.

- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "refactor: rename goal core/repository to hitch (src/goal -> src/hitch) (SP-0)"
```

---

## Task 3: CLI rename + erroring `goal` stub

**Files:**
- Rename: `src/cli/goal.ts` → `src/cli/hitch.ts`; `registerGoalCommands` → `registerHitchCommands`; command `"goal"` → `"hitch"`.
- Modify: `src/cli/run.ts` (the `registerGoalCommands(program)` call + import) + add the erroring `goal` stub.
- Test: `tests/integration/hitch-cli-*.test.ts` (rename existing goal CLI tests); `tests/integration/goal-renamed-stub.test.ts` (new).

- [ ] **Step 1: Write the failing stub test `tests/integration/goal-renamed-stub.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

function runCli(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync("npx", ["tsx", "src/cli/run.ts", ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? 1, stderr: String(err.stderr ?? "") };
  }
}

describe("renamed goal command", () => {
  it("errors with guidance pointing at 'harness hitch'", () => {
    const { code, stderr } = runCli(["goal", "status", "x"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/renamed to "hitch"|use 'harness hitch'/i);
  });
});
```
> Confirm how the repo invokes the CLI in tests (it may use a built `dist` or `tsx`); mirror an existing CLI integration test's invocation instead of the `tsx` guess above.

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Rename the CLI + add the stub**

```bash
git mv src/cli/goal.ts src/cli/hitch.ts
git mv tests/integration/goal-cli.test.ts tests/integration/hitch-cli.test.ts   # + any other goal CLI tests
```
In `src/cli/hitch.ts`: `registerGoalCommands` → `registerHitchCommands`, `.command("goal")` → `.command("hitch")`. In `src/cli/run.ts`: import `registerHitchCommands` and call it; then register the stub:
```typescript
program
  .command("goal", { hidden: true })
  .allowUnknownOption()
  .description("(removed) renamed to 'harness hitch'")
  .action(() => {
    process.stderr.write(
      "harness error: goal mode was renamed to \"hitch\" — use 'harness hitch …'\n",
    );
    process.exit(1);
  });
```

- [ ] **Step 4: Run the stub test + ported hitch CLI tests + typecheck**
```bash
npm run typecheck
HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/goal-renamed-stub.test.ts tests/integration/hitch-cli.test.ts
```
Expected: green. Update test references `harness goal` → `harness hitch`.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor: rename 'harness goal' CLI to 'harness hitch' + erroring goal stub (SP-0)"
```

---

## Task 4: MCP rename — tools, ops, resources, prompts, confirmation defaults, stale-config detection

**Files:**
- Rename: `src/mcp/tools/goal-tools.ts` → `hitch-tools.ts`; tool names `harness.goal.*` → `harness.hitch.*` (16); operation strings `goal.*` → `hitch.*`; `GoalLinkedMutationKind` value `goal.orchestrate` → `hitch.orchestrate`.
- Modify: `src/mcp/registry/resource-registry.ts` (`harness://goal/{goalId}` → `harness://hitch/{hitchId}`), `src/mcp/registry/prompt-registry.ts` (`drive_goal_convergence` → `drive_hitch_convergence` + embedded tool names), `src/mcp/security/config.ts` (`DEFAULT_MCP_CONFIG.requireConfirmation` `goal.*` → `hitch.*`; add stale-config detection).
- Test: extend `tests/unit/mcp/server-skeleton.test.ts`; new `tests/unit/mcp/hitch-confirmation-and-stale.test.ts`.

- [ ] **Step 1: Write the failing tests `tests/unit/mcp/hitch-confirmation-and-stale.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { DEFAULT_MCP_CONFIG, loadMcpConfigFromObject } from "../../../src/mcp/security/config.js";
import { decideMcpPermission } from "../../../src/mcp/security/permissions.js";

describe("hitch confirmation defaults + stale goal config detection (SP-0)", () => {
  it("hitch.close/cancel/expand_scope require confirmation by default", () => {
    for (const op of ["hitch.close", "hitch.cancel", "hitch.expand_scope"]) {
      expect(DEFAULT_MCP_CONFIG.requireConfirmation).toContain(op);
    }
    expect(DEFAULT_MCP_CONFIG.requireConfirmation).not.toContain("goal.close");
  });

  it("loading a config with a stale goal.* operation is warned or refused (fail-closed)", () => {
    // adjust to the real loader API; assert it throws OR surfaces a warning for goal.*
    expect(() =>
      loadMcpConfigFromObject({ mcp: { requireConfirmation: ["goal.close"] } }),
    ).toThrow(/renamed|goal\.|hitch/i);
  });
});
```
> Verify the real config-loader entry point (`loadMcpConfig` reads a file; there may be a parse helper). If there is no object-level loader, test the stale-detection function directly (extract one). Match the actual API.

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Do the MCP rename**

```bash
git mv src/mcp/tools/goal-tools.ts src/mcp/tools/hitch-tools.ts
```
Rename across `src/mcp/`: the 16 tool names + operation strings `goal.*` → `hitch.*`; `goal.orchestrate` → `hitch.orchestrate` in `src/goal/…` → now `src/hitch/mutation-gate.ts` (already moved in Task 2 — ensure its `GoalLinkedMutationKind` union value renamed); resource template + resolver in `resource-registry.ts`; prompt id + body tool names in `prompt-registry.ts`; `DEFAULT_MCP_CONFIG.requireConfirmation` entries in `config.ts`.

- [ ] **Step 4: Add stale-config detection in `src/mcp/security/config.ts`**

After parsing a config, scan its `allowedOperations` / `requireConfirmation` / `deniedOperations` for any entry matching `/^goal\./`; if found, throw (or emit a loud warning via the config's existing error path) with: `MCP config uses renamed operation "<op>" — goal.* was renamed to hitch.* (update .harness/mcp.yaml)`. Fail-closed: a stale confirmation entry must not silently disable the gate. Show the exact code:
```typescript
function assertNoRenamedGoalOps(cfg: { allowedOperations?: string[]; requireConfirmation?: string[]; deniedOperations?: string[] }): void {
  const stale = [
    ...(cfg.allowedOperations ?? []),
    ...(cfg.requireConfirmation ?? []),
    ...(cfg.deniedOperations ?? []),
  ].filter((op) => op.startsWith("goal."));
  if (stale.length > 0) {
    throw new McpConfigError(
      `MCP config uses renamed operations [${stale.join(", ")}] — "goal.*" was ` +
        `renamed to "hitch.*". Update .harness/mcp.yaml.`,
    );
  }
}
```
Call it from the config-load path (after the zod parse, before returning). Use the real `McpConfigError` symbol.

- [ ] **Step 5: Extend `tests/unit/mcp/server-skeleton.test.ts`**

Assert `toolNames` contains `harness.hitch.start` and does NOT contain `harness.goal.start`; assert the `harness://hitch/{hitchId}` resource template and `drive_hitch_convergence` prompt appear.

- [ ] **Step 6: Run the MCP tests + typecheck**
```bash
npm run typecheck
HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/mcp
```
Expected: green.

- [ ] **Step 7: Commit**
```bash
git add -A
git commit -m "refactor: rename MCP goal.* to hitch.* (tools/ops/resource/prompt/confirmation) + stale-config detection (SP-0)"
```

---

## Task 5: lockstep hardcoded refs

**Files:**
- `src/core/automerge-tiers.ts` — `{ glob: "src/goal/**", tier: 2 }` → `"src/hitch/**"`.
- `src/release/release-git.ts` — `CLI_PATHS`: `src/cli/goal.ts` → `src/cli/hitch.ts`.
- `src/onboard/step-impls.ts` — the generated/guided `goal.start` / `harness.goal.start` → `hitch.start`.

- [ ] **Step 1: Apply the three edits** (exact strings above).

- [ ] **Step 2: Update the onboard tests** that assert `goal.start` (e.g. `tests/integration/onboard-steps.test.ts` opt-in test asserting `allowedOperations: ["goal.start"]`) → `["hitch.start"]`, and the round-trip test's `harness.goal.start` → `harness.hitch.start`.

- [ ] **Step 3: Run affected tests + typecheck**
```bash
npm run typecheck
HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/core tests/integration/onboard-steps.test.ts tests/integration/onboard-cli.test.ts
```
Expected: green.

- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "refactor: update lockstep refs (automerge glob, release CLI_PATHS, onboard) goal->hitch (SP-0)"
```

---

## Task 6: docs

**Files:**
- Rename: `docs/specs/goal-convergence.md` → `docs/specs/hitch-convergence.md` (and fix inbound links from `docs/specs/README.md`, `overview.md`, `cli.md`, `mcp.md`, `db.md`, `workflow.md`, etc.).
- Update vocabulary (convergence-session sense) in: `docs/specs/*` that mention goal, `README.md`, `CLAUDE.md`, `GOAL.md`, `GOAL_RULES.md`, `AGENTS.md`, `docs/future-features.md`.
- Leave historical as-is: `docs/reports/`, prior `docs/superpowers/{plans,specs}` (except this SP-0 pair).

- [ ] **Step 1: Rename the spec doc + fix links**
```bash
git mv docs/specs/goal-convergence.md docs/specs/hitch-convergence.md
```
Update the link table in `CLAUDE.md` and any `goal-convergence.md` references across `docs/`.

- [ ] **Step 2: Update vocabulary** — replace the convergence-session `harness goal`/`goal session`/`goal_*`/`harness.goal.*` with hitch equivalents in the specs + `CLAUDE.md`/`GOAL.md`/`GOAL_RULES.md`/`AGENTS.md`/`README.md`/`future-features.md`. Do NOT touch the task-sense `goal` (`--goal`, backlog goal). Note in `GOAL.md`/`GOAL_RULES.md` that the roadmap files themselves are superseded by SP-1 (a one-line pointer is enough; SP-1 does the actual move).

- [ ] **Step 3: Sanity grep — no stray convergence-sense goal in docs/specs**
```bash
grep -rnE "harness goal |harness\.goal\.|goal_sessions|goal-convergence" docs/specs/ || echo "clean"
```
Expected: clean (only task-sense `--goal` may remain).

- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "docs: rename goal-convergence vocabulary to hitch (SP-0)"
```

---

## Task 7: full sweep verification + suite + consistency

- [ ] **Step 1: Stray-reference sweep (convergence sense only)**
```bash
grep -rnE "goal_sessions|goal_attempts|goal_findings|goal_close_checks|goal_review_cycles|goal_convergence|harness\.goal\.|GoalRepository|GoalSession|\bgoalId\b" src tests | grep -v "task-sense" 
```
Expected: empty. Each hit is a missed rename — fix it. (Confirm none are the deliberately-kept task-sense; e.g. `recoverGoal`, `--goal`, `backlog_items.goal` are allowed and should NOT appear in this pattern anyway.)

- [ ] **Step 2: db check-consistency on a migrated DB** — confirm it stays green (the consistency checks don't reference goal tables, so this is a pure regression check). Use an existing consistency test or a temp DB through `runMigrations`.

- [ ] **Step 3: Full suite + typecheck**
```bash
npm run typecheck
HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run --poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1
```
Expected: full suite green, no skips/weakening. This is the primary correctness signal for the rename.

- [ ] **Step 4: Commit any final fixes**
```bash
git add -A
git commit -m "test: final goal->hitch sweep + full-suite green (SP-0)"
```

---

## Notes for the implementer

- **Verify signatures before trusting this plan's code**: the migration helper (`runMigrationsUpTo`), the CLI test invocation style, the MCP config loader API, and `McpConfigError` — open the real files and match them. The plan's new-code blocks are grounded but not compile-checked.
- **Order matters**: migration (Task 1) first so the DB tests have `hitch_*`; then core; then CLI/MCP; lockstep + docs last. Keep the build green after each task.
- **The boundary is the biggest risk**: a file-wide `goal`→`hitch` sed will corrupt `--goal`, `backlog_items.goal`, `recoverGoal`. Rename by symbol/SQL-literal, not by word. When in doubt, leave it and let typecheck/tests guide.
- **No behaviour change**: if any behavioural test needs its *expected values* changed (beyond renamed identifiers/table names), stop — that means the rename altered semantics, which is a bug.
```
