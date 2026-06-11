# `course → phase` DB Roadmap Layer (SP-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a DB-canonical `course → phase` roadmap layer above the existing `hitch_*` convergence tables, with create/read/update CLI + MCP and a deterministic rollup, so the harness manages its roadmap in the DB instead of `GOAL.md`.

**Architecture:** A v21 additive migration adds `courses` / `phases` (self-referencing tree) / `phase_hitches` (link table, `hitch_id` PK). Pure repositories in `src/roadmap/` own the tree-walk + a rollup that derives open P0/P1 **live** from `hitch_findings`. CLI `harness course`/`phase` and MCP `course-tools` (read + guarded-mutation, project-visibility gated) are thin wrappers.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite 3.53), commander, vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-course-phase-roadmap-design.md` (Fable-approved). Branch: `feat/course-phase-roadmap`.

**Conventions:** `npm run typecheck` before each commit. Tests: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run <path>`; full suite adds `--poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1`. Conventional Commits, NO Co-Authored-By. ESM `.js` imports.

**Verify signatures first:** the plan's code is grounded in real signatures (`HitchRepository.listFindings({hitchId, scopeStatus, lifecycleStatus, severity})`, `ensureProjectVisible(config, projectId)`, `runHitchOperation(context, {operationType, target, args, metadata, workWithDb})`, `MIGRATION_V20_STATEMENTS`/`SCHEMA_VERSION=20`/`ALL_TABLE_NAMES` in `schema.ts`) but open each file and confirm before trusting a snippet.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/db/schema.ts` (modify) | `MIGRATION_V21_STATEMENTS`, `SCHEMA_VERSION` 20→21, `ALL_TABLE_NAMES` += new tables |
| `src/db/migrations.ts` (modify) | import + `{version:21,…}` entry |
| `src/roadmap/types.ts` (new) | `Course` / `Phase` / `PhaseNode` / rollup types |
| `src/roadmap/course-repository.ts` (new) | course CRUD + project-scope helpers |
| `src/roadmap/phase-repository.ts` (new) | phase tree insert/walk + link + integrity |
| `src/roadmap/rollup.ts` (new) | deterministic course/phase rollup (reads `HitchRepository`) |
| `src/cli/course.ts` (new) | `harness course` / `harness phase` commands |
| `src/cli/run.ts` (modify) | register the command |
| `src/mcp/tools/course-tools.ts` (new) | read + guarded-mutation tools |
| `src/mcp/registry/tool-registry.ts` (modify) | register the tools |
| docs (modify/new) | `roadmap.md`, `db.md`, `cli.md`, `mcp.md` |

---

## Task 1: v21 migration — courses / phases / phase_hitches

**Files:** Modify `src/db/schema.ts`, `src/db/migrations.ts`; Test `tests/unit/db/migrate-v21-roadmap.test.ts`.

- [ ] **Step 1: Write the failing migration test**

