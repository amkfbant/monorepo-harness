import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createCloneWorkspace } from "../../src/workspace/git-worktree.js";
import { makeTmpDir } from "../helpers/tmp.js";

// (#410) A run workspace built as `git worktree` shares the target's `.git`
// (config lives in the common dir), so an allowed-command that runs
// `git config core.bare true` inside the worktree corrupts the SHARED config and
// flips the *target* into a bare repo. `createCloneWorkspace` instead makes an
// independent clone — its own `.git` directory — physically severing the shared
// config. These tests pin that isolation plus the origin re-point that keeps
// push / PR reaching GitHub unchanged.

let bareRemote: string; // GitHub stand-in origin
let source: string; // local target (clone source)
let worktreesDir: string;
let baseSha: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

beforeEach(() => {
  bareRemote = makeTmpDir("harness-bare-");
  source = makeTmpDir("harness-src-");
  worktreesDir = makeTmpDir("harness-wt-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bareRemote], {
    stdio: "ignore",
  });
  const r = (args: string[]) =>
    execFileSync("git", args, { cwd: source, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "t@e.com"]);
  r(["config", "user.name", "T"]);
  writeFileSync(join(source, "f.txt"), "x");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);
  r(["remote", "add", "origin", bareRemote]);
  r(["push", "-q", "origin", "main"]);
  baseSha = git(source, ["rev-parse", "HEAD"]);
});

describe("createCloneWorkspace (#410)", () => {
  it("creates a clone checked out on a new branch at base", async () => {
    const wt = await createCloneWorkspace({
      repoPath: source,
      worktreesDir,
      runId: "run-1",
      branch: "harness/run-1/x",
      base: baseSha,
    });
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.branch).toBe("harness/run-1/x");
    expect(git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "harness/run-1/x",
    );
    expect(git(wt.path, ["rev-parse", "HEAD"])).toBe(baseSha);
    // base content is checked out (no longer --no-checkout after `checkout -b`)
    expect(existsSync(join(wt.path, "f.txt"))).toBe(true);
  });

  it("is a clone, not a worktree (.git is a directory, not a gitdir file)", async () => {
    const wt = await createCloneWorkspace({
      repoPath: source,
      worktreesDir,
      runId: "run-kind",
      branch: "harness/run-kind/x",
      base: baseSha,
    });
    // A `git worktree` would write a `.git` FILE ("gitdir: ..." pointer); a clone
    // owns a real `.git` DIRECTORY. This is the schema-free clone/worktree
    // discriminator cleanup/reclaim rely on (Task 3).
    expect(statSync(join(wt.path, ".git")).isDirectory()).toBe(true);
  });

  it("re-points origin from the local target to the target's GitHub remote", async () => {
    const wt = await createCloneWorkspace({
      repoPath: source,
      worktreesDir,
      runId: "run-origin",
      branch: "harness/run-origin/x",
      base: baseSha,
    });
    const origin = git(wt.path, ["remote", "get-url", "origin"]);
    expect(origin).toBe(bareRemote);
    expect(origin).not.toBe(source); // not left pointing at the local clone source
  });

  it("★core.bare written inside the clone does NOT flip the target to bare (#410 core)", async () => {
    const wt = await createCloneWorkspace({
      repoPath: source,
      worktreesDir,
      runId: "run-bare",
      branch: "harness/run-bare/x",
      base: baseSha,
    });
    // Reproduce the #410 trigger inside the workspace: a LOCAL config write
    // (no --global, so the real ~/.gitconfig is untouched).
    execFileSync("git", ["config", "core.bare", "true"], { cwd: wt.path });
    // The clone has its own .git/config — the target must be unaffected.
    expect(git(source, ["rev-parse", "--is-bare-repository"])).toBe("false");
  });

  it("★worktree added inside the clone does NOT leak into the target's .git (#410)", async () => {
    const wt = await createCloneWorkspace({
      repoPath: source,
      worktreesDir,
      runId: "run-leak",
      branch: "harness/run-leak/x",
      base: baseSha,
    });
    const before = git(source, ["worktree", "list", "--porcelain"]);
    const extra = makeTmpDir("harness-extra-");
    // adding a worktree from the clone must register under the CLONE's .git,
    // never the target's .git/worktrees/.
    execFileSync("git", ["worktree", "add", join(extra, "wt"), "HEAD"], {
      cwd: wt.path,
      stdio: "ignore",
    });
    const after = git(source, ["worktree", "list", "--porcelain"]);
    expect(after).toBe(before); // target worktree admin unchanged
  });

  it("origin-less target: removes origin (fail-closed) so a later push loud-fails, clone still succeeds", async () => {
    const noOrigin = makeTmpDir("harness-noorigin-");
    const r = (args: string[]) =>
      execFileSync("git", args, { cwd: noOrigin, stdio: "ignore" });
    r(["init", "-q", "-b", "main"]);
    r(["config", "user.email", "t@e.com"]);
    r(["config", "user.name", "T"]);
    writeFileSync(join(noOrigin, "g.txt"), "y");
    r(["add", "."]);
    r(["commit", "-qm", "init"]);
    const sha = git(noOrigin, ["rev-parse", "HEAD"]);

    const wt = await createCloneWorkspace({
      repoPath: noOrigin,
      worktreesDir,
      runId: "run-noorigin",
      branch: "harness/run-noorigin/x",
      base: sha,
    });
    expect(existsSync(wt.path)).toBe(true); // clone succeeded despite no origin
    // fail-closed: the clone's local-target 'origin' (set by `git clone`) is
    // REMOVED, so the clone has no 'origin' remote at all (#410 P1 fix). Leaving
    // it would let a later push silently land in the local source.
    expect(() => git(wt.path, ["remote", "get-url", "origin"])).toThrow();
    expect(git(wt.path, ["remote"])).toBe(""); // no remotes remain

    // and a push to origin must LOUD-FAIL (not silently push into the source).
    let pushFailed = false;
    try {
      execFileSync("git", ["push", "-u", "origin", "harness/run-noorigin/x"], {
        cwd: wt.path,
        stdio: "ignore",
      });
    } catch {
      pushFailed = true;
    }
    expect(pushFailed).toBe(true);
    // the source must NOT have gained the run branch from a silent local push.
    const sourceBranches = git(noOrigin, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    expect(sourceBranches.split("\n")).not.toContain("harness/run-noorigin/x");
  });
});
