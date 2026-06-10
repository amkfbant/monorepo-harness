import { describe, expect, it } from "vitest";
import { ensureProjectVisible } from "../../../src/mcp/tools/tool-helpers.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../../src/mcp/security/config.js";

function configWith(allowedProjects: string[]): McpConfig {
  return { ...DEFAULT_MCP_CONFIG, allowedProjects };
}

describe("ensureProjectVisible (#81)", () => {
  it("is visible (null) when allowedProjects is empty regardless of projectId", () => {
    expect(ensureProjectVisible(configWith([]), undefined)).toBeNull();
    expect(ensureProjectVisible(configWith([]), "anything")).toBeNull();
  });

  it("is visible (null) when projectId is in allowedProjects", () => {
    expect(ensureProjectVisible(configWith(["demo"]), "demo")).toBeNull();
  });

  it("denies a present-but-not-allowed projectId, keeping reason project_not_allowed", () => {
    const denied = ensureProjectVisible(configWith(["other"]), "demo");
    expect(denied).not.toBeNull();
    expect(denied?.status).toBe("permission_denied");
    // existing consumers assert reason/summary contain project_not_allowed
    expect(denied?.summary).toContain("project_not_allowed");
    expect((denied?.data as Record<string, unknown>).reason).toBe(
      "project_not_allowed",
    );
    expect((denied?.data as Record<string, unknown>).projectId).toBe("demo");
    expect((denied?.data as Record<string, unknown>).allowedProjects).toEqual([
      "other",
    ]);
  });

  it("denies an UNSET projectId with an actionable 'projectId is required' message naming allowedProjects (#81)", () => {
    for (const unset of [undefined, null]) {
      const denied = ensureProjectVisible(configWith(["alpha", "beta"]), unset);
      expect(denied).not.toBeNull();
      expect(denied?.status).toBe("permission_denied");
      // the whole point of #81: the unset case must say projectId is required
      expect(denied?.summary).toMatch(/projectId is required/i);
      const data = denied?.data as Record<string, unknown>;
      expect(data.reason).toBe("project_not_allowed");
      expect(data.projectId).toBeNull();
      expect(data.allowedProjects).toEqual(["alpha", "beta"]);
      // a hint mentioning the allowed ids and the repoId-derivation path
      expect(String(data.hint)).toMatch(/alpha/);
    }
  });
});
