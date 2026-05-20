import { describe, it, expect } from "vitest";
import { buildSummary } from "../../../src/reporter/summary.js";

describe("buildSummary", () => {
  it("renders success summary with changed files", () => {
    const md = buildSummary({
      runId: "run-1",
      domain: "apps/user",
      goal: "add validation",
      status: "success",
      changedPaths: ["apps/user/profile.ts"],
      violations: [],
      codexExitCode: 0,
    });
    expect(md).toMatch(/# Run run-1/);
    expect(md).toMatch(/Status:\s*success/);
    expect(md).toMatch(/apps\/user\/profile\.ts/);
  });

  it("renders failed-policy-violation with details", () => {
    const md = buildSummary({
      runId: "run-2",
      domain: "apps/user",
      goal: "x",
      status: "failed-policy-violation",
      changedPaths: ["package.json"],
      violations: [{ path: "package.json", reason: "deny_write" }],
      codexExitCode: 0,
    });
    expect(md).toMatch(/failed-policy-violation/);
    expect(md).toMatch(/package\.json.*deny_write/);
  });
});
