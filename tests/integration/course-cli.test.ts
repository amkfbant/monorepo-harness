import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { HitchRepository } from "../../src/hitch/repository.js";

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

describe("course/phase CLI (SP-1)", () => {
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
