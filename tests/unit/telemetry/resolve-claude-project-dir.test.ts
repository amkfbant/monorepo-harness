import { describe, it, expect } from "vitest";
import {
  encodeClaudeProjectPath,
  resolveClaudeProjectDir,
} from "../../../src/telemetry/resolve-claude-project-dir.js";

describe("encodeClaudeProjectPath", () => {
  it("dash-encodes an absolute path like Claude does", () => {
    expect(encodeClaudeProjectPath("/Users/kn/ops/monorepo-harness")).toBe(
      "-Users-kn-ops-monorepo-harness",
    );
  });
});

describe("resolveClaudeProjectDir", () => {
  it("encodes the LITERAL harnessRoot (no realpath) under ~/.claude/projects", () => {
    expect(
      resolveClaudeProjectDir({
        harnessRoot: "/Users/kn/ops/monorepo-harness",
        homeDir: "/Users/kn",
      }),
    ).toBe("/Users/kn/.claude/projects/-Users-kn-ops-monorepo-harness");
  });
  it("honors an explicit override verbatim", () => {
    expect(
      resolveClaudeProjectDir({
        harnessRoot: "/x",
        override: "/custom/dir",
        homeDir: "/Users/kn",
      }),
    ).toBe("/custom/dir");
  });
});
