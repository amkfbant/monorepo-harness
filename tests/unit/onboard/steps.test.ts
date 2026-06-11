import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGlobalPolicyIfMissing } from "../../../src/onboard/steps.js";

describe("writeGlobalPolicyIfMissing", () => {
  it("writes policies/global.yaml when absent and skips when present", () => {
    const root = mkdtempSync(join(tmpdir(), "onb-glob-"));
    mkdirSync(join(root, "policies"), { recursive: true });
    const wrote1 = writeGlobalPolicyIfMissing(root, { always_deny_write: ["**/.env"] });
    expect(wrote1).toBe(true);
    const wrote2 = writeGlobalPolicyIfMissing(root, { always_deny_write: ["**/.env"] });
    expect(wrote2).toBe(false); // already present
  });
});
