import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import { resolveHitchCoderRunnerDeps } from "../../src/cli/hitch.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

// A no-op fake codex: the #236 wiring assertion only needs the CLI's
// pre-run stderr "using base branch" line, which is emitted before codex runs.
function writeFakeCodex(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-basebranch-codex-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}

function runOrchestrate(
  harnessRoot: string,
  repoPath: string,
  codexBin: string,
  extraArgs: string[],
): { out: string } {
  // spawnSync (not execFileSync) so stderr is captured regardless of exit code:
  // the run escalates with exit 0 (an unresolved base branch), and the
  // "using base branch" line we assert is on STDERR.
  const r = spawnSync(
    "node",
    [
      "--import", "tsx", CLI,
      "hitch", "orchestrate", "g-proj",
      "--repo", repoPath, "--max-steps", "1", ...extraArgs,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_ROOT: harnessRoot,
        HARNESS_CODEX_BIN: codexBin,
        HARNESS_SUPPRESS_EXPORT_MODE_WARNING: "1",
      },
    },
  );
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// #236 — `hitch orchestrate --base-branch <name>` must be honored for a
// project-scoped hitch, overriding the profile's repo.base_branch. The profile
// here pins base_branch=develop so an override to a third value is unambiguous.
function setupProject(): { harnessRoot: string; dbPath: string; repoPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-basebranch-"));
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, ".harness"), { recursive: true });

  const repo = mkdtempSync(join(tmpdir(), "harness-basebranch-repo-"));
  mkdirSync(join(repo, "apps/web"), { recursive: true });
  writeFileSync(
    join(repo, "apps/web/package.json"),
    JSON.stringify({ name: "@demo/web" }),
  );
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", [
    "-C", repo, "-c", "user.email=t@e.com", "-c", "user.name=t",
    "commit", "-m", "init",
  ]);

  writeFileSync(
    join(root, "projects", "demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: demo",
      `  path: ${repo}`,
      "  base_branch: develop",
      "policy:",
      "  template: strict-monorepo-v1",
      "domains:",
      "  - id: apps/web",
      "    root: apps/web",
      "    kind: app",
      "",
    ].join("\n"),
  );
  return { harnessRoot: root, dbPath: join(root, ".harness", "harness.sqlite"), repoPath: repo };
}

function seedProjectHitch(dbPath: string): void {
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    new HitchRepository(db).createSession({
      hitchId: "g-proj",
      title: "Project hitch",
      projectId: "demo",
      repoId: "demo",
      domain: "apps/web",
      scope: {},
      closeConditions: [],
      createdBy: "test",
      createdSource: "worker",
    });
  } finally {
    close();
  }
}

describe("resolveHitchCoderRunnerDeps base-branch override (#236)", () => {
  it("honors an explicit --base-branch over the project profile's base_branch", async () => {
    const { harnessRoot, dbPath, repoPath } = setupProject();
    seedProjectHitch(dbPath);
    const deps = await resolveHitchCoderRunnerDeps({
      harnessRoot,
      dbPath,
      hitchId: "g-proj",
      repoPath,
      codexBin: "codex",
      baseBranch: "feature/stacked",
    });
    expect(deps.baseBranch).toBe("feature/stacked");
    // resolveRunContext (used by the run) must carry the override too.
    const { db, close } = openManagedDb({ dbPath });
    try {
      const session = new HitchRepository(db).requireSession("g-proj");
      expect(deps.resolveRunContext!(session).baseBranch).toBe("feature/stacked");
    } finally {
      close();
    }
  });

  it("falls back to the profile base_branch when --base-branch is omitted", async () => {
    const { harnessRoot, dbPath, repoPath } = setupProject();
    seedProjectHitch(dbPath);
    const deps = await resolveHitchCoderRunnerDeps({
      harnessRoot,
      dbPath,
      hitchId: "g-proj",
      repoPath,
      codexBin: "codex",
      // baseBranch omitted → profile default (develop), not the CLI default main
    });
    expect(deps.baseBranch).toBe("develop");
  });

  it("project-less hitch: explicit --base-branch wins, omitted falls back to main (#236)", async () => {
    const { harnessRoot, dbPath, repoPath } = setupProject();
    // a hitch WITHOUT a projectId → delegates to resolveHitchCloseRunnerDeps.
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-nolproj",
        title: "No project",
        projectId: null,
        repoId: "demo",
        scope: {},
        closeConditions: [],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const explicit = await resolveHitchCoderRunnerDeps({
      harnessRoot, dbPath, hitchId: "g-nolproj", repoPath, codexBin: "codex",
      baseBranch: "feature/x",
    });
    expect(explicit.baseBranch).toBe("feature/x");
    const omitted = await resolveHitchCoderRunnerDeps({
      harnessRoot, dbPath, hitchId: "g-nolproj", repoPath, codexBin: "codex",
    });
    expect(omitted.baseBranch).toBe("main");
  });

  it("[#191] project-less hitch with a domain tolerates a MISSING repo policy (fail-open, P2)", async () => {
    // A repo-id-mode hitch whose repo policy file is absent/renamed must NOT
    // throw here — that would block opening/merging an already close_ready PR
    // (this helper runs before convergence on orchestrate). It falls back to env.
    const { harnessRoot, dbPath, repoPath } = setupProject();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-missingpol",
        title: "repo-id mode, missing policy",
        projectId: null,
        repoId: "no-such-repo",
        domain: "apps/x",
        scope: {},
        closeConditions: [],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const deps = await resolveHitchCoderRunnerDeps({
      harnessRoot, dbPath, hitchId: "g-missingpol", repoPath, codexBin: "codex",
    });
    // resolved (no throw) and still produced a coder runner (env-fallback backend).
    expect(deps.baseBranch).toBe("main");
    expect(typeof deps.coderRunner?.run).toBe("function");
  });

  it("CLI wiring: omitted --base-branch uses the profile base; explicit overrides it (#236)", () => {
    const { harnessRoot, dbPath, repoPath } = setupProject();
    seedProjectHitch(dbPath);
    const codexBin = writeFakeCodex();

    // omitted → the commander default-removal makes raw.baseBranch undefined,
    // so the resolver falls back to the profile's develop (not "main").
    const omitted = runOrchestrate(harnessRoot, repoPath, codexBin, []);
    expect(omitted.out).toContain("hitch g-proj: using base branch develop");

    // explicit → overrides the profile base.
    const explicit = runOrchestrate(harnessRoot, repoPath, codexBin, [
      "--base-branch", "feature/cli",
    ]);
    expect(explicit.out).toContain("hitch g-proj: using base branch feature/cli");
  });
});
