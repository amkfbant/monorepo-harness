import { describe, expect, it } from "vitest";
import {
  inspectAgentWorkspace,
  AgentWorkspaceError,
  type GitRunner,
} from "../../../src/workspace/agent-workspace.js";

type GitResult = Awaited<ReturnType<GitRunner>>;
const ok = (stdout = ""): GitResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
});
const fail = (over: Partial<GitResult>): GitResult => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
  timedOut: false,
  ...over,
});

/**
 * A fake git that returns a single agent worktree from `worktree list` and
 * lets each subsequent subcommand be overridden, so the inspect fail-closed
 * paths can be exercised without a real timing-out git.
 */
function fakeGit(over: Partial<Record<string, GitResult>> = {}): {
  run: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: GitRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "worktree") {
      return ok(
        "worktree /ws/alice\nHEAD " + "a".repeat(40) + "\nbranch refs/heads/agent/alice\n",
      );
    }
    if (args[0] === "status") return over.status ?? ok("");
    if (args[0] === "rev-parse") return over.revparse ?? ok();
    if (args[0] === "rev-list") return over.revlist ?? ok("0\t0");
    if (args[0] === "log") return over.log ?? ok(`${"a".repeat(40)}\ninit`);
    return ok("");
  };
  return { run, calls };
}

const ctx = (run: GitRunner) => ({
  repoPath: "/repo",
  workspacesDir: "/ws",
  git: run,
});

describe("inspectAgentWorkspace fail-closed", () => {
  it("passes --renames to git status (deterministic rename detection)", async () => {
    const g = fakeGit();
    await inspectAgentWorkspace(ctx(g.run), { agent: "alice", base: "main" });
    const statusCall = g.calls.find((c) => c[0] === "status");
    expect(statusCall).toContain("--renames");
    expect(statusCall).toContain("-z");
  });

  it("throws when git status times out (not read as clean)", async () => {
    const g = fakeGit({ status: fail({ timedOut: true, exitCode: -1 }) });
    await expect(
      inspectAgentWorkspace(ctx(g.run), { agent: "alice", base: "main" }),
    ).rejects.toThrow(AgentWorkspaceError);
  });

  it("throws when base rev-parse times out (not read as base-missing)", async () => {
    const g = fakeGit({ revparse: fail({ timedOut: true, exitCode: -1 }) });
    await expect(
      inspectAgentWorkspace(ctx(g.run), { agent: "alice", base: "main" }),
    ).rejects.toThrow(/rev-parse timed out/);
  });

  it("throws when base rev-parse fails with stderr (a real git error)", async () => {
    const g = fakeGit({ revparse: fail({ stderr: "fatal: not a git repository" }) });
    await expect(
      inspectAgentWorkspace(ctx(g.run), { agent: "alice", base: "main" }),
    ).rejects.toThrow(/rev-parse failed/);
  });

  it("treats a quiet rev-parse miss (exit 1, no stderr) as base-missing, not an error", async () => {
    const g = fakeGit({ revparse: fail({ exitCode: 1, stderr: "" }) });
    const insp = await inspectAgentWorkspace(ctx(g.run), {
      agent: "alice",
      base: "gone",
    });
    expect(insp.baseResolved).toBe(false);
    expect(insp.ahead).toBe(0);
    expect(insp.behind).toBe(0);
  });

  it("throws when git log times out (not silent lastCommit=null)", async () => {
    const g = fakeGit({ log: fail({ timedOut: true, exitCode: -1 }) });
    await expect(
      inspectAgentWorkspace(ctx(g.run), { agent: "alice", base: "main" }),
    ).rejects.toThrow(/log timed out/);
  });
});
