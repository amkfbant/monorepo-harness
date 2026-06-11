import { describe, it, expect } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../../src/mcp/security/config.js";
import { assertNoRenamedGoalOps } from "../../../src/mcp/security/config.js";

describe("hitch confirmation defaults + stale goal config detection (SP-0)", () => {
  it("hitch.close/cancel/expand_scope require confirmation by default", () => {
    for (const op of ["hitch.close", "hitch.cancel", "hitch.expand_scope"]) {
      expect(DEFAULT_MCP_CONFIG.requireConfirmation).toContain(op);
    }
    expect(DEFAULT_MCP_CONFIG.requireConfirmation).not.toContain("goal.close");
  });
  it("a config with a stale goal.* operation is refused (fail-closed)", () => {
    expect(() => assertNoRenamedGoalOps({ requireConfirmation: ["goal.close"] })).toThrow(
      /renamed|goal\./i,
    );
    expect(() =>
      assertNoRenamedGoalOps({ requireConfirmation: ["hitch.close"] }),
    ).not.toThrow();
  });
});
