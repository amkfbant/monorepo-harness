import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { repairCoreBareFlip } from "../../../src/core/run-worktree-gc.js";
import { makeTmpDir } from "../../helpers/tmp.js";

/**
 * #410 guard: a run-workspace corruption can flip the target repo's shared
 * .git/config to core.bare=true, which bricks every subsequent git op. The
 * run-start guard must detect and repair this. Real git in mkdtemp only — the
 * flip uses `git config core.bare true` (LOCAL config of the tmp repo, NOT
 * --global), so the operator's real ~/.gitconfig is never touched.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = makeTmpDir("harness-410-bare-");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@e.com"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "hi\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

const isBare = (repo: string) =>
  git(repo, ["rev-parse", "--is-bare-repository"]);

describe("repairCoreBareFlip (#410)", () => {
  it("repairs a core.bare=true flip back to false", async () => {
    const repo = makeRepo();
    git(repo, ["config", "core.bare", "true"]);
    expect(isBare(repo)).toBe("true"); // precondition: bricked

    const r = await repairCoreBareFlip({ repoPath: repo });

    expect(r.repaired).toBe(true);
    expect(isBare(repo)).toBe("false");
    // work-tree ops succeed again (would throw "must be run in a work tree" if bare)
    expect(() => git(repo, ["status", "--porcelain"])).not.toThrow();
  });

  it("leaves a healthy (non-bare) repo untouched", async () => {
    const repo = makeRepo();
    expect(isBare(repo)).toBe("false");

    const r = await repairCoreBareFlip({ repoPath: repo });

    expect(r.repaired).toBe(false);
    expect(isBare(repo)).toBe("false");
  });

  it("is a no-op (no throw) on a non-git path", async () => {
    const notRepo = makeTmpDir("harness-410-notgit-");
    const r = await repairCoreBareFlip({ repoPath: notRepo });
    expect(r.repaired).toBe(false);
  });
});
