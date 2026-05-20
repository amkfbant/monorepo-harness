import { describe, it, expect } from "vitest";
import { buildSummary } from "../../../src/reporter/summary.js";

const BASE = {
  runId: "run-1",
  domain: "apps/user",
  goal: "add validation",
  changedPaths: ["apps/user/profile.ts"] as string[],
  untrackedPaths: [] as string[],
  ignoredUntrackedPaths: [] as string[],
  secretSuspectPaths: [] as string[],
  violations: [],
  codexExitCode: 0,
  codexTimedOut: false,
  codexStdoutTail: "applied",
  codexStderrTail: "",
} as const;

describe("buildSummary", () => {
  it("renders needs_review with tracked + untracked + ignored sections", () => {
    const md = buildSummary({
      ...BASE,
      status: "needs_review",
      safetyStatus: "allowed",
      untrackedPaths: ["apps/user/new.ts"],
      ignoredUntrackedPaths: ["node_modules/foo"],
      codexStderrTail: "warning: rate limit",
    });
    expect(md).toMatch(/Status: needs_review/);
    expect(md).toMatch(/Safety status: allowed/);
    expect(md).toMatch(/apps\/user\/profile\.ts/);
    expect(md).toMatch(/apps\/user\/new\.ts/);
    expect(md).toMatch(/Ignored by ignore_untracked/);
    expect(md).toMatch(/node_modules\/foo/);
    expect(md).toMatch(/warning: rate limit/);
  });

  it("renders failed-policy-violation with violations and safety denied", () => {
    const md = buildSummary({
      ...BASE,
      status: "failed-policy-violation",
      safetyStatus: "denied",
      changedPaths: ["package.json"],
      violations: [{ path: "package.json", reason: "deny_write" }],
    });
    expect(md).toMatch(/failed-policy-violation/);
    expect(md).toMatch(/Safety status: denied/);
    expect(md).toMatch(/package\.json.*deny_write/);
  });

  it("marks codex timeout and shows stderr tail", () => {
    const md = buildSummary({
      ...BASE,
      status: "failed-codex-timeout",
      safetyStatus: "allowed",
      codexExitCode: -1,
      codexTimedOut: true,
      codexStdoutTail: "",
      codexStderrTail: "rate limit exceeded",
    });
    expect(md).toMatch(/TIMEOUT/);
    expect(md).toMatch(/rate limit exceeded/);
  });

  it("highlights secret-suspect files when present", () => {
    const md = buildSummary({
      ...BASE,
      status: "needs_review",
      safetyStatus: "allowed",
      untrackedPaths: ["apps/user/.env.local"],
      secretSuspectPaths: ["apps/user/.env.local"],
    });
    expect(md).toMatch(/Secret-shaped files/);
    expect(md).toMatch(/apps\/user\/\.env\.local/);
  });

  it("notes diff collection failure and skipped validation", () => {
    const md = buildSummary({
      ...BASE,
      status: "failed-diff-collection",
      safetyStatus: "skipped",
      diffCollectionError: "git diff exited 128",
      codexStdoutTail: "",
    });
    expect(md).toMatch(/Diff collection/);
    expect(md).toMatch(/git diff exited 128/);
    expect(md).toMatch(/Safety status: skipped/);
  });
});
