import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPolicySalvage } from "../../../src/core/policy-salvage.js";

describe("buildPolicySalvage", () => {
  it("degrades to unavailable when allowed tracked patch collection fails", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "harness-policy-salvage-"));
    try {
      const salvage = await buildPolicySalvage({
        safetyStatus: "denied",
        runDir,
        worktreePath: join(runDir, "missing-repo"),
        baseSha: "0".repeat(40),
        gitTimeoutMs: 1,
        trackedChangedPaths: ["apps/user/a.ts"],
        violations: [{ path: "README.md", reason: "not_in_write_scope" }],
        untrackedAllowed: [],
        untrackedDenied: [],
        untrackedAllowedPatch: "",
      });

      expect(salvage).toEqual({
        available: false,
        allowedPaths: ["apps/user/a.ts"],
        deniedPaths: ["README.md"],
        recommendedNextAction: "rerun from base or discard this failed run",
      });
      expect(existsSync(join(runDir, "policy-allowed.patch"))).toBe(false);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
