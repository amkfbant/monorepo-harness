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
grep -nE "CREATE( UNIQUE)? INDEX [a-z_]*goal" src/db/schema.ts        # ALL goal indexes incl UNIQUE/partial
grep -nE "goal_id" src/db/schema.ts                                   # every goal_id column
```
Expected: 6 tables; **10 indexes — TWO of which are `CREATE UNIQUE INDEX`** (`goal_review_cycles_unique_idx`, and `goal_findings_stable_idx` which is **partial: `… WHERE duplicate_of IS NULL`**); 8 `goal_id` columns (the 6 tables + `workspaces` + `workspace_checkpoints`). **Copy each index's full definition verbatim** (UNIQUE keyword and any `WHERE` clause) — dropping a UNIQUE/partial clause silently removes a data-integrity constraint.

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
    // no goal_* INDEX left behind (RENAME TO does not rename indexes), and the
    // 10 indexes were recreated under hitch_* names (incl. the 2 UNIQUE ones)
    const idx = (like: string) => (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?",
    ).all(like) as Array<{ name: string }>).map((r) => r.name);
    expect(idx("goal_%")).toEqual([]);
    expect(idx("hitch_%").length).toBe(10);
  });

  it("is idempotent: re-running runMigrations on a migrated DB does not throw (SCHEMA_VERSION is 20)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow(); // would throw if SCHEMA_VERSION stayed 19
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

- [ ] **Step 4: Add `MIGRATION_V20_STATEMENTS` (in `schema.ts`, per convention) + bump `SCHEMA_VERSION`**

Convention: the existing `MIGRATION_V*_STATEMENTS` consts live in `src/db/schema.ts` and `migrations.ts` imports them — follow that (define `MIGRATION_V20_STATEMENTS` in `schema.ts`, import + add the entry in `migrations.ts`). **Also bump `SCHEMA_VERSION` in `schema.ts` from 19 → 20** — `runMigrations` throws "schema version 20 newer than supported" on a migrated DB if you forget (the idempotency test above guards this).

Use the identifiers from Step 1. Recreate each index with its **verbatim** definition (UNIQUE / partial `WHERE`), under `hitch_*` names:

```typescript
export const MIGRATION_V20_STATEMENTS = [
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
  // List ALL 10 from Step 1; recreate VERBATIM (keep UNIQUE + partial WHERE).
  "DROP INDEX IF EXISTS goal_sessions_status_idx",
  "CREATE INDEX hitch_sessions_status_idx ON hitch_sessions(status)",
  // the two UNIQUE indexes must keep UNIQUE (+ the partial WHERE), e.g.:
  "DROP INDEX IF EXISTS goal_findings_stable_idx",
  "CREATE UNIQUE INDEX hitch_findings_stable_idx ON hitch_findings(hitch_id, stable_key) WHERE duplicate_of IS NULL",
  "DROP INDEX IF EXISTS goal_review_cycles_unique_idx",
  "CREATE UNIQUE INDEX hitch_review_cycles_unique_idx ON hitch_review_cycles(/* copy the exact columns from Step 1 */)",
  // … DROP/CREATE for every remaining index enumerated in Step 1 …
] as const;
```
> Copy the exact column lists / WHERE clauses from the real definitions found in Step 1 — the snippet above shows the shape, not the final columns.

Add the entry to `MIGRATIONS` (in `migrations.ts`):
```typescript
{ version: 20, name: "rename-goal-to-hitch", statements: MIGRATION_V20_STATEMENTS },
```

- [ ] **Step 5: Leave the v16–v18 `goal_*` CREATEs in `schema.ts` as-is (v20 always renames)**

`Migration.statements` are plain SQL strings (no conditionals; SQLite has no
`ALTER TABLE IF EXISTS`). So the v20 `ALTER TABLE goal_sessions RENAME TO …`
must find a `goal_sessions` table — meaning a **fresh** DB must still CREATE
`goal_*` (from schema.ts's v16–v18 blocks) and then v20 renames it. **Do NOT
rename the v16–v18 CREATE statements** — if you did, v20 would fail on a fresh DB
with "no such table goal_sessions". This is deliberate; Task 7's sweep allowlists
these blocks. (`V16_TABLE_NAMES` in schema.ts is a separate concern — see Task 7.)

- [ ] **Step 6: Update the existing DB tests + workspace SQL so `tests/unit/db` stays green, then commit**

After v20, these existing assertions break and must be updated in THIS task (the
plan's "green after each task" rule):
- `tests/unit/db/migrations-v16.test.ts`, `migrations-v17.test.ts`,
  `migrations-v18.test.ts` — any assertion/INSERT against `goal_*` tables → `hitch_*`.
- `tests/unit/db/workspaces.test.ts` — `goal_id` references → `hitch_id`.
- `src/db/repositories/workspaces.ts` — the SQL literals `goal_id` (UPDATE/INSERT/
  SELECT, ~lines 202/232) → `hitch_id`, and the row-map field `r.goal_id` →
  `r.hitch_id` (typecheck will NOT catch a stale `r.goal_id ?? null` — it silently
  becomes null, dropping the link; grep for `goal_id` in this file and fix every one).

```bash
npm run typecheck
HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/db
git add -A
git commit -m "feat: v20 migration renames goal_* to hitch_* (tables/cols/indexes) + bump SCHEMA_VERSION (SP-0)"
```
Expected: `tests/unit/db` fully green, typecheck clean.

---

## Task 2: core / repository layer rename

**Files:**
- Rename dir: `src/goal/` → `src/hitch/` (22 files); update every importer of `../goal/…` → `../hitch/…`.
- Symbols: `GoalRepository` → `HitchRepository`, `GoalSession` → `HitchSession`, `Goal*` convergence types → `Hitch*`, `goalId` → `hitchId`, SQL string literals `goal_sessions`/`goal_attempts`/`goal_findings`/`goal_close_checks`/`goal_review_cycles`/`goal_convergence_decisions`/`goal_id` → `hitch_*`.
- **Workspace source layer** (convergence-sense link): `git mv src/workspace/workspace-goal-link.ts src/workspace/workspace-hitch-link.ts`; rename `goalId`/`Goal*`/`goal_id` in `src/workspace/workspace-status*.ts`, `workspace-recover.ts`, and the workspace MCP tools `src/mcp/tools/workspace-{tools,read-tools,tracked-repo}.ts` (the convergence-session link only — NOT the workspace concept itself). (`repositories/workspaces.ts` SQL was already done in Task 1.)
- Tests: rename `tests/unit/goal/` → `tests/unit/hitch/`; update references; update workspace tests referencing the link.

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
- Modify: `src/cli/run.ts` — the `registerGoalCommands(program, { getHarnessRoot })` call + import (note the real signature passes `{ getHarnessRoot }`); add the erroring `goal` stub; **rename the `harness workspace … --goal <id>` flag → `--hitch <id>`** (convergence-sense, a deliberate breaking change) and its `goal=` status display (run.ts ~3750/3933/4003/4095/3955).
- Test: `tests/integration/hitch-cli-*.test.ts` (rename existing goal CLI tests); `tests/integration/goal-renamed-stub.test.ts` (new); update any workspace CLI test using `--goal`.

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
  .argument("[args...]") // tolerate `goal status x …` on commander v13+ (excess-args error otherwise)
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
- Rename: `src/mcp/tools/goal-tools.ts` → `hitch-tools.ts`. The 16 tool-name definitions are in `src/mcp/registry/tool-registry.ts` (+ operation strings in `mutation-tools.ts`/`read-tools.ts`) — rename `harness.goal.*` → `harness.hitch.*` (16) and operation strings `goal.*` → `hitch.*` there; `GoalLinkedMutationKind` value `goal.orchestrate` → `hitch.orchestrate` (now in `src/hitch/mutation-gate.ts`).
- Modify: `src/mcp/registry/resource-registry.ts` (`harness://goal/{goalId}` → `harness://hitch/{hitchId}`), `src/mcp/registry/prompt-registry.ts` (`drive_goal_convergence` → `drive_hitch_convergence` + embedded tool names), `src/mcp/security/config.ts` (`DEFAULT_MCP_CONFIG.requireConfirmation` `goal.*` → `hitch.*`; add stale-config detection).
- Test: extend `tests/unit/mcp/server-skeleton.test.ts`; new `tests/unit/mcp/hitch-confirmation-and-stale.test.ts`.

