import { describe, it, expect } from "vitest";
import { buildSummary } from "../../../src/reporter/summary.js";

describe("buildSummary", () => {
  it("renders a needs_review summary with tracked + untracked files and codex tail", () => {
    const md = buildSummary({
      runId: "run-1",
      domain: "apps/user",
      goal: "add validation",
      status: "needs_review",
      changedPaths: ["apps/user/profile.ts"],
      untrackedPaths: ["apps/user/profile.test.ts"],
      violations: [],
      codexExitCode: 0,
      codexTimedOut: false,
      codexStdoutTail: "applied 2 files. ready for review.",
    });
    expect(md).toMatch(/# Run run-1/);
    expect(md).toMatch(/Status: needs_review/);
    expect(md).toMatch(/apps\/user\/profile\.ts/);
    expect(md).toMatch(/apps\/user\/profile\.test\.ts/);
    expect(md).toMatch(/applied 2 files\. ready for review\./);
  });

  it("renders failed-policy-violation with details", () => {
    const md = buildSummary({
      runId: "run-2",
      domain: "apps/user",
      goal: "x",
      status: "failed-policy-violation",
      changedPaths: ["package.json"],
      untrackedPaths: [],
      violations: [{ path: "package.json", reason: "deny_write" }],
      codexExitCode: 0,
      codexTimedOut: false,
      codexStdoutTail: "",
    });
    expect(md).toMatch(/failed-policy-violation/);
    expect(md).toMatch(/package\.json.*deny_write/);
  });

  it("marks codex timeout in the exit code line", () => {
    const md = buildSummary({
      runId: "run-3",
      domain: "apps/user",
      goal: "x",
      status: "failed-codex-timeout",
      changedPaths: [],
      untrackedPaths: [],
      violations: [],
      codexExitCode: -1,
      codexTimedOut: true,
      codexStdoutTail: "",
    });
    expect(md).toMatch(/TIMEOUT/);
  });
});
