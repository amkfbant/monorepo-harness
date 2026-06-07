import { describe, expect, it } from "vitest";
import {
  agentBranch,
  agentNameFromBranch,
  assertAgentName,
  AgentWorkspaceError,
  parseAheadBehind,
  parseStatusPorcelain,
  parseWorktreePorcelain,
} from "../../../src/workspace/agent-workspace.js";

describe("parseWorktreePorcelain", () => {
  it("parses worktree blocks (path / head / branch)", () => {
    const out = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo.agents/alice",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/agent/alice",
      "",
    ].join("\n");
    expect(parseWorktreePorcelain(out)).toEqual([
      {
        path: "/repo",
        head: "1111111111111111111111111111111111111111",
        branch: "main",
      },
      {
        path: "/repo.agents/alice",
        head: "2222222222222222222222222222222222222222",
        branch: "agent/alice",
      },
    ]);
  });

  it("represents a detached worktree with a null branch", () => {
    const out = [
      "worktree /repo/workspaces/run-x/repo",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreePorcelain(out)).toEqual([
      {
        path: "/repo/workspaces/run-x/repo",
        head: "3333333333333333333333333333333333333333",
        branch: null,
      },
    ]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
    expect(parseWorktreePorcelain("\n\n")).toEqual([]);
  });
});

describe("agent name <-> branch", () => {
  it("maps an agent name to the agent/<name> branch and back", () => {
    expect(agentBranch("alice")).toBe("agent/alice");
    expect(agentNameFromBranch("agent/alice")).toBe("alice");
    expect(agentNameFromBranch("agent/team/bob")).toBe("team/bob");
  });

  it("returns null for a non-agent branch", () => {
    expect(agentNameFromBranch("main")).toBeNull();
    expect(agentNameFromBranch(null)).toBeNull();
  });

  it("accepts safe agent names and rejects unsafe ones", () => {
    expect(() => assertAgentName("alice")).not.toThrow();
    expect(() => assertAgentName("agent-2.worktree_1")).not.toThrow();
    expect(() => assertAgentName("")).toThrow(AgentWorkspaceError);
    expect(() => assertAgentName("../escape")).toThrow(AgentWorkspaceError);
    expect(() => assertAgentName("has space")).toThrow(AgentWorkspaceError);
    expect(() => assertAgentName("white/space bad")).toThrow(AgentWorkspaceError);
  });
});

describe("parseStatusPorcelain (NUL-delimited -z)", () => {
  it("extracts changed paths from NUL records", () => {
    const out = " M src/a.ts\0?? new.txt\0A  staged.ts\0";
    expect(parseStatusPorcelain(out)).toEqual([
      "src/a.ts",
      "new.txt",
      "staged.ts",
    ]);
  });

  it("reports the rename destination and skips the original path record", () => {
    const out = "R  new name.ts\0old name.ts\0 M other.ts\0";
    expect(parseStatusPorcelain(out)).toEqual(["new name.ts", "other.ts"]);
  });

  it("is empty for a clean tree", () => {
    expect(parseStatusPorcelain("")).toEqual([]);
    expect(parseStatusPorcelain("\0")).toEqual([]);
  });
});

describe("parseAheadBehind", () => {
  it("maps `<behind>\\t<ahead>` from rev-list --left-right --count", () => {
    expect(parseAheadBehind("2\t5")).toEqual({ behind: 2, ahead: 5 });
    expect(parseAheadBehind("0\t0\n")).toEqual({ behind: 0, ahead: 0 });
  });

  it("throws (fail-closed) on malformed output rather than reading zeros", () => {
    expect(() => parseAheadBehind("")).toThrow(AgentWorkspaceError);
    expect(() => parseAheadBehind("garbage")).toThrow(AgentWorkspaceError);
    expect(() => parseAheadBehind("1 2 3")).toThrow(AgentWorkspaceError);
    expect(() => parseAheadBehind("-1\t2")).toThrow(AgentWorkspaceError);
  });
});
