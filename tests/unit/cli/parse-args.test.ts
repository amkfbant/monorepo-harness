import { describe, it, expect } from "vitest";
import { parseArgs } from "../../../src/cli/parse-args.js";

const BASE = [
  "--repo",
  "../target",
  "--repo-id",
  "sample-monorepo",
  "--domain",
  "apps/user",
  "--goal",
  "add validation",
];

describe("parseArgs", () => {
  it("parses required flags", () => {
    const o = parseArgs(BASE);
    expect(o).toMatchObject({
      repo: "../target",
      repoId: "sample-monorepo",
      domain: "apps/user",
      goal: "add validation",
      baseBranch: "main",
      keepWorktree: false,
      dryRun: false,
    });
  });

  it("supports --base-branch / --keep-worktree / --dry-run", () => {
    const o = parseArgs([
      ...BASE,
      "--base-branch",
      "develop",
      "--keep-worktree",
      "--dry-run",
    ]);
    expect(o.baseBranch).toBe("develop");
    expect(o.keepWorktree).toBe(true);
    expect(o.dryRun).toBe(true);
  });

  it("throws when --domain is missing", () => {
    expect(() =>
      parseArgs(["--repo", "x", "--repo-id", "y", "--goal", "z"]),
    ).toThrow();
  });
});
