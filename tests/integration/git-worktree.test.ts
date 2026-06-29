import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createWorktree,
  createCloneWorkspace,
  createRunWorkspace,
  removeWorktree,
  pruneWorktrees,
  workspaceGitKind,
} from "../../src/workspace/git-worktree.js";
import { makeTmpDir } from "../helpers/tmp.js";

let repoRoot: string;
let worktreesDir: string;

beforeEach(() => {
  repoRoot = makeTmpDir("harness-src-");
  worktreesDir = makeTmpDir("harness-wt-");
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
      base: "main",
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
      base: "main",
    });
    await removeWorktree({
      repoPath: repoRoot,
      worktreePath: wt.path,
      branch: wt.branch,
    });
    expect(existsSync(wt.path)).toBe(false);
  });
});

describe("pruneWorktrees (#404)", () => {
  // The leak in #404: a run worktree whose working dir vanishes WITHOUT
  // `git worktree remove` (crash / interrupted cleanup) leaves a stale admin
  // entry under the real repo's .git/worktrees/. Unpruned these accumulate and
  // degrade the repo. prune must reclaim them.
  it("reclaims a stale worktree entry whose working dir was deleted", async () => {
    const wt = await createWorktree({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-stale",
      branch: "harness/run-stale/x",
      base: "main",
    });
    // simulate the leak: drop the working dir, leaving the admin entry stale
    rmSync(wt.path, { recursive: true, force: true });
    const before = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
    }).toString();
    expect(before).toContain("run-stale"); // still registered → would accumulate

    await pruneWorktrees({ repoPath: repoRoot });

    const after = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
    }).toString();
    expect(after).not.toContain("run-stale");
  });

  it("never removes a worktree whose working dir still exists", async () => {
    const wt = await createWorktree({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-live",
      branch: "harness/run-live/x",
      base: "main",
    });
    await pruneWorktrees({ repoPath: repoRoot });
    // a live worktree (dir present) is untouched by prune
    expect(existsSync(wt.path)).toBe(true);
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
    }).toString();
    expect(list).toContain("run-live");
  });
});

describe("workspaceGitKind (#410)", () => {
  // The schema-free clone/worktree discriminator cleanup + #404 reclaim rely on:
  // a `git worktree` writes `.git` as a FILE ("gitdir: ..." pointer), a clone
  // owns a real `.git` DIRECTORY, and an unmade/removed workspace has no `.git`.
  it("classifies a real git worktree as 'worktree'", async () => {
    const wt = await createWorktree({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-kind-wt",
      branch: "harness/run-kind-wt/x",
      base: "main",
    });
    expect(workspaceGitKind(wt.path)).toBe("worktree");
  });

  it("classifies an independent clone as 'clone'", async () => {
    const wt = await createCloneWorkspace({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-kind-clone",
      branch: "harness/run-kind-clone/x",
      base: "main",
    });
    expect(workspaceGitKind(wt.path)).toBe("clone");
  });

  it("classifies a path with no workspace as 'absent'", () => {
    expect(workspaceGitKind(join(worktreesDir, "nope", "repo"))).toBe("absent");
  });
});

describe("createRunWorkspace dispatcher (#410 Phase 2 Task 4)", () => {
  // The run-creation path (workflow-runner-inner) calls this single dispatcher
  // with `policy.workspace.isolation`. The default "worktree" arm must be the
  // byte-for-byte legacy `createWorktree` (non-self targets unaffected); the
  // opt-in "clone" arm produces an independent clone with its own `.git` dir.
  it("creates a git worktree when isolation is 'worktree' (legacy default)", async () => {
    const wt = await createRunWorkspace({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-disp-wt",
      branch: "harness/run-disp-wt/x",
      base: "main",
      isolation: "worktree",
    });
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, "f.txt"))).toBe(true);
    expect(wt.branch).toBe("harness/run-disp-wt/x");
    // .git is a FILE pointer for a worktree
    expect(workspaceGitKind(wt.path)).toBe("worktree");
  });

  it("creates an independent clone when isolation is 'clone' (opt-in)", async () => {
    const wt = await createRunWorkspace({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-disp-clone",
      branch: "harness/run-disp-clone/x",
      base: "main",
      isolation: "clone",
    });
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, "f.txt"))).toBe(true);
    expect(wt.branch).toBe("harness/run-disp-clone/x");
    // .git is a real DIRECTORY for an independent clone
    expect(workspaceGitKind(wt.path)).toBe("clone");
  });
});
