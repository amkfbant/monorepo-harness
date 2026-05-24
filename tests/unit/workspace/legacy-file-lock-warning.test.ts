import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  warnLegacyFileLocks,
  _resetLegacyFileLockWarning,
} from "../../../src/workspace/legacy-file-lock-warning.js";

describe("warnLegacyFileLocks", () => {
  let tmpRoot: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "legacy-lock-warn-"));
    _resetLegacyFileLockWarning();
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    delete process.env.HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    _resetLegacyFileLockWarning();
    delete process.env.HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING;
  });

  it("does not warn when locks dir does not exist", () => {
    warnLegacyFileLocks(join(tmpRoot, "does-not-exist"));
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not warn when locks dir is empty", () => {
    const locksDir = join(tmpRoot, "locks");
    mkdirSync(locksDir);
    warnLegacyFileLocks(locksDir);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not warn when locks dir has only non-.lock files", () => {
    const locksDir = join(tmpRoot, "locks");
    mkdirSync(locksDir);
    writeFileSync(join(locksDir, "README.md"), "ignore me");
    warnLegacyFileLocks(locksDir);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("warns once when locks dir contains .lock files", () => {
    const locksDir = join(tmpRoot, "locks");
    mkdirSync(locksDir);
    writeFileSync(join(locksDir, "apps-catalog.lock"), "{}");
    warnLegacyFileLocks(locksDir);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const msg = String(stderrSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("legacy file domain lock");
    expect(msg).toContain("apps-catalog.lock");
    expect(msg).toContain("HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING");
  });

  it("warns only once per process even when called multiple times", () => {
    const locksDir = join(tmpRoot, "locks");
    mkdirSync(locksDir);
    writeFileSync(join(locksDir, "apps-catalog.lock"), "{}");
    warnLegacyFileLocks(locksDir);
    warnLegacyFileLocks(locksDir);
    warnLegacyFileLocks(locksDir);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("is silent when HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING=1", () => {
    const locksDir = join(tmpRoot, "locks");
    mkdirSync(locksDir);
    writeFileSync(join(locksDir, "apps-catalog.lock"), "{}");
    process.env.HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING = "1";
    warnLegacyFileLocks(locksDir);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("lists up to 3 file names then '+N more' suffix", () => {
    const locksDir = join(tmpRoot, "locks");
    mkdirSync(locksDir);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(locksDir, `lock-${i}.lock`), "{}");
    }
    warnLegacyFileLocks(locksDir);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const msg = String(stderrSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("+2 more");
  });
});
