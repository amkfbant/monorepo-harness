import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { CourseRepository } from "../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../src/roadmap/phase-repository.js";
import { HitchRepository } from "../../src/hitch/repository.js";

const CLI = join(process.cwd(), "src/cli/run.ts");
const GHP = "ghp_0123456789abcdefghijklmnopqrstuvwx";
// Resolve tsx to an ABSOLUTE path so `--import` works even when the spawned CLI
// runs with a different cwd (bare-specifier "tsx" would resolve from cwd).
const TSX = createRequire(import.meta.url).resolve("tsx");

function runCli(
  root: string,
  args: string[],
  cwd?: string,
): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", TSX, CLI, ...args], {
      cwd,
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

function seed(root: string): void {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    const courses = new CourseRepository(db);
    const phases = new PhaseRepository(db);
    const repo = new HitchRepository(db);
    courses.create({
      courseId: "course-1",
      title: "Course One",
      createdBy: "t",
      createdSource: "cli",
    });
    phases.add({
      courseId: "course-1",
      phaseId: "phase-1",
      title: "Phase One",
      scope: {},
      closeConditions: [],
      createdBy: "t",
      createdSource: "cli",
    });
    repo.createSession({
      hitchId: "h-1",
      title: "Hitch One",
      scope: {},
      closeConditions: [],
      createdBy: "t",
      createdSource: "cli",
    });
    phases.linkHitch("phase-1", "h-1");
    repo.upsertFinding({
      hitchId: "h-1",
      source: "review",
      severity: "P0",
      category: "security",
      summary: `leaked ${GHP} token`,
      detail: "must never appear in output",
      scopeStatus: "in_scope",
      lifecycleStatus: "open",
    });
  } finally {
    db.close();
  }
}

function setup(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-hitch-summary-"));
  seed(root);
  return { root };
}

describe("hitch summary CLI (#84 Stage A)", () => {
  it("renders Markdown with redacted findings to stdout", () => {
    const { root } = setup();
    const { out, code } = runCli(root, ["hitch", "summary", "--course", "course-1"]);
    expect(code).toBe(0);
    expect(out).toMatch(/# Hitch Summary: Course One/);
    expect(out).toMatch(/course-1/);
    expect(out).toMatch(/## Phase: Phase One/);
    expect(out).toMatch(/h-1/);
    // secret-shaped finding summary is withheld whole
    expect(out).not.toContain(GHP);
    expect(out).toContain("[redacted]");
    // B列 free text never surfaces
    expect(out).not.toContain("must never appear in output");
  });

  it("emits the structured redacted projection as JSON", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { courseId: string; openInScopeP0: number };
    expect(parsed.courseId).toBe("course-1");
    expect(parsed.openInScopeP0).toBe(1);
    expect(out).not.toContain(GHP);
  });

  it("writes to --out within the cwd and reports the path", () => {
    const { root } = setup();
    const workdir = mkdtempSync(join(tmpdir(), "harness-hitch-summary-cwd-"));
    const { out, code } = runCli(
      root,
      ["hitch", "summary", "--course", "course-1", "--out", "report.md"],
      workdir,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/wrote report\.md/);
    const written = readFileSync(join(workdir, "report.md"), "utf8");
    expect(written).toMatch(/# Hitch Summary: Course One/);
    expect(written).not.toContain(GHP);
  });

  it("rejects a --out path that escapes the cwd (fail-closed)", () => {
    const { root } = setup();
    const workdir = mkdtempSync(join(tmpdir(), "harness-hitch-summary-cwd-"));
    const { out, code } = runCli(
      root,
      ["hitch", "summary", "--course", "course-1", "--out", "../escape.md"],
      workdir,
    );
    expect(code).not.toBe(0);
    expect(out).toMatch(/--out must resolve within the current directory/);
  });

  it("errors clearly for an unknown course", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-missing",
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/course-missing/);
  });

  it("errors (does not create a DB) when no harness DB exists — read-only", () => {
    // a pure reporter must NOT open read-write / migrate / create the DB.
    const emptyRoot = mkdtempSync(join(tmpdir(), "harness-hitch-summary-empty-"));
    const { out, code } = runCli(emptyRoot, [
      "hitch",
      "summary",
      "--course",
      "course-1",
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/no harness DB/);
    expect(existsSync(join(emptyRoot, ".harness", "harness.sqlite"))).toBe(false);
  });
});
