import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { CourseRepository } from "../../src/roadmap/course-repository.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import { PhaseRepository } from "../../src/roadmap/phase-repository.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(
  root: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: {
        ...process.env,
        HARNESS_ROOT: root,
        HARNESS_SUPPRESS_EXPORT_MODE_WARNING: "1",
        ...extraEnv,
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

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-course-cli-repo-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.invalid"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(join(repo, "apps/user/src/profile.ts"), "export const x = 0;\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "target" }));
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return repo;
}

function setupProjectHarness(root: string, repoPath: string): void {
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(
    join(root, "projects", "demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: t",
      `  path: ${repoPath}`,
      "  package_manager: npm",
      "policy:",
      "  template: strict-monorepo-v1",
      "domains:",
      "  - id: apps/user",
      "    root: apps/user",
      "    kind: app",
      "",
    ].join("\n"),
  );
}

function writeFakeCodexBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-course-cli-fake-codex-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      "case \"$*\" in",
      "  *read-only*)",
      "    cat <<'YAML'",
      "decision: approved",
      "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "YAML",
      "    ;;",
      "  *)",
      "    echo 'export const x = 1;' > apps/user/src/profile.ts",
      "    echo 'fake codex done'",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  execFileSync("chmod", ["+x", bin]);
  return bin;
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