- [ ] **Step 1: Write the failing tests `tests/unit/mcp/hitch-confirmation-and-stale.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../../src/mcp/security/config.js";
import { assertNoRenamedGoalOps } from "../../../src/mcp/security/config.js"; // exported in Step 4

describe("hitch confirmation defaults + stale goal config detection (SP-0)", () => {
  it("hitch.close/cancel/expand_scope require confirmation by default", () => {
    for (const op of ["hitch.close", "hitch.cancel", "hitch.expand_scope"]) {
      expect(DEFAULT_MCP_CONFIG.requireConfirmation).toContain(op);
    }
    expect(DEFAULT_MCP_CONFIG.requireConfirmation).not.toContain("goal.close");
  });

  it("a config with a stale goal.* operation is refused (fail-closed)", () => {
    expect(() =>
      assertNoRenamedGoalOps({ requireConfirmation: ["goal.close"] }),
    ).toThrow(/renamed|goal\./i);
    expect(() => assertNoRenamedGoalOps({ requireConfirmation: ["hitch.close"] })).not.toThrow();
  });
});
```
> Real config API is `loadMcpConfig(opts)` / internal `loadMcpConfigFile` / `mergeMcpConfig` (no `loadMcpConfigFromObject`). Export and unit-test the pure `assertNoRenamedGoalOps` directly (above), and separately assert it is **called from `loadMcpConfigFile` / `loadProjectProfileMcpConfig` only** — NOT from the snapshot parser (see Step 4).

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
Call it from `loadMcpConfigFile` and `loadProjectProfileMcpConfig` (the file/profile
load paths) after the zod parse. **Do NOT call it from the snapshot parser
`parseMcpConfigSnapshotJson`** — that re-verifies *past* permission snapshots
(`confirmation-runner.ts`), and a pre-rename pending confirmation carrying
`goal.*` must still resolve, not throw. Use the real `McpConfigError` symbol.

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

