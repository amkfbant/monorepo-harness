import { describe, expect, it } from "vitest";
import {
  agentBranch,
  agentNameFromBranch,
  assertAgentName,
  AgentWorkspaceError,
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
