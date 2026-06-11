import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { CourseRepository } from "../../src/roadmap/course-repository.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import { PhaseRepository } from "../../src/roadmap/phase-repository.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(root: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: {
        ...process.env,
        HARNESS_ROOT: root,
        HARNESS_SUPPRESS_EXPORT_MODE_WARNING: "1",
      },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

function setup(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-course-cli-"));
  mkdirSync(root, { recursive: true });
  return { root };
}

function json<T>(result: { out: string; code: number }): T {
  expect(result.code, `expected exit 0, got:\n${result.out}`).toBe(0);
  return JSON.parse(result.out) as T;
}

function withSeedDb(root: string, seed: (db: ReturnType<typeof openDb>) => void): void {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    seed(db);
  } finally {
    db.close();
  }
}

function seedDrivableHitch(db: ReturnType<typeof openDb>, hitchId: string): void {
  const hitches = new HitchRepository(db);
  hitches.createSession({
    hitchId,
    title: hitchId,
    projectId: "demo",
    domain: "app",
    scope: {},
    closeConditions: [],
    createdBy: "test",
    createdSource: "cli",
  });
  hitches.upsertFinding({
    hitchId,
    severity: "P1",
    source: "human",
    category: "correctness",
    summary: "needs fix",
    scopeStatus: "in_scope",
  });
}

function seedBlockedHitch(db: ReturnType<typeof openDb>, hitchId: string): void {
  const hitches = new HitchRepository(db);
  hitches.createSession({
    hitchId,
    title: hitchId,
    scope: {},
    closeConditions: [],
    createdBy: "test",
    createdSource: "cli",
  });
  hitches.upsertFinding({
    hitchId,
    severity: "P0",
    source: "human",
    category: "correctness",
    summary: "block automation",
    scopeStatus: "in_scope",
  });
}

