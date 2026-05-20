import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRunId } from "../../../src/core/run-id.js";

describe("nextRunId", () => {
  it("returns 001 when runs dir is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const id = nextRunId(root, new Date("2026-05-20T00:00:00Z"));
    expect(id).toBe("run-20260520-001");
  });

  it("increments past existing entries for the same day", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    mkdirSync(join(root, "run-20260520-001"));
    mkdirSync(join(root, "run-20260520-002"));
    mkdirSync(join(root, "run-20260519-099"));
    const id = nextRunId(root, new Date("2026-05-20T12:00:00Z"));
    expect(id).toBe("run-20260520-003");
  });
});