- [ ] **Step 1: `V16_TABLE_NAMES` — update the values to `hitch_*`**

`src/db/schema.ts` has `V16_TABLE_NAMES` (consumed by `dbStats`/`maintenance.ts`
as the list of *post-migration* table names). Leave the v16–v18 CREATE statements
alone (Task 1 Step 5) but **update `V16_TABLE_NAMES`'s values to `hitch_*`** — else
`dbStats` silently drops the 6 renamed tables from its counts (a behaviour change).
Add a comment explaining why these differ from the CREATE statements.

- [ ] **Step 2: Stray-reference sweep (convergence sense only)**
```bash
grep -rnE "goal_sessions|goal_attempts|goal_findings|goal_close_checks|goal_review_cycles|goal_convergence|harness\.goal\.|GoalRepository|GoalSession|\bgoalId\b" src tests
```
Expected: the ONLY remaining hits are the **deliberately-kept v16–v18 CREATE/index
statements in `src/db/schema.ts`** (which v20 renames at migrate time — do NOT
touch them, see Task 1 Step 5). Every other hit is a missed rename — fix it. The
task-sense `goal` (`recoverGoal`, `--goal`, `backlog_items.goal`) does not match
this pattern, so it is untouched.

- [ ] **Step 3: db check-consistency on a migrated DB** — confirm it stays green (the consistency checks don't reference goal tables, so this is a pure regression check). Use an existing consistency test or a temp DB through `runMigrations`.

- [ ] **Step 4: Full suite + typecheck**
```bash
npm run typecheck
HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run --poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1
```
Expected: full suite green, no skips/weakening. This is the primary correctness signal for the rename.

- [ ] **Step 5: Commit any final fixes**
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
