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
import { cleanupRun } from "../../../src/core/cleanup.js";
import { createWorktree } from "../../../src/workspace/git-worktree.js";

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
        runId: s.runId,
      }),
    ).rejects.toThrow(/changes_requested/);
  });

  it("updates meta.status to 'cleaned' after cleanup and emits cleaned event", async () => {
    const s = await setup("approved");
    await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
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

  it("is idempotent: re-cleanup is a no-op when worktree is already gone", async () => {
    const s = await setup("approved");
    await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      runId: s.runId,
    });
    // status is now 'cleaned'; re-cleanup should not throw, just no-op
    const r2 = await cleanupRun({
      runsDir: join(s.harnessRoot, "runs"),
      workspacesDir: join(s.harnessRoot, "workspaces"),
      runId: s.runId,
    });
    expect(r2.worktreeRemoved).toBe(false);
    expect(r2.branchRemoved).toBe(false);
  });
});