```typescript
// tests/unit/db/migrate-v21-roadmap.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";

describe("v21 roadmap migration", () => {
  it("creates courses/phases/phase_hitches with FKs + the hitch_id link PK", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // tables exist
    for (const t of ["courses", "phases", "phase_hitches"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
    }
    // a hitch can be linked to exactly one phase (PK on hitch_id)
    db.prepare("INSERT INTO courses (course_id,title,status,created_at,updated_at) VALUES ('c1','C','active','t','t')").run();
    db.prepare("INSERT INTO phases (phase_id,course_id,title,position,status,created_at,updated_at) VALUES ('p1','c1','P',0,'pending','t','t')").run();
    db.prepare("INSERT INTO phases (phase_id,course_id,title,position,status,created_at,updated_at) VALUES ('p2','c1','P2',1,'pending','t','t')").run();
    // hitch_sessions has many NOT NULL columns (no defaults) — seed them all.
    // (mirror tests/unit/db/migrate-v20-hitch-rename.test.ts's full seed shape.)
    db.prepare(
      `INSERT INTO hitch_sessions (hitch_id, title, status, scope_json, close_conditions_json, policy_json,
         max_iterations, max_review_cycles, max_reruns, max_total_new_findings, created_by, created_source, created_at, updated_at)
       VALUES ('h1','H','open','{}','[]','{}',3,3,2,12,'test','cli','t','t')`,
    ).run();
    db.prepare("INSERT INTO phase_hitches (hitch_id,phase_id,linked_at) VALUES ('h1','p1','t')").run();
    expect(() =>
      db.prepare("INSERT INTO phase_hitches (hitch_id,phase_id,linked_at) VALUES ('h1','p2','t')").run(),
    ).toThrow(/UNIQUE|PRIMARY KEY/i); // hitch already linked
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("bumps SCHEMA_VERSION to 21 (re-running runMigrations does not throw)", () => {
    const db = new Database(":memory:");
    const r = runMigrations(db);
    expect(r.version).toBe(21); // confirm head version (adapt to runMigrations' return shape)
    expect(() => runMigrations(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it → FAIL** (no `courses` table).

- [ ] **Step 3: Add `MIGRATION_V21_STATEMENTS` in `schema.ts` + bump `SCHEMA_VERSION` + extend `ALL_TABLE_NAMES`**

```typescript
export const MIGRATION_V21_STATEMENTS: readonly string[] = [
  `CREATE TABLE courses (
     course_id TEXT PRIMARY KEY NOT NULL,
     project_id TEXT,
     repo_id TEXT,
     title TEXT NOT NULL,
     description TEXT,
     status TEXT NOT NULL DEFAULT 'active'
       CHECK (status IN ('active','paused','closed')),
     created_by TEXT,
     created_source TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX courses_project_idx ON courses(project_id, status)`,
  `CREATE TABLE phases (
     phase_id TEXT PRIMARY KEY NOT NULL,
     course_id TEXT NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
     parent_phase_id TEXT REFERENCES phases(phase_id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     position INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending'
       CHECK (status IN ('pending','in_progress','closed','blocked')),
     scope_json TEXT,
     close_conditions_json TEXT,
     review_state_json TEXT,
     created_by TEXT,
     created_source TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX phases_course_idx ON phases(course_id, parent_phase_id, position)`,
  `CREATE TABLE phase_hitches (
     hitch_id TEXT PRIMARY KEY NOT NULL
       REFERENCES hitch_sessions(hitch_id) ON DELETE CASCADE,
     phase_id TEXT NOT NULL REFERENCES phases(phase_id) ON DELETE CASCADE,
     linked_at TEXT NOT NULL
   )`,
  `CREATE INDEX phase_hitches_phase_idx ON phase_hitches(phase_id)`,
] as const;
```
In `schema.ts`: `export const SCHEMA_VERSION = 21;`. `ALL_TABLE_NAMES` is composed by spreading `V*_TABLE_NAMES` arrays — follow the precedent: add `export const V21_TABLE_NAMES = ["courses","phases","phase_hitches"] as const;` and spread it into `ALL_TABLE_NAMES`. In `migrations.ts`: import `MIGRATION_V21_STATEMENTS` and add `{ version: 21, name: "course-phase-roadmap", statements: MIGRATION_V21_STATEMENTS }` to `MIGRATIONS`.

Also update the **existing** `tests/unit/db/migrations.test.ts` whose `applied` assertion hardcodes `[1..20]` → add `21` (this is a legitimate expected-value update for the new migration, NOT test weakening).

- [ ] **Step 4: Run the test → PASS. Typecheck. Run `tests/unit/db` (no regression). Commit.**
```bash
npm run typecheck && HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/db
git add -A && git commit -m "feat: v21 migration adds courses/phases/phase_hitches roadmap tables (SP-1)"
```

---

## Task 2: roadmap types + Course/Phase repositories (CRUD + tree + integrity)

**Files:** Create `src/roadmap/types.ts`, `src/roadmap/course-repository.ts`, `src/roadmap/phase-repository.ts`; Test `tests/unit/roadmap/repository.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/roadmap/repository.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";