describe("course/phase CLI (SP-1)", () => {
  it("course orchestrate --dry-run prints phase actions without side effects", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Dry Run Course", "--json"]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--title",
        "Pending leaf",
        "--json",
      ]),
    );

    const result = runCli(root, [
      "course",
      "orchestrate",
      course.courseId,
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const dryRun = JSON.parse(result.out) as {
      courseId: string;
      dryRun: boolean;
      phaseOutcomes: Array<{ phaseId: string; action: string }>;
    };
    expect(dryRun.courseId).toBe(course.courseId);
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.phaseOutcomes).toEqual([
      { phaseId: phase.phaseId, action: "needs_link" },
    ]);

    const shown = json<{ phase: { phaseId: string; status: string } }>(
      runCli(root, ["phase", "show", phase.phaseId, "--json"]),
    );
    expect(shown.phase.status).toBe("pending");
  });

  it("course orchestrate --dry-run reflects maxDrivenHitches budget", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Dry Budget Course", "--json"]),
    );
    const p1 = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "One", "--json"]),
    );
    const p2 = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Two", "--json"]),
    );
    withSeedDb(root, (db) => {
      const phases = new PhaseRepository(db);
      seedDrivableHitch(db, "h-one");
      seedDrivableHitch(db, "h-two");
      phases.linkHitch(p1.phaseId, "h-one");
      phases.linkHitch(p2.phaseId, "h-two");
    });

    const result = runCli(root, [
      "course",
      "orchestrate",
      course.courseId,
      "--dry-run",
      "--max-driven-hitches",
      "1",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const dryRun = JSON.parse(result.out) as {
      phaseOutcomes: Array<{ phaseId: string; action: string; note?: string }>;
      drivenHitches: unknown[];
    };
    expect(dryRun.drivenHitches).toEqual([]);
    expect(new Set(dryRun.phaseOutcomes.map((outcome) => outcome.phaseId))).toEqual(
      new Set([p1.phaseId, p2.phaseId]),
    );
    expect(dryRun.phaseOutcomes.map((outcome) => outcome.action)).toEqual([
      "drive",
      "not_driven",
    ]);
    expect(dryRun.phaseOutcomes[0]).toEqual(
      expect.objectContaining({ action: "drive", drivenHitches: [] }),
    );
    expect(dryRun.phaseOutcomes[1]).toEqual(
      expect.objectContaining({
        action: "not_driven",
        drivenHitches: [],
        note: "not_driven",
      }),
    );
  });

  it("course orchestrate --dry-run reflects blocked subtree isolation", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Dry Blocked Course", "--json"]),
    );
    const parent = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Parent", "--json"]),
    );
    const child = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--parent",
        parent.phaseId,
        "--title",
        "Child",
        "--json",
      ]),
    );
    withSeedDb(root, (db) => {
      const phases = new PhaseRepository(db);
      seedBlockedHitch(db, "h-blocked");
      seedDrivableHitch(db, "h-child");
      phases.linkHitch(parent.phaseId, "h-blocked");
      phases.linkHitch(child.phaseId, "h-child");
    });

    const result = runCli(root, [
      "course",
      "orchestrate",
      course.courseId,
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const dryRun = JSON.parse(result.out) as {
      phaseOutcomes: Array<{ phaseId: string; action: string; note?: string }>;
    };
    expect(dryRun.phaseOutcomes).toEqual([
      expect.objectContaining({
        phaseId: parent.phaseId,
        action: "blocked_hitch",
        blockedHitch: expect.objectContaining({ hitchId: "h-blocked" }),
      }),
      { phaseId: child.phaseId, action: "blocked_subtree", note: "blocked_subtree" },
    ]);
  });

  it("course orchestrate prepares only actually driven hitches", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Lazy Prepare Course", "--json"]),
    );
    const parent = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Parent", "--json"]),
    );
    const child = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--parent",
        parent.phaseId,
        "--title",
        "Child",
        "--json",
      ]),
    );
    withSeedDb(root, (db) => {
      const phases = new PhaseRepository(db);
      const hitches = new HitchRepository(db);
      seedBlockedHitch(db, "h-blocked");
      hitches.createSession({
        hitchId: "h-bad-project",
        title: "bad project",
        projectId: "missing-project",
        domain: "app",
        scope: {},
        closeConditions: [],
        createdBy: "test",
        createdSource: "cli",
      });
      hitches.upsertFinding({
        hitchId: "h-bad-project",
        severity: "P1",
        source: "human",
        category: "correctness",
        summary: "would need codex if driven",
        scopeStatus: "in_scope",
      });
      phases.linkHitch(parent.phaseId, "h-blocked");
      phases.linkHitch(child.phaseId, "h-bad-project");
    });

    const result = runCli(root, ["course", "orchestrate", course.courseId, "--json"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as {
      phaseOutcomes: Array<{ phaseId: string; action: string }>;
    };
    expect(body.phaseOutcomes).toEqual([
      expect.objectContaining({ phaseId: parent.phaseId, action: "blocked_hitch" }),
      { phaseId: child.phaseId, action: "blocked_subtree", note: "blocked_subtree" },
    ]);
  });

  it("course orchestrate records project errors with project_error", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Project Error Course", "--json"]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Needs Project", "--json"]),
    );
    withSeedDb(root, (db) => {
      const phases = new PhaseRepository(db);
      const hitches = new HitchRepository(db);
      hitches.createSession({
        hitchId: "h-missing-project",
        title: "missing project",
        projectId: "missing-project",
        domain: "app",
        scope: {},
        closeConditions: [],
        createdBy: "test",
        createdSource: "cli",
      });
      hitches.upsertFinding({
        hitchId: "h-missing-project",
        severity: "P1",
        source: "human",
        category: "correctness",
        summary: "needs fix",
        scopeStatus: "in_scope",
      });
      phases.linkHitch(phase.phaseId, "h-missing-project");
    });

    const result = runCli(root, ["course", "orchestrate", course.courseId]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/project/i);
    withSeedDb(root, (db) => {
      const row = db
        .prepare(
          "SELECT status, error_code FROM operations WHERE operation_type = 'course.orchestrate' ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { status: string; error_code: string } | undefined;
      expect(row).toEqual({ status: "failed", error_code: "project_error" });
    });
  });

  it("course orchestrate on a non-active course exits 1", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Paused Course", "--json"]),
    );
    const paths = { dbPath: join(root, ".harness", "harness.sqlite") };
    const db = openDb(paths.dbPath);
    runMigrations(db);
    new CourseRepository(db).setStatus(course.courseId, "paused");
    db.close();

    const result = runCli(root, ["course", "orchestrate", course.courseId]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/not active/i);
  });

  it("creates a course, adds phases (parent/child), and rollup shows phase titles + open P0/P1", () => {
    const { root } = setup();

    // 1. Create course
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "My Course", "--json"]),
    );
    expect(course.courseId).toMatch(/^course-/);

    // 2. Add parent phase
    const parentPhase = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--title",
        "Phase Alpha",
        "--json",
      ]),
    );
    expect(parentPhase.phaseId).toMatch(/^phase-/);

    // 3. Add child phase with --parent
    const childPhase = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--parent",
        parentPhase.phaseId,
        "--title",
        "Phase Beta (child)",
        "--json",
      ]),
    );
    expect(childPhase.phaseId).toMatch(/^phase-/);

    // 4. course status — should contain both phase titles and open P0/P1 keys
    const statusResult = runCli(root, ["course", "status", course.courseId, "--json"]);
    expect(statusResult.code).toBe(0);
    const status = JSON.parse(statusResult.out) as {
      courseId: string;
      phases: Array<{ title: string; derivedOpenP0: number; derivedOpenP1: number; depth: number }>;
      openP0: number;
      openP1: number;
    };
    expect(status.courseId).toBe(course.courseId);
    const titles = status.phases.map((p) => p.title);
    expect(titles).toContain("Phase Alpha");
    expect(titles).toContain("Phase Beta (child)");
    expect(status.openP0).toBe(0);
    expect(status.openP1).toBe(0);
    // child has depth 1
    const child = status.phases.find((p) => p.title === "Phase Beta (child)")!;
    expect(child.depth).toBe(1);

    const humanStatus = runCli(root, ["course", "status", course.courseId]);
    expect(humanStatus.code).toBe(0);
    const parentLine = humanStatus.out
      .split("\n")
      .find((line) => line.includes(`phase=${parentPhase.phaseId}`));
    expect(parentLine).toContain("readyToClose=false");
  });

  it("phase link-hitch links a seeded hitch and phase show reflects it", () => {
    const { root } = setup();

    // Seed a hitch directly via DB
    const paths = { dbPath: join(root, ".harness", "harness.sqlite") };
    mkdirSync(join(root, ".harness"), { recursive: true });
    const db = openDb(paths.dbPath);
    runMigrations(db);
    const hitches = new HitchRepository(db);
    const h = hitches.createSession({
      title: "Seeded hitch",
      scope: {},
      closeConditions: [],
      createdBy: "test",
      createdSource: "cli",
    });
    db.close();

    // Create course + phase
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Link Test", "--json"]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Ph", "--json"]),
    );

    // Link hitch to phase
    const linkResult = runCli(root, ["phase", "link-hitch", phase.phaseId, h.hitchId]);
    expect(linkResult.code).toBe(0);

    // phase show should list the hitch
    const showResult = runCli(root, ["phase", "show", phase.phaseId, "--json"]);
    expect(showResult.code).toBe(0);
    const shown = JSON.parse(showResult.out) as { phase: { phaseId: string }; hitchIds: string[] };
    expect(shown.hitchIds).toContain(h.hitchId);
  });

  it("course export --md emits markdown with phase titles", () => {
    const { root } = setup();

    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Export Course", "--json"]),
    );
    runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Phase Gamma", "--json"]);
    runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Phase Delta", "--json"]);

    const mdResult = runCli(root, ["course", "export", course.courseId, "--md"]);
    expect(mdResult.code).toBe(0);
    expect(mdResult.out).toContain("Phase Gamma");
    expect(mdResult.out).toContain("Phase Delta");
    // Should be markdown (has # headings)
    expect(mdResult.out).toMatch(/^#+ /m);
  });

  it("course show <missing> exits 1, not 2", () => {
    const { root } = setup();
    const result = runCli(root, ["course", "show", "course-does-not-exist"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/harness error:.*not found/i);
  });

  it("course status <missing> exits 1 with not-found error (Fable P2-1)", () => {
    const { root } = setup();
    const result = runCli(root, ["course", "status", "course-does-not-exist"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/harness error:.*not found/i);
  });

  it("phase list --course <missing> exits 1 with not-found error", () => {
    const { root } = setup();
    const result = runCli(root, ["phase", "list", "--course", "course-does-not-exist"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/harness error:.*not found/i);
  });

  it("course list --status bogus exits 1 with clear error, not empty/exit 0", () => {
    const { root } = setup();
    const result = runCli(root, ["course", "list", "--status", "bogus"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/harness error:.*--status.*active\|paused\|closed/i);
  });

  it("phase update --status bogus exits 1 with clear error", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Status Test", "--json"]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Ph", "--json"]),
    );
    const result = runCli(root, ["phase", "update", phase.phaseId, "--status", "close"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/harness error:.*--status.*pending\|in_progress\|closed\|blocked/i);
  });

  it("course list and course close work", () => {
    const { root } = setup();

    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Close Me", "--json"]),
    );

    const listResult = runCli(root, ["course", "list", "--json"]);
    expect(listResult.code).toBe(0);
    const list = JSON.parse(listResult.out) as { courses: Array<{ courseId: string; status: string }> };
    expect(list.courses.some((c) => c.courseId === course.courseId)).toBe(true);

    // Close the course
    const closeResult = runCli(root, ["course", "close", course.courseId]);
    expect(closeResult.code).toBe(0);

    // After close, status should be closed
    const afterClose = json<{ courseId: string; status: string }>(
      runCli(root, ["course", "show", course.courseId, "--json"]),
    );
    expect(afterClose.status).toBe("closed");
  });
});