function seedDrivableHitch(
  db: ReturnType<typeof openDb>,
  hitchId: string,
  opts: { projectId?: string; domain?: string } = {},
): void {
  const hitches = new HitchRepository(db);
  hitches.createSession({
    hitchId,
    title: hitchId,
    projectId: opts.projectId ?? "demo",
    domain: opts.domain ?? "app",
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

    const text = runCli(root, [
      "course",
      "orchestrate",
      course.courseId,
      "--dry-run",
    ]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(
      `phase=${parent.phaseId} action=blocked_hitch blockedHitch=h-blocked:`,
    );
    expect(text.out).toContain(
      `phase=${child.phaseId} action=blocked_subtree note=blocked_subtree`,
    );
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
      stopReason: string;
      phaseOutcomes: Array<{ phaseId: string; action: string }>;
    };
    expect(body.stopReason).toBe("completed");
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

  it("course orchestrate fails early with friendly guidance when the DB is newer than the harness", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Skew Course", "--json"]),
    );
    json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "One", "--json"]),
    );
    // Stamp a schema_migrations row newer than the harness supports.
    withSeedDb(root, (db) => {
      const latest = (
        db
          .prepare("SELECT max(version) AS v FROM schema_migrations")
          .get() as { v: number }
      ).v;
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(latest + 1, "from-the-future", new Date().toISOString());
    });

    const result = runCli(root, ["course", "orchestrate", course.courseId]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/newer than this harness/);
    expect(result.out).toMatch(/upgrade the harness/);
    // The friendly error fires BEFORE the operation is started — no spurious row.
    // Read directly (no runMigrations — the stamped DB would reject migration).
    const probe = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      const row = probe
        .prepare(
          "SELECT COUNT(*) AS n FROM operations WHERE operation_type = 'course.orchestrate'",
        )
        .get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      probe.close();
    }
  });

  it("course orchestrate treats driver exceptions containing project as internal errors", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, [
        "course",
        "create",
        "--title",
        "Internal Driver Error Course",
        "--json",
      ]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Drive", "--json"]),
    );
    withSeedDb(root, (db) => {
      const phases = new PhaseRepository(db);
      seedDrivableHitch(db, "h-driver-internal", {
        projectId: undefined,
        domain: "apps/user",
      });
      db.prepare("UPDATE hitch_sessions SET project_id = NULL WHERE hitch_id = ?")
        .run("h-driver-internal");
      phases.linkHitch(phase.phaseId, "h-driver-internal");
    });

    const result = runCli(root, ["course", "orchestrate", course.courseId]);

    expect(result.code).toBe(2);
    expect(result.out).toMatch(/has no projectId/i);
  });

  it("course orchestrate records budget_reached as succeeded with exit 0", () => {
    const { root } = setup();
    const repoPath = setupRepo();
    setupProjectHarness(root, repoPath);
    const fakeCodexBin = writeFakeCodexBin();
    const course = json<{ courseId: string }>(
      runCli(root, [
        "course",
        "create",
        "--title",
        "Budget Course",
        "--project",
        "demo",
        "--json",
      ]),
    );
    const p1 = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "One", "--json"]),
    );
    const p2 = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Two", "--json"]),
    );
    withSeedDb(root, (db) => {
      const phases = new PhaseRepository(db);
      seedDrivableHitch(db, "h-budget-one", { domain: "apps/user" });
      seedDrivableHitch(db, "h-budget-two", { domain: "apps/user" });
      phases.linkHitch(p1.phaseId, "h-budget-one");
      phases.linkHitch(p2.phaseId, "h-budget-two");
    });

    const result = runCli(
      root,
      [
        "course",
        "orchestrate",
        course.courseId,
        "--max-driven-hitches",
        "1",
        "--json",
      ],
      { HARNESS_CODEX_BIN: fakeCodexBin },
    );
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as {
      stopReason: string;
      drivenHitches: Array<{ hitchId: string }>;
      phaseOutcomes: Array<{ phaseId: string; action: string; note?: string }>;
    };
    expect(body.stopReason).toBe("budget_reached");
    expect(body.drivenHitches).toHaveLength(1);
    expect(["h-budget-one", "h-budget-two"]).toContain(
      body.drivenHitches[0]?.hitchId,
    );
    expect(body.phaseOutcomes).toContainEqual(
      expect.objectContaining({
        action: "not_driven",
        note: "not_driven",
      }),
    );

    withSeedDb(root, (db) => {
      const row = db
        .prepare(
          "SELECT status, error_code, result_json FROM operations WHERE operation_type = 'course.orchestrate' ORDER BY created_at DESC LIMIT 1",
        )
        .get() as
        | { status: string; error_code: string | null; result_json: string | null }
        | undefined;
      expect(row?.status).toBe("succeeded");
      expect(row?.error_code).toBeNull();
      expect(JSON.parse(row?.result_json ?? "{}")).toMatchObject({
        stopReason: "budget_reached",
      });
      const lease = db
        .prepare(
          "SELECT released_by, release_reason FROM domain_locks WHERE domain_key = ? ORDER BY lock_id DESC LIMIT 1",
        )
        .get(`course:${course.courseId}`) as
        | { released_by: string | null; release_reason: string | null }
        | undefined;
      expect(lease?.released_by).toBe(
        `course-orchestrate:${course.courseId}`,
      );
      expect(lease?.release_reason).toBe("budget_reached");
    });
  });

  it("course orchestrate without budget or blockers exits 0 with completed", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Completed Course", "--json"]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, ["phase", "add", "--course", course.courseId, "--title", "Needs Link", "--json"]),
    );

    const result = runCli(root, [
      "course",
      "orchestrate",
      course.courseId,
      "--json",
    ]);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as {
      stopReason: string;
      phaseOutcomes: Array<{ phaseId: string; action: string }>;
    };
    expect(body.stopReason).toBe("completed");
    expect(body.phaseOutcomes).toEqual([
      { phaseId: phase.phaseId, action: "needs_link" },
    ]);
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

  it("course pause and resume update status, and paused courses do not orchestrate", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Pause Resume Course", "--json"]),
    );

    const paused = runCli(root, ["course", "pause", course.courseId]);
    expect(paused.code).toBe(0);
    expect(paused.out).toContain(`course=${course.courseId} status=paused`);
    expect(
      json<{ status: string }>(runCli(root, ["course", "show", course.courseId, "--json"]))
        .status,
    ).toBe("paused");

    const blocked = runCli(root, ["course", "orchestrate", course.courseId]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toMatch(/not active/i);

    const resumed = runCli(root, ["course", "resume", course.courseId]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain(`course=${course.courseId} status=active`);
    expect(
      json<{ status: string }>(runCli(root, ["course", "show", course.courseId, "--json"]))
        .status,
    ).toBe("active");
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

  it("phase update --note records an audit note shown in status JSON and export --md (#171b)", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Note Course", "--json"]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--title",
        "Phase With Note",
        "--json",
      ]),
    );

    // include a newline + markdown to prove export sanitization keeps it on one line
    const note = "force-closed: PR #999 merged\n## not a real heading";
    const updated = runCli(root, [
      "phase",
      "update",
      phase.phaseId,
      "--status",
      "closed",
      "--note",
      note,
    ]);
    expect(updated.code).toBe(0);

    // status --json exposes the note verbatim on the phase rollup
    const status = JSON.parse(
      runCli(root, ["course", "status", course.courseId, "--json"]).out,
    ) as { phases: Array<{ phaseId: string; note: string | null }> };
    const node = status.phases.find((p) => p.phaseId === phase.phaseId)!;
    expect(node.note).toBe(note);

    // export --md renders a single Note line — the newline is collapsed so it
    // cannot inject a heading into the audit export
    const exported = runCli(root, ["course", "export", course.courseId, "--md"]);
    expect(exported.code).toBe(0);
    expect(exported.out).toContain(
      "**Note**: force-closed: PR #999 merged ## not a real heading",
    );
    expect(exported.out).not.toContain("\n## not a real heading");
  });

  it("phase add/update reject invalid close condition files before writing", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Spec Barrier", "--json"]),
    );
    const invalidClose = join(root, "invalid-close.json");
    writeFileSync(
      invalidClose,
      JSON.stringify([
        {
          id: "deploy",
          kind: "operation_status",
          required: true,
          metadata: {},
        },
      ]),
    );

    const rejectedAdd = runCli(root, [
      "phase",
      "add",
      "--course",
      course.courseId,
      "--title",
      "Invalid",
      "--close-file",
      invalidClose,
    ]);
    expect(rejectedAdd.code).toBe(1);
    expect(rejectedAdd.out).toMatch(/operation_status_missing_operation_id/);
    withSeedDb(root, (db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM phases WHERE course_id = ?")
        .get(course.courseId) as { count: number };
      expect(row.count).toBe(0);
    });

    const validClose = join(root, "valid-close.json");
    writeFileSync(
      validClose,
      JSON.stringify([
        {
          id: "typecheck",
          kind: "command",
          required: true,
          command: "npm run typecheck",
        },
      ]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--title",
        "Valid",
        "--close-file",
        validClose,
        "--json",
      ]),
    );

    const rejectedUpdate = runCli(root, [
      "phase",
      "update",
      phase.phaseId,
      "--status",
      "closed",
      "--close-file",
      invalidClose,
    ]);
    expect(rejectedUpdate.code).toBe(1);
    expect(rejectedUpdate.out).toMatch(/operation_status_missing_operation_id/);
    withSeedDb(root, (db) => {
      const row = db
        .prepare(
          "SELECT status, close_conditions_json FROM phases WHERE phase_id = ?",
        )
        .get(phase.phaseId) as {
        status: string;
        close_conditions_json: string;
      };
      expect(row.status).toBe("pending");
      expect(JSON.parse(row.close_conditions_json).map((cc: { id: string }) => cc.id)).toEqual([
        "typecheck",
      ]);
    });
  });

  it("phase update applies scope, close conditions, status, and note atomically", () => {
    const { root } = setup();
    const course = json<{ courseId: string }>(
      runCli(root, ["course", "create", "--title", "Atomic Update", "--json"]),
    );
    const initialScope = join(root, "initial-scope.json");
    const nextScope = join(root, "next-scope.json");
    const initialClose = join(root, "initial-close.json");
    const nextClose = join(root, "next-close.json");
    writeFileSync(initialScope, JSON.stringify({ targetFiles: ["src/**"] }));
    writeFileSync(nextScope, JSON.stringify({ targetFiles: ["src/**"], notes: "next scope" }));
    writeFileSync(
      initialClose,
      JSON.stringify([
        {
          id: "typecheck",
          kind: "command",
          required: true,
          command: "npm run typecheck",
        },
      ]),
    );
    writeFileSync(
      nextClose,
      JSON.stringify([
        {
          id: "typecheck",
          kind: "command",
          required: true,
          command: "npm run typecheck",
        },
        {
          id: "review",
          kind: "review_consensus",
          required: true,
          description: "review consensus approved",
        },
      ]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--title",
        "Atomic Phase",
        "--scope-file",
        initialScope,
        "--close-file",
        initialClose,
        "--json",
      ]),
    );

    withSeedDb(root, (db) => {
      db.exec(`
        CREATE TRIGGER fail_phase_note
        BEFORE UPDATE OF review_state_json ON phases
        WHEN NEW.review_state_json LIKE '%rollback note%'
        BEGIN
          SELECT RAISE(ABORT, 'forced_note_failure');
        END;
      `);
    });

    const failed = runCli(root, [
      "phase",
      "update",
      phase.phaseId,
      "--scope-file",
      nextScope,
      "--close-file",
      nextClose,
      "--status",
      "closed",
      "--note",
      "rollback note",
    ]);
    expect(failed.code).not.toBe(0);
    expect(failed.out).toMatch(/forced_note_failure/);

    withSeedDb(root, (db) => {
      const row = db
        .prepare(
          `SELECT status, scope_json, close_conditions_json, review_state_json
             FROM phases
            WHERE phase_id = ?`,
        )
        .get(phase.phaseId) as {
        status: string;
        scope_json: string;
        close_conditions_json: string;
        review_state_json: string | null;
      };
      expect(row.status).toBe("pending");
      expect(JSON.parse(row.scope_json)).toEqual({ targetFiles: ["src/**"] });
      expect(
        JSON.parse(row.close_conditions_json).map((cc: { id: string }) => cc.id),
      ).toEqual(["typecheck"]);
      expect(row.review_state_json).toBeNull();
    });
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

  it("phase unlink-hitch reports when no link existed", () => {
    const { root } = setup();

    const unlinked = runCli(root, ["phase", "unlink-hitch", "h-not-linked"]);
    expect(unlinked.code).toBe(0);
    expect(unlinked.out).toContain("no link");
    expect(unlinked.out).toContain("hitch=h-not-linked");
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
