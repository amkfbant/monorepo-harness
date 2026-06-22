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

  it("errors clearly for an unknown course (user error → exit 1, not 2)", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-missing",
    ]);
    // a missing course is a user-fixable input error: exit 1, not an internal 2
    expect(code).toBe(1);
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

describe("hitch summary CLI (#84 Stage B — --since/--until time window)", () => {
  it("includes the hitch when the window spans all time (far-past to far-future)", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--since",
      "2000-01-01T00:00:00.000Z",
      "--until",
      "2999-01-01T00:00:00.000Z",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("h-1");
    expect(out).toMatch(/Window \(session updatedAt\)/);
  });

  it("excludes the hitch when the window ends before it was created (far-past upper bound)", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--until",
      "2000-01-01T00:00:00.000Z",
    ]);
    expect(code).toBe(0);
    expect(out).not.toContain("h-1");
    // --json mode: openInScopeP0 is 0 because the hitch is filtered out
    const { out: jsonOut, code: jsonCode } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--until",
      "2000-01-01T00:00:00.000Z",
      "--json",
    ]);
    expect(jsonCode).toBe(0);
    const parsed = JSON.parse(jsonOut) as { openInScopeP0: number };
    expect(parsed.openInScopeP0).toBe(0);
  });

  it("exits 1 with a descriptive message for an invalid --since ISO value", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--since",
      "not-a-date",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/--since must be an ISO-8601 UTC instant/);
  });

  it("exits 1 for prose date that Date.parse would accept but strict parser rejects: --since 'June 1, 2026'", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--since",
      "June 1, 2026",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/--since must be an ISO-8601 UTC instant/);
  });

  it("exits 1 for offset-less local time that Date.parse would accept: --since 2026-06-01T00:00:00", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--since",
      "2026-06-01T00:00:00",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/--since must be an ISO-8601 UTC instant/);
  });

  it("exits 1 for a secret-shaped --since value; output does NOT contain the secret and DOES contain [redacted]", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--since",
      GHP,
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/--since must be an ISO-8601 UTC instant/);
    expect(out).not.toContain(GHP);
    expect(out).toContain("[redacted]");
  });

  it("exits 1 when --since is after --until", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-1",
      "--since",
      "2026-06-30T00:00:00.000Z",
      "--until",
      "2026-06-01T00:00:00.000Z",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/--since must not be after --until/);
  });
});

// Seed helper that creates h-1 (open, domain "apps/catalog") and h-2 (closed,
// domain "apps/payments"). Extends the base seed: reuses the same course/phase.
function seedWithDomainAndStatus(root: string): void {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    const courses = new CourseRepository(db);
    const phases = new PhaseRepository(db);
    const repo = new HitchRepository(db);
    courses.create({
      courseId: "course-ds",
      title: "Course DS",
      createdBy: "t",
      createdSource: "cli",
    });
    phases.add({
      courseId: "course-ds",
      phaseId: "phase-ds",
      title: "Phase DS",
      scope: {},
      closeConditions: [],
      createdBy: "t",
      createdSource: "cli",
    });
    // h-ds-1: open, domain "apps/catalog"
    repo.createSession({
      hitchId: "h-ds-1",
      title: "Hitch DS Open",
      domain: "apps/catalog",
      scope: {},
      closeConditions: [],
      createdBy: "t",
      createdSource: "cli",
    });
    phases.linkHitch("phase-ds", "h-ds-1");
    repo.upsertFinding({
      hitchId: "h-ds-1",
      source: "review",
      severity: "P0",
      category: "security",
      summary: "open p0 finding",
      detail: "detail",
      scopeStatus: "in_scope",
      lifecycleStatus: "open",
    });
    // h-ds-2: closed, domain "apps/payments"
    repo.createSession({
      hitchId: "h-ds-2",
      title: "Hitch DS Closed",
      domain: "apps/payments",
      scope: {},
      closeConditions: [],
      createdBy: "t",
      createdSource: "cli",
    });
    phases.linkHitch("phase-ds", "h-ds-2");
    repo.updateStatus("h-ds-2", "closed", undefined, { createdBy: "t" });
  } finally {
    db.close();
  }
}

function setupDs(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-hitch-summary-ds-"));
  seedWithDomainAndStatus(root);
  return { root };
}

describe("hitch summary CLI (#84 Stage C — --status/--domain filters)", () => {
  it("--status open includes matching hitch and shows '- Status filter:' line", () => {
    const { root } = setupDs();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-ds",
      "--status",
      "open",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("h-ds-1");
    expect(out).toMatch(/- Status filter: open/);
  });

  it("--status closed excludes the open hitch; --json openInScopeP0 === 0", () => {
    const { root } = setupDs();
    // text output: h-ds-1 (open) absent
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-ds",
      "--status",
      "closed",
    ]);
    expect(code).toBe(0);
    expect(out).not.toContain("h-ds-1");
    // --json: openInScopeP0 reflects only the closed hitch (no open P0)
    const { out: jsonOut, code: jsonCode } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-ds",
      "--status",
      "closed",
      "--json",
    ]);
    expect(jsonCode).toBe(0);
    const parsed = JSON.parse(jsonOut) as { openInScopeP0: number };
    expect(parsed.openInScopeP0).toBe(0);
  });

  it("--domain apps/catalog includes the matching hitch and shows '- Domain filter:' line", () => {
    const { root } = setupDs();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-ds",
      "--domain",
      "apps/catalog",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("h-ds-1");
    expect(out).toMatch(/- Domain filter:/);
  });

  it("--domain other excludes all hitches", () => {
    const { root } = setupDs();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-ds",
      "--domain",
      "apps/other",
    ]);
    expect(code).toBe(0);
    expect(out).not.toContain("h-ds-1");
    expect(out).not.toContain("h-ds-2");
  });

  it("invalid --status exits 1 with '--status must be one of' message", () => {
    const { root } = setupDs();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-ds",
      "--status",
      "bogus",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/--status must be one of/);
  });

  it("combined --status open --since far-past includes the open hitch", () => {
    const { root } = setupDs();
    const { out, code } = runCli(root, [
      "hitch",
      "summary",
      "--course",
      "course-ds",
      "--status",
      "open",
      "--since",
      "2000-01-01T00:00:00Z",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("h-ds-1");
  });
});
