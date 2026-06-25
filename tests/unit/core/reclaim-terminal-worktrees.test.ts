import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { reclaimTerminalRunWorktrees } from "../../../src/core/cleanup.js";
import { createWorktree } from "../../../src/workspace/git-worktree.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { makeTmpDir } from "../../helpers/tmp.js";

async function seedRun(
  db: Database.Database,
  harnessRoot: string,
  repoPath: string,
  baseSha: string,
  runId: string,
  status: string,
): Promise<string> {
  const runBranch = `harness/${runId}/x`;
  const wt = await createWorktree({
    repoPath,
    worktreesDir: join(harnessRoot, "workspaces"),
    runId,
    branch: runBranch,
    base: baseSha,
  });
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, repo_path, domain, workflow, base_branch,
       run_branch, status, started_at, updated_at, source_mode, db_revision, meta_json)
     VALUES (?, 't', ?, 'apps/user', 'domain-coding', 'main', ?, ?,
       '2026-05-20T00:00:00Z', '2026-05-20T00:00:00Z', 'db-first', 1, '{}')`,
  ).run(runId, repoPath, runBranch, status);
  return wt.path;
}

function statusOf(db: Database.Database, runId: string): string {
  return (
    db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId) as {
      status: string;
    }
  ).status;
}

describe("reclaimTerminalRunWorktrees (#404 follow-up)", () => {
  it("removes ONLY rejected worktrees, keeps approved/changes_requested/needs_review", async () => {
    const harnessRoot = makeTmpDir("harness-rtw-");
    const repoPath = makeTmpDir("harness-rtw-repo-");
    const g = (a: string[]) =>
      execFileSync("git", a, { cwd: repoPath, stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@e.com"]);
    g(["config", "user.name", "T"]);
    writeFileSync(join(repoPath, "README.md"), "init\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
    })
      .toString()
      .trim();

    mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
    const db = openDb(join(harnessRoot, ".harness", "harness.sqlite"));
    runMigrations(db);

    const approved = await seedRun(
      db, harnessRoot, repoPath, baseSha, "run-approved", "approved",
    );
    const rejected = await seedRun(
      db, harnessRoot, repoPath, baseSha, "run-rejected", "rejected",
    );
    const cr = await seedRun(
      db, harnessRoot, repoPath, baseSha, "run-cr", "changes_requested",
    );
    const nr = await seedRun(
      db, harnessRoot, repoPath, baseSha, "run-nr", "needs_review",
    );

    const results = await reclaimTerminalRunWorktrees({
      db,
      repoPath,
      workspacesDir: join(harnessRoot, "workspaces"),
      runsDir: join(harnessRoot, "runs"),
    });

    // ONLY the rejected worktree is reclaimed
    expect(existsSync(rejected)).toBe(false);
    // approved is kept (input to `pr create` + valid continuation parent),
    // changes_requested is a retry base, needs_review is not terminal
    expect(existsSync(approved)).toBe(true);
    expect(existsSync(cr)).toBe(true);
    expect(existsSync(nr)).toBe(true);

    expect(statusOf(db, "run-rejected")).toBe("cleaned");
    expect(statusOf(db, "run-approved")).toBe("approved");
    expect(statusOf(db, "run-cr")).toBe("changes_requested");
    expect(statusOf(db, "run-nr")).toBe("needs_review");

    expect(results.filter((r) => r.reclaimed).length).toBe(1);
    db.close();
  });

  it("is a no-op when there are no rejected runs", async () => {
    const harnessRoot = makeTmpDir("harness-rtw2-");
    const repoPath = makeTmpDir("harness-rtw2-repo-");
    const g = (a: string[]) =>
      execFileSync("git", a, { cwd: repoPath, stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@e.com"]);
    g(["config", "user.name", "T"]);
    writeFileSync(join(repoPath, "README.md"), "init\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);

    mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
    const db = openDb(join(harnessRoot, ".harness", "harness.sqlite"));
    runMigrations(db);

    const results = await reclaimTerminalRunWorktrees({
      db,
      repoPath,
      workspacesDir: join(harnessRoot, "workspaces"),
      runsDir: join(harnessRoot, "runs"),
    });
    expect(results).toEqual([]);
    db.close();
  });
});
