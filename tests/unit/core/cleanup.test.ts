import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { cleanupRun } from "../../../src/core/cleanup.js";
import { createWorktree } from "../../../src/workspace/git-worktree.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";

/** Seed a `db-first` run row matching the run's on-disk meta.json. */
function seedDbFirstRun(harnessRoot: string, runId: string): string {
  const dbPath = join(harnessRoot, ".harness", "harness.sqlite");
  const meta = JSON.parse(
    readFileSync(join(harnessRoot, "runs", runId, "meta.json"), "utf8"),
  ) as Record<string, unknown>;
  const db = openDb(dbPath);
  runMigrations(db);
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, repo_path, domain, workflow,
       base_branch, run_branch, status, started_at, updated_at, source_mode,
       db_revision, meta_json)
     VALUES (?, ?, ?, ?, 'domain-coding', 'main', ?, ?, ?, ?, 'db-first', 1, ?)`,
  ).run(
    runId,
    meta.repoId,
    meta.repoPath,
    meta.domain,
    meta.runBranch,
    meta.status,
    meta.startedAt,
    meta.startedAt,
    JSON.stringify(meta, null, 2),
  );
  db.close();
  return dbPath;
}

interface SetupResult {
  harnessRoot: string;
  repoPath: string;
  runId: string;
  worktreePath: string;
  runBranch: string;
}

async function setup(status: string): Promise<SetupResult> {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-cu-"));
  const repoPath = mkdtempSync(join(tmpdir(), "harness-target-"));
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

  const runId = "run-cleanup-test-001";
  const runBranch = `harness/${runId}/x`;
  const wt = await createWorktree({
    repoPath,
    worktreesDir: join(harnessRoot, "workspaces"),
    runId,
    branch: runBranch,
    base: baseSha,
  });

  mkdirSync(join(harnessRoot, "runs", runId), { recursive: true });
  writeFileSync(
    join(harnessRoot, "runs", runId, "meta.json"),
    JSON.stringify(
      {
        runId,
        repoId: "t",
        repoPath,
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha,
        runBranch,
        status,
        startedAt: "2026-05-20T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(harnessRoot, "runs", runId, "events.jsonl"), "");

  return { harnessRoot, repoPath, runId, worktreePath: wt.path, runBranch };
}

describe("cleanupRun", () => {
  it("removes worktree and branch for an approved run; keeps run dir", async () => {
    const s = await setup("approved");
    const r = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
    });
    expect(r.worktreeRemoved).toBe(true);
    expect(r.branchRemoved).toBe(true);
    expect(existsSync(s.worktreePath)).toBe(false);
    expect(existsSync(join(s.harnessRoot, "runs", s.runId, "meta.json"))).toBe(
      true,
    );
    // branch should be gone from target repo
    const branches = execFileSync(
      "git",
      ["branch", "--list", s.runBranch],
      { cwd: s.repoPath },
    )
      .toString()
      .trim();
    expect(branches).toBe("");
  });

  it("removes worktree and branch for a rejected run", async () => {
    const s = await setup("rejected");
    const r = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
    });
    expect(r.worktreeRemoved).toBe(true);
  });

  it("refuses to clean up a needs_review run without --force", async () => {
    const s = await setup("needs_review");
    await expect(
      cleanupRun({
        runsDir: join(s.harnessRoot, "runs"),
        workspacesDir: join(s.harnessRoot, "workspaces"),
        locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
        runId: s.runId,
      }),
    ).rejects.toThrow(/status "needs_review"/);
    expect(existsSync(s.worktreePath)).toBe(true);
  });

  it("cleans up any status with --force", async () => {
    const s = await setup("failed-codex");
    const r = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
      force: true,
    });
    expect(r.worktreeRemoved).toBe(true);
  });

  it("preserves changes_requested runs even with force=false (they are the base of a retry)", async () => {
    const s = await setup("changes_requested");
    await expect(
      cleanupRun({
        runsDir: join(s.harnessRoot, "runs"),
        workspacesDir: join(s.harnessRoot, "workspaces"),
        locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
        runId: s.runId,
      }),
    ).rejects.toThrow(/changes_requested/);
  });

  it("updates meta.status to 'cleaned' after cleanup and emits cleaned event", async () => {
    const s = await setup("approved");
    await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
    });
    const { readFileSync } = await import("node:fs");
    const meta = JSON.parse(
      readFileSync(join(s.harnessRoot, "runs", s.runId, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("cleaned");
    const events = readFileSync(
      join(s.harnessRoot, "runs", s.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === "cleaned")).toBeDefined();
  });

  it("rejects path-traversal runId (../)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cu-"));
    await expect(
      cleanupRun({
        runsDir: join(root, "runs"),
        workspacesDir: join(root, "workspaces"),
        locksDir: join(root, "locks"),
        dbPath: join(root, ".harness", "harness.sqlite"),
        runId: "../escape",
      }),
    ).rejects.toThrow(/invalid runId/);
  });

  it("rejects meta.json with mismatched runId", async () => {
    const s = await setup("approved");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(s.harnessRoot, "runs", s.runId, "meta.json"),
      JSON.stringify({ runId: "run-something-else", domain: "x" }),
    );
    await expect(
      cleanupRun({
        runsDir: join(s.harnessRoot, "runs"),
        workspacesDir: join(s.harnessRoot, "workspaces"),
        locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
        runId: s.runId,
      }),
    ).rejects.toThrow(/runId/);
  });

  it("removes the branch even when the worktree is already gone (independent paths)", async () => {
    const s = await setup("approved");
    // simulate someone deleting the worktree dir but leaving the branch
    const { rmSync } = await import("node:fs");
    rmSync(s.worktreePath, { recursive: true, force: true });
    // git worktree prune so git's bookkeeping is consistent
    execFileSync("git", ["worktree", "prune"], { cwd: s.repoPath });
    const r = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
    });
    expect(r.worktreeRemoved).toBe(false); // already gone
    expect(r.branchRemoved).toBe(true); // branch still existed and was removed
    const branches = execFileSync(
      "git",
      ["branch", "--list", s.runBranch],
      { cwd: s.repoPath },
    )
      .toString()
      .trim();
    expect(branches).toBe("");
  });

  it("acquires the domain lock during cleanup (cannot race with a new run)", async () => {
    const s = await setup("approved");
    // Pre-lock the domain to simulate a concurrent run.
    const { acquireDomainLock } = await import(
      "../../../src/workspace/domain-lock.js"
    );
    const held = await acquireDomainLock({
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      domain: "apps/user",
      runId: "run-fake-concurrent",
      // namespaced lock — must match the repoId in the run's meta.json.
      repoId: "t",
    });
    try {
      await expect(
        cleanupRun({
          runsDir: join(s.harnessRoot, "runs"),
          workspacesDir: join(s.harnessRoot, "workspaces"),
          locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
          runId: s.runId,
        }),
      ).rejects.toThrow(/locked/);
    } finally {
      await held.release();
    }
  });

  it("is idempotent: re-cleanup is a no-op when worktree is already gone", async () => {
    const s = await setup("approved");
    await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
    });
    // status is now 'cleaned'; re-cleanup should not throw, just no-op
    const r2 = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
    });
    expect(r2.worktreeRemoved).toBe(false);
    expect(r2.branchRemoved).toBe(false);
  });

  it("scope=workspace keeps the run dir and removes the empty workspace dir", async () => {
    const s = await setup("approved");
    const r = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
      scope: "workspace",
    });
    expect(r.scope).toBe("workspace");
    expect(r.runDirRemoved).toBe(false);
    expect(existsSync(join(s.harnessRoot, "runs", s.runId, "meta.json"))).toBe(
      true,
    );
    // workspaces/<runId>/ parent dir removed
    expect(existsSync(join(s.harnessRoot, "workspaces", s.runId))).toBe(false);
  });

  it("scope=run deletes the run dir entirely", async () => {
    const s = await setup("approved");
    const r = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
      scope: "run",
    });
    expect(r.scope).toBe("run");
    expect(r.runDirRemoved).toBe(true);
    expect(r.previousStatus).toBe("approved");
    expect(existsSync(join(s.harnessRoot, "runs", s.runId))).toBe(false);
  });

  it("scope=all deletes the run dir and prunes git worktree bookkeeping", async () => {
    const s = await setup("approved");
    const r = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
      runId: s.runId,
      scope: "all",
    });
    expect(r.scope).toBe("all");
    expect(r.runDirRemoved).toBe(true);
    expect(existsSync(join(s.harnessRoot, "runs", s.runId))).toBe(false);
    // git worktree list should no longer reference the pruned worktree
    const list = execFileSync("git", ["worktree", "list"], {
      cwd: s.repoPath,
    }).toString();
    expect(list).not.toContain(s.runId);
  });

  it("scope=run still honors the status gate (changes_requested refused)", async () => {
    const s = await setup("changes_requested");
    await expect(
      cleanupRun({
        runsDir: join(s.harnessRoot, "runs"),
        workspacesDir: join(s.harnessRoot, "workspaces"),
        locksDir: join(s.harnessRoot, "locks"),
      dbPath: join(s.harnessRoot, ".harness", "harness.sqlite"),
        runId: s.runId,
        scope: "run",
      }),
    ).rejects.toThrow(/changes_requested/);
    expect(existsSync(join(s.harnessRoot, "runs", s.runId))).toBe(true);
  });
});

describe("cleanupRun — DB-first run (Phase 7-7)", () => {
  it("workspace scope flips the DB status and records cleanup_actions", async () => {
    const s = await setup("approved");
    const dbPath = seedDbFirstRun(s.harnessRoot, s.runId);
    await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath,
      runId: s.runId,
    });
    const db = openDb(dbPath);
    try {
      const row = db
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(s.runId) as { status: string };
      expect(row.status).toBe("cleaned");
      const actions = (
        db
          .prepare(
            "SELECT action_type FROM cleanup_actions WHERE run_id = ?",
          )
          .all(s.runId) as { action_type: string }[]
      ).map((a) => a.action_type);
      expect(actions).toContain("worktree_remove");
    } finally {
      db.close();
    }
    // run dir kept (workspace scope); meta.json re-exported as cleaned
    expect(existsSync(join(s.harnessRoot, "runs", s.runId))).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(s.harnessRoot, "runs", s.runId, "meta.json"), "utf8"),
    ) as { status: string };
    expect(meta.status).toBe("cleaned");
  });

  it("run scope deletes the dir but keeps the canonical DB row", async () => {
    const s = await setup("approved");
    const dbPath = seedDbFirstRun(s.harnessRoot, s.runId);
    await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath,
      runId: s.runId,
      scope: "run",
    });
    // the exported run dir is gone …
    expect(existsSync(join(s.harnessRoot, "runs", s.runId))).toBe(false);
    // … but the canonical DB row remains, marked cleaned
    const db = openDb(dbPath);
    try {
      const row = db
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(s.runId) as { status: string } | undefined;
      expect(row?.status).toBe("cleaned");
      const removed = db
        .prepare(
          "SELECT 1 FROM cleanup_actions WHERE run_id = ? AND action_type = 'run_dir_remove'",
        )
        .get(s.runId);
      expect(removed).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("can re-clean a db-first run after its export dir was deleted", async () => {
    const s = await setup("approved");
    const dbPath = seedDbFirstRun(s.harnessRoot, s.runId);
    const opts = {
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      locksDir: join(s.harnessRoot, "locks"),
      dbPath,
      runId: s.runId,
      scope: "run" as const,
    };
    await cleanupRun(opts);
    expect(existsSync(join(s.harnessRoot, "runs", s.runId))).toBe(false);
    // a second cleanup must not fail on the missing meta.json — the
    // db-first run is recovered from the DB row.
    const r = await cleanupRun(opts);
    expect(r.previousStatus).toBe("cleaned");
  });
});
