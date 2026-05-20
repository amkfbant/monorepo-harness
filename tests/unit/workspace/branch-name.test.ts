import { describe, it, expect } from "vitest";
import { runBranchName } from "../../../src/workspace/branch-name.js";

describe("runBranchName", () => {
  it("uses harness/run-<id>/<domain-slug> format", () => {
    expect(runBranchName("run-20260520-001", "apps/user")).toBe(
      "harness/run-20260520-001/apps-user",
    );
  });

  it("slugifies disallowed characters", () => {
    expect(runBranchName("run-20260520-002", "Apps/User Profile")).toBe(
      "harness/run-20260520-002/apps-user-profile",
    );
  });
});
