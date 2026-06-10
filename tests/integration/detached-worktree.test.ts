import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDetachedWorktree,
  removeDetachedWorktree,
} from "../../src/workspace/git-worktree.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

/** A repo whose `pull/1/head` ref points at a feature commit (like a GitHub PR). */
function setupRepoWithPrRef(): { repo: string; prSha: string } {
  const repo = mkdtempSync(join(tmpdir(), "harness-detached-"));
  initRepo(repo);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "base"], {
    cwd: repo,
  });
  git(repo, ["checkout", "-q", "-b", "feature"]);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "pr work"], {
    cwd: repo,
  });
  const prSha = git(repo, ["rev-parse", "HEAD"]);
  // emulate a GitHub PR head ref, then return to a clean main
  git(repo, ["update-ref", "refs/pull/1/head", prSha]);
  git(repo, ["checkout", "-q", "main"]);
  return { repo, prSha };
}

describe("createDetachedWorktree (#82)", () => {
  it("checks out a commit detached without occupying any branch", async () => {
    const { repo, prSha } = setupRepoWithPrRef();
    const wt = join(repo, ".verify", "repo");
    const { path } = await createDetachedWorktree({
      repoPath: repo,
      worktreePath: wt,
      commitish: prSha,
    });
    expect(existsSync(path)).toBe(true);
    // HEAD in the verify worktree is detached at the PR sha
    expect(git(path, ["rev-parse", "HEAD"])).toBe(prSha);
    // detached HEAD has no branch: --abbrev-ref reports the literal "HEAD"
    expect(git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
    await removeDetachedWorktree({ repoPath: repo, worktreePath: wt });
    expect(existsSync(path)).toBe(false);
  });

  it("succeeds where a non-detached checkout of the occupied PR branch would fail (#82 core)", async () => {
    const { repo, prSha } = setupRepoWithPrRef();
    // a worktree already occupies branch "feature" (the PR's branch)
    git(repo, ["worktree", "add", join(repo, ".occupied"), "feature"]);
    // a NON-detached checkout of the same branch fails — branch already in use
    expect(() =>
      git(repo, ["worktree", "add", join(repo, ".x"), "feature"]),
    ).toThrow(/already used by worktree|already checked out/);
    // but a detached verify worktree of the same commit succeeds (no branch)
    const wt = join(repo, ".verify", "repo");
    const { path } = await createDetachedWorktree({
      repoPath: repo,
      worktreePath: wt,
      commitish: prSha,
    });
    expect(git(path, ["rev-parse", "HEAD"])).toBe(prSha);
  });
});
