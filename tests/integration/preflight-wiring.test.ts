import { afterEach, describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Guard the #68 wiring: BOTH worktree-creation paths must call the symlink
// preflight before creating a worktree. Mock it to throw, then assert each
// path propagates — a refactor that drops the assertSymlinkCapable call fails.
vi.mock("../../src/workspace/fs-preflight.js", () => ({
  assertSymlinkCapable: vi.fn(() => {
    throw new Error("PROBE-BLOCKED");
  }),
}));

import { createWorktree } from "../../src/workspace/git-worktree.js";
import { createAgentWorkspace } from "../../src/workspace/agent-workspace.js";

const tempRepos: string[] = [];
afterEach(() => {
  for (const r of tempRepos.splice(0)) rmSync(r, { recursive: true, force: true });
});

function freshRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-preflight-"));
  tempRepos.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "base"], {
    cwd: repo,
  });
  return repo;
}

describe("symlink preflight is wired into both worktree-creation paths (#68)", () => {
  it("createWorktree (run worktree) asserts symlink capability before git", async () => {
    await expect(
      createWorktree({
        repoPath: freshRepo(),
        worktreesDir: join(tmpdir(), "wt-dir"),
        runId: "run-x",
        branch: "harness/run-x/web",
        base: "main",
      }),
    ).rejects.toThrow("PROBE-BLOCKED");
  });

  it("createAgentWorkspace (agent workspace) asserts symlink capability before git add", async () => {
    const repo = freshRepo();
    await expect(
      createAgentWorkspace(
        { repoPath: repo, workspacesDir: join(repo, ".agents") },
        { agent: "alice", base: "main" },
      ),
    ).rejects.toThrow("PROBE-BLOCKED");
  });
});