function db() {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  return d;
}

describe("Course/Phase repositories (SP-1)", () => {
  let conn: Database.Database;
  let courses: CourseRepository;
  let phases: PhaseRepository;
  beforeEach(() => { conn = db(); courses = new CourseRepository(conn); phases = new PhaseRepository(conn); });

  it("creates a course and a phase tree, listing children ordered by position", () => {
    const c = courses.create({ title: "Roadmap", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const big = phases.add({ courseId: c.courseId, title: "大 A", createdBy: "t", createdSource: "cli" });
    const subB = phases.add({ courseId: c.courseId, parentPhaseId: big.phaseId, title: "サブ B", position: 1, createdBy: "t", createdSource: "cli" });
    const subA = phases.add({ courseId: c.courseId, parentPhaseId: big.phaseId, title: "サブ A", position: 0, createdBy: "t", createdSource: "cli" });
    const tree = phases.tree(c.courseId);
    expect(tree.map((n) => n.phase.title)).toEqual(["大 A"]);
    expect(tree[0]!.children.map((n) => n.phase.title)).toEqual(["サブ A", "サブ B"]); // position order
    void subA; void subB;
  });

  it("rejects a parent from a different course (fail-closed)", () => {
    const c1 = courses.create({ title: "C1", createdBy: "t", createdSource: "cli" });
    const c2 = courses.create({ title: "C2", createdBy: "t", createdSource: "cli" });
    const p1 = phases.add({ courseId: c1.courseId, title: "P1", createdBy: "t", createdSource: "cli" });
    expect(() => phases.add({ courseId: c2.courseId, parentPhaseId: p1.phaseId, title: "X", createdBy: "t", createdSource: "cli" })).toThrow(/different course|parent/i);
  });

  it("links a hitch to a phase and rejects a second link (schema PK + repo guard)", () => {
    const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    conn.prepare(`INSERT INTO hitch_sessions (hitch_id,project_id,title,status,scope_json,close_conditions_json,policy_json,max_iterations,max_review_cycles,max_reruns,max_total_new_findings,created_by,created_source,created_at,updated_at) VALUES ('h1','demo','H','open','{}','[]','{}',3,3,2,12,'t','cli','t','t')`).run();
    phases.linkHitch(p.phaseId, "h1");
    expect(phases.hitchIdsFor(p.phaseId)).toEqual(["h1"]);
    const p2 = phases.add({ courseId: c.courseId, title: "P2", createdBy: "t", createdSource: "cli" });
    expect(() => phases.linkHitch(p2.phaseId, "h1")).toThrow(/already linked|UNIQUE|PRIMARY/i);
  });

  it("rejects linking a hitch whose project differs from the course's project (no cross-project leak)", () => {
    const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    conn.prepare(`INSERT INTO hitch_sessions (hitch_id,project_id,title,status,scope_json,close_conditions_json,policy_json,max_iterations,max_review_cycles,max_reruns,max_total_new_findings,created_by,created_source,created_at,updated_at) VALUES ('h2','other','H','open','{}','[]','{}',3,3,2,12,'t','cli','t','t')`).run();
    expect(() => phases.linkHitch(p.phaseId, "h2")).toThrow(/project/i);
  });
});
```

- [ ] **Step 2: Run it → FAIL** (modules missing).

- [ ] **Step 3: Implement `src/roadmap/types.ts`**

```typescript
export type CourseStatus = "active" | "paused" | "closed";
export type PhaseStatus = "pending" | "in_progress" | "closed" | "blocked";

export interface Course {
  courseId: string;
  projectId: string | null;
  repoId: string | null;
  title: string;
  description: string | null;
  status: CourseStatus;
  createdBy: string | null;
  createdSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Phase {
  phaseId: string;
  courseId: string;
  parentPhaseId: string | null;
  title: string;
  position: number;
  status: PhaseStatus;
  scope: unknown;            // parsed scope_json
  closeConditions: unknown;  // parsed close_conditions_json
  reviewState: unknown;      // parsed review_state_json
  createdBy: string | null;
  createdSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PhaseNode {
  phase: Phase;
  children: PhaseNode[];
}
```

- [ ] **Step 4: Implement `src/roadmap/course-repository.ts`**

```typescript
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Course, CourseStatus } from "./types.js";

interface CourseRow {
  course_id: string; project_id: string | null; repo_id: string | null;
  title: string; description: string | null; status: CourseStatus;
  created_by: string | null; created_source: string | null;
  created_at: string; updated_at: string;
}

function mapCourse(r: CourseRow): Course {
  return {
    courseId: r.course_id, projectId: r.project_id, repoId: r.repo_id,
    title: r.title, description: r.description, status: r.status,
    createdBy: r.created_by, createdSource: r.created_source,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class CourseRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    title: string; description?: string; projectId?: string; repoId?: string;
    createdBy: string; createdSource: string; now?: string;
  }): Course {
    const id = `course-${randomUUID()}`;
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(
      `INSERT INTO courses (course_id, project_id, repo_id, title, description, status, created_by, created_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(id, input.projectId ?? null, input.repoId ?? null, input.title, input.description ?? null, input.createdBy, input.createdSource, now, now);
    return this.require(id);
  }

  get(courseId: string): Course | null {
    const r = this.db.prepare("SELECT * FROM courses WHERE course_id = ?").get(courseId) as CourseRow | undefined;
    return r === undefined ? null : mapCourse(r);
  }

  require(courseId: string): Course {
    const c = this.get(courseId);
    if (c === null) throw new Error(`course ${courseId} not found`);
    return c;
  }

  list(filter: { status?: CourseStatus; projectIds?: string[] } = {}): Course[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) { where.push("status = ?"); params.push(filter.status); }
    if (filter.projectIds !== undefined) {
      // project-scoped read: only these projects (a null-project course is excluded here)
      where.push(`project_id IN (${filter.projectIds.map(() => "?").join(",")})`);
      params.push(...filter.projectIds);
    }
    const sql = `SELECT * FROM courses ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, course_id DESC`;
    return (this.db.prepare(sql).all(...params) as CourseRow[]).map(mapCourse);
  }

  setStatus(courseId: string, status: CourseStatus, now?: string): Course {
    this.require(courseId);
    this.db.prepare("UPDATE courses SET status = ?, updated_at = ? WHERE course_id = ?")
      .run(status, now ?? new Date().toISOString(), courseId);
    return this.require(courseId);
  }
}
```

- [ ] **Step 5: Implement `src/roadmap/phase-repository.ts`** (tree + integrity + link)

```typescript
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Phase, PhaseNode, PhaseStatus } from "./types.js";

interface PhaseRow {
  phase_id: string; course_id: string; parent_phase_id: string | null;
  title: string; position: number; status: PhaseStatus;
  scope_json: string | null; close_conditions_json: string | null; review_state_json: string | null;
  created_by: string | null; created_source: string | null; created_at: string; updated_at: string;
}

function parse(text: string | null): unknown { return text === null ? null : JSON.parse(text); }

function mapPhase(r: PhaseRow): Phase {
  return {
    phaseId: r.phase_id, courseId: r.course_id, parentPhaseId: r.parent_phase_id,
    title: r.title, position: r.position, status: r.status,
    scope: parse(r.scope_json), closeConditions: parse(r.close_conditions_json), reviewState: parse(r.review_state_json),
    createdBy: r.created_by, createdSource: r.created_source, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class PhaseRepository {
  constructor(private readonly db: Database.Database) {}

  add(input: {
    courseId: string; parentPhaseId?: string; title: string; position?: number;
    scope?: unknown; closeConditions?: unknown;
    createdBy: string; createdSource: string; now?: string;
  }): Phase {
    // integrity: parent must exist AND be in the same course
    if (input.parentPhaseId !== undefined) {
      const parent = this.db.prepare("SELECT course_id FROM phases WHERE phase_id = ?").get(input.parentPhaseId) as { course_id: string } | undefined;
      if (parent === undefined) throw new Error(`parent phase ${input.parentPhaseId} not found`);
      if (parent.course_id !== input.courseId) throw new Error(`parent phase ${input.parentPhaseId} is in a different course`);
    }
    const id = `phase-${randomUUID()}`;
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(
      `INSERT INTO phases (phase_id, course_id, parent_phase_id, title, position, status, scope_json, close_conditions_json, created_by, created_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.courseId, input.parentPhaseId ?? null, input.title, input.position ?? 0,
      input.scope === undefined ? null : JSON.stringify(input.scope),
      input.closeConditions === undefined ? null : JSON.stringify(input.closeConditions),
      input.createdBy, input.createdSource, now, now);
    return this.require(id);
  }

  get(phaseId: string): Phase | null {
    const r = this.db.prepare("SELECT * FROM phases WHERE phase_id = ?").get(phaseId) as PhaseRow | undefined;
    return r === undefined ? null : mapPhase(r);
  }
  require(phaseId: string): Phase {
    const p = this.get(phaseId);
    if (p === null) throw new Error(`phase ${phaseId} not found`);
    return p;
  }

  listForCourse(courseId: string): Phase[] {
    return (this.db.prepare(
      "SELECT * FROM phases WHERE course_id = ? ORDER BY position ASC, phase_id ASC",
    ).all(courseId) as PhaseRow[]).map(mapPhase);
  }

  /** Build the phase forest for a course (deterministic: position then phase_id). */
  tree(courseId: string): PhaseNode[] {
    const all = this.listForCourse(courseId);
    const byParent = new Map<string | null, Phase[]>();
    for (const p of all) {
      const k = p.parentPhaseId;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(p);
    }
    const build = (parentId: string | null): PhaseNode[] =>
      (byParent.get(parentId) ?? []).map((phase) => ({ phase, children: build(phase.phaseId) }));
    return build(null);
  }

  setStatus(phaseId: string, status: PhaseStatus, now?: string): Phase {
    this.require(phaseId);
    this.db.prepare("UPDATE phases SET status = ?, updated_at = ? WHERE phase_id = ?")
      .run(status, now ?? new Date().toISOString(), phaseId);
    return this.require(phaseId);
  }

  /** Link a hitch to a phase. Rejects a project mismatch and a double-link (PK). */
  linkHitch(phaseId: string, hitchId: string, now?: string): void {
    const phase = this.require(phaseId);
    const course = this.db.prepare("SELECT project_id FROM courses WHERE course_id = ?").get(phase.courseId) as { project_id: string | null } | undefined;
    const hitch = this.db.prepare("SELECT project_id FROM hitch_sessions WHERE hitch_id = ?").get(hitchId) as { project_id: string | null } | undefined;
    if (hitch === undefined) throw new Error(`hitch ${hitchId} not found`);
    if (course?.project_id != null && hitch.project_id !== course.project_id) {
      throw new Error(`hitch ${hitchId} project (${hitch.project_id}) differs from course project (${course.project_id})`);
    }
    try {
      this.db.prepare("INSERT INTO phase_hitches (hitch_id, phase_id, linked_at) VALUES (?, ?, ?)")
        .run(hitchId, phaseId, now ?? new Date().toISOString());
    } catch (e) {
      // only the PK violation means "already linked"; rethrow anything else.
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new Error(`hitch ${hitchId} is already linked to a phase`, { cause: e });
      }
      throw e;
    }
  }

  unlinkHitch(hitchId: string): void {
    this.db.prepare("DELETE FROM phase_hitches WHERE hitch_id = ?").run(hitchId);
  }

  hitchIdsFor(phaseId: string): string[] {
    return (this.db.prepare("SELECT hitch_id FROM phase_hitches WHERE phase_id = ? ORDER BY linked_at ASC, hitch_id ASC").all(phaseId) as Array<{ hitch_id: string }>).map((r) => r.hitch_id);
  }
}
```

- [ ] **Step 6: Run the test → PASS. Typecheck. Commit.**
```bash
npm run typecheck && HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap
git add -A && git commit -m "feat: course/phase repositories — tree + integrity + hitch link (SP-1)"
```

---

## Task 3: deterministic rollup (`src/roadmap/rollup.ts`)

The rollup walks a course's phase tree and, for each phase, derives the linked hitches' **live** open in-scope P0/P1 from `HitchRepository.listFindings` — never from a stored snapshot, so a declared phase status cannot hide findings.

**Files:** Create `src/roadmap/rollup.ts`; Test `tests/unit/roadmap/rollup.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/roadmap/rollup.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { rollupCourse } from "../../../src/roadmap/rollup.js";

describe("rollupCourse (SP-1)", () => {
  let conn: Database.Database;
  beforeEach(() => { conn = new Database(":memory:"); conn.pragma("foreign_keys = ON"); runMigrations(conn); });

  it("derives open in-scope P0/P1 live from hitch_findings (declared status cannot hide them)", () => {
    const courses = new CourseRepository(conn); const phases = new PhaseRepository(conn); const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({ title: "H", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, h.hitchId);
    // record an open in-scope P1 finding (UpsertHitchFindingInput requires `source`)
    hitches.upsertFinding({ hitchId: h.hitchId, severity: "P1", source: "human", category: "correctness", summary: "bug", scopeStatus: "in_scope" });
    // even if the operator marks the phase "closed", the rollup still reports the open P1
    phases.setStatus(p.phaseId, "closed");
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.openP0).toBe(0);
    expect(rollup.openP1).toBeGreaterThanOrEqual(1);
    const node = rollup.phases[0]!;
    expect(node.declaredStatus).toBe("closed");
    expect(node.derivedOpenP1).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run it → FAIL.** (Verify `HitchRepository.createSession`/`upsertFinding` signatures against `src/hitch/repository.ts` and fix the test's calls to match — the finding shape especially: it needs `hitchId, severity, scopeStatus, lifecycleStatus?`.)

- [ ] **Step 3: Implement `src/roadmap/rollup.ts`**

```typescript
import type Database from "better-sqlite3";
import { HitchRepository } from "../hitch/repository.js";
import { PhaseRepository } from "./phase-repository.js";
import type { PhaseStatus } from "./types.js";

export interface PhaseRollup {
  phaseId: string;
  title: string;
  declaredStatus: PhaseStatus;
  hitchIds: string[];
  derivedOpenP0: number;
  derivedOpenP1: number;
  depth: number;
}

export interface CourseRollup {
  courseId: string;
  phases: PhaseRollup[];     // flattened, in tree pre-order
  openP0: number;
  openP1: number;
  phaseCountsByStatus: Record<PhaseStatus, number>;
}

/** Live open in-scope P0/P1 for a hitch — read from hitch_findings, never a snapshot.
 * NOTE: listFindings defaults to limit 200; pass an explicit large limit so a
 * hitch with >200 findings cannot silently hide open P0/P1 (the SP-1 invariant). */
function openCounts(hitches: HitchRepository, hitchId: string): { p0: number; p1: number } {
  const open = hitches.listFindings({ hitchId, scopeStatus: "in_scope", lifecycleStatus: "open", limit: 100_000 });
  return {
    p0: open.filter((f) => f.severity === "P0").length,
    p1: open.filter((f) => f.severity === "P1").length,
  };
}

export function rollupCourse(opts: { db: Database.Database; courseId: string }): CourseRollup {
  const phases = new PhaseRepository(opts.db);
  const hitches = new HitchRepository(opts.db);
  const tree = phases.tree(opts.courseId);
  const flat: PhaseRollup[] = [];
  const counts: Record<PhaseStatus, number> = { pending: 0, in_progress: 0, closed: 0, blocked: 0 };
  let totalP0 = 0, totalP1 = 0;
  const walk = (nodes: ReturnType<PhaseRepository["tree"]>, depth: number): void => {
    for (const n of nodes) {
      const hitchIds = phases.hitchIdsFor(n.phase.phaseId);
      let p0 = 0, p1 = 0;
      for (const hid of hitchIds) { const c = openCounts(hitches, hid); p0 += c.p0; p1 += c.p1; }
      counts[n.phase.status] += 1;
      totalP0 += p0; totalP1 += p1;
      flat.push({ phaseId: n.phase.phaseId, title: n.phase.title, declaredStatus: n.phase.status, hitchIds, derivedOpenP0: p0, derivedOpenP1: p1, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return { courseId: opts.courseId, phases: flat, openP0: totalP0, openP1: totalP1, phaseCountsByStatus: counts };
}
```

- [ ] **Step 4: Run → PASS. Typecheck. Commit.**
```bash
npm run typecheck && HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap
git add -A && git commit -m "feat: deterministic course rollup (open P0/P1 derived live from hitch_findings) (SP-1)"
```

---

## Task 4: CLI `harness course` / `harness phase`

**Files:** Create `src/cli/course.ts`; Modify `src/cli/run.ts` (register); Test `tests/integration/course-cli.test.ts`.

Mirror `src/cli/hitch.ts`'s `registerHitchCommands(program, { getHarnessRoot })` pattern (open the managed DB via `harnessPaths(root).dbPath` + `openManagedDb` + `runMigrations`, like the hitch CLI). Commands (each opens the DB, calls the repository, writes text or `--json`):
- `course create --title <t> [--description …] [--project <id>] [--repo-id <id>] [--json]`
- `course list [--status …] [--json]` / `course show <id> [--json]`
- `course status <id> [--json]` → print the `rollupCourse` result (tree with declared status + derived open P0/P1; course totals).
- `course close <id>`
- `course export <id> --md [--out <path>]` → render the rollup/phase tree as markdown (one-way).
- `phase add --course <id> [--parent <phase-id>] --title <t> [--position n] [--scope-file …] [--close-file …]`
- `phase list --course <id> [--json]` (tree) / `phase show <id> [--json]`
- `phase update <id> [--status …] [--scope-file …] [--close-file …]`
- `phase link-hitch <phase-id> <hitch-id>` / `phase unlink-hitch <hitch-id>`

- [ ] **Step 1: Write a failing integration test** that drives the CLI the way `tests/integration/hitch-cli.test.ts` does (mirror its invocation helper). Cover: create course → add 大 phase → add サブ phase → `course status` shows the tree; `phase link-hitch`; `course export --md` emits markdown with the phase titles. (Write the helper + 2-3 assertions; full code mirrors hitch-cli.test.ts.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/cli/course.ts`** (`registerCourseCommands(program, { getHarnessRoot })`) using the repositories + `rollupCourse`. Register in `run.ts` near `registerHitchCommands(program, { getHarnessRoot })`.
- [ ] **Step 4: Run → PASS. Typecheck. Commit.**
```bash
git add -A && git commit -m "feat: harness course/phase CLI (create/list/status/phase add/link/export) (SP-1)"
```

---

## Task 5: MCP `course-tools` (read + guarded-mutation, project-gated)

**Files:** Create `src/mcp/tools/course-tools.ts`; Modify `src/mcp/registry/tool-registry.ts`; Test `tests/unit/mcp/course-tools.test.ts`.

Mirror `src/mcp/tools/hitch-tools.ts`. Read tools apply `ensureProjectVisible(context.config, course.projectId)` and the list filters by `context.config.allowedProjects` (a null-project course is invisible to a project-restricted client — fail-closed). For mutations: `runHitchOperation` (`hitch-tools.ts:798`) is **module-private** — it cannot be imported as-is. **Extract the generic operation wrapper** (signature `(context, {operationType, target, args, metadata, workWithDb})`, internally `openManagedDb` + `runMigrations` + `runOperation` + `assertMutationBudget`) into a shared module (e.g. `src/mcp/tools/operation-wrapper.ts` or `tool-helpers.ts`) and have BOTH `hitch-tools.ts` and `course-tools.ts` use it. Keep the hitch behaviour identical (it's a pure extraction — run the hitch MCP tests after).

- Read: `harness.course.list`, `harness.course.get`, `harness.course.status`, `harness.phase.list`, `harness.phase.get`.
- Guarded-mutation (operation strings, deny-by-default allow-list): `course.create`, `phase.add`, `phase.update`, `phase.link_hitch`.

- [ ] **Step 1: Write the failing test** — assert: `course.list`/`course.status` registered; a project-restricted client sees only its-project courses and NOT a null-project course; `course.create` is denied by default permissions (mutation); after opt-in it works; `phase.link_hitch` rejects a cross-project hitch. Mirror `tests/unit/mcp/hitch-tools.test.ts` / `server-skeleton.test.ts`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/mcp/tools/course-tools.ts`** + register in `tool-registry.ts` (read tools `kind:"read"`, mutations `kind:"mutation"` with the operation strings; `resolveProjectIdForPermission` resolves the course's projectId like the hitch tools resolve a hitch's).
- [ ] **Step 4: Run → PASS. Typecheck. Commit.**
```bash
git add -A && git commit -m "feat: MCP course/phase tools (read + guarded-mutation, project-gated) (SP-1)"
```

---

## Task 6: docs + full suite

**Files:** Create `docs/specs/roadmap.md`; Modify `docs/specs/db.md`, `docs/specs/cli.md`, `docs/specs/mcp.md`, `CLAUDE.md`.

- [ ] **Step 1: `docs/specs/roadmap.md`** — the course→phase→hitch model, the tables, the API, the deterministic rollup (derived open P0/P1), project scope/visibility, what stays as docs (the build rules), and that SP-2 adds autonomous orchestration.
- [ ] **Step 2: `docs/specs/db.md`** — add the v21 migration row + the 3 new tables. `docs/specs/cli.md` — `harness course`/`phase` subcommands (cli.md is the canonical subcommand reference). `docs/specs/mcp.md` — the new read + mutation tools + the project-visibility rule. `CLAUDE.md` — a link-table row to `roadmap.md`.
- [ ] **Step 3: Full suite + typecheck**
```bash
npm run typecheck
HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run --poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1
```
Both green, no skips/weakening.
- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "docs: document course/phase roadmap layer (SP-1)"
```

---

## Notes for the implementer
- **Verify repository signatures before Task 3**: `HitchRepository.createSession` / `upsertFinding` / `listFindings` exact shapes (the rollup + tests depend on `listFindings({hitchId, scopeStatus, lifecycleStatus, severity})` returning findings with `.severity`/`.scopeStatus`/`.lifecycleStatus`). Fix the test seeds to match.
- **Reuse, don't reimplement**, the MCP operation wrapper and `ensureProjectVisible`; the course mutations are the same shape as hitch mutations.
- **No behaviour change to hitches**: this is purely additive. Do not modify `hitch_*` tables or `src/hitch/`.
- **Safety invariants to keep green**: rollup derives open P0/P1 live (never from a snapshot); `phase_hitches.hitch_id` PK enforces one-phase-per-hitch; cross-project link rejected; null-project course invisible to project-restricted MCP clients; mutations deny-by-default + audited.
