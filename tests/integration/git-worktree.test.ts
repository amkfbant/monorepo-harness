import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  removeWorktree,
} from "../../src/workspace/git-worktree.js";

let repoRoot: string;
let worktreesDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "harness-src-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "harness-wt-"));
  const r = (args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "t@e.com"]);
  r(["config", "user.name", "T"]);
  writeFileSync(join(repoRoot, "f.txt"), "x");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);
});

describe("createWorktree / removeWorktree", () => {
  it("creates a worktree on a new branch from baseBranch", async () => {
    const wt = await createWorktree({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-1",
      branch: "harness/run-1/x",
      baseBranch: "main",
    });
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, "f.txt"))).toBe(true);
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: wt.path,
    })
      .toString()
      .trim();
    expect(branch).toBe("harness/run-1/x");
  });

  it("removes worktree and prunes the branch on cleanup", async () => {
    const wt = await createWorktree({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-2",
      branch: "harness/run-2/x",
      baseBranch: "main",
    });
    await removeWorktree({
      repoPath: repoRoot,
      worktreePath: wt.path,
      branch: wt.branch,
    });
    expect(existsSync(wt.path)).toBe(false);
  });
});
