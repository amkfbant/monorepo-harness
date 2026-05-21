import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeReviewedFingerprint } from "../../../src/core/reviewed-fingerprint.js";

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "harness-fp-"));
}

describe("computeReviewedFingerprint", () => {
  it("is stable for unchanged content", async () => {
    const w = workdir();
    writeFileSync(join(w, "a.ts"), "export const a = 1;\n");
    const f1 = await computeReviewedFingerprint(w, ["a.ts"]);
    const f2 = await computeReviewedFingerprint(w, ["a.ts"]);
    expect(f1).toBe(f2);
  });

  it("changes when file content changes", async () => {
    const w = workdir();
    writeFileSync(join(w, "a.ts"), "export const a = 1;\n");
    const before = await computeReviewedFingerprint(w, ["a.ts"]);
    writeFileSync(join(w, "a.ts"), "export const a = 2;\n");
    expect(await computeReviewedFingerprint(w, ["a.ts"])).not.toBe(before);
  });

  it("changes on a mode-only (chmod) change", async () => {
    const w = workdir();
    const p = join(w, "s.sh");
    writeFileSync(p, "echo hi\n");
    chmodSync(p, 0o644);
    const before = await computeReviewedFingerprint(w, ["s.sh"]);
    chmodSync(p, 0o755);
    expect(await computeReviewedFingerprint(w, ["s.sh"])).not.toBe(before);
  });

  it("distinguishes a deleted path from one replaced by a directory", async () => {
    const w = workdir();
    writeFileSync(join(w, "x"), "data\n");
    const asFile = await computeReviewedFingerprint(w, ["x"]);
    rmSync(join(w, "x"));
    const asAbsent = await computeReviewedFingerprint(w, ["x"]);
    mkdirSync(join(w, "x"));
    const asDir = await computeReviewedFingerprint(w, ["x"]);
    expect(asAbsent).not.toBe(asFile);
    expect(asDir).not.toBe(asAbsent);
    expect(asDir).not.toBe(asFile);
  });

  it("detects a regular file replaced by a symlink with identical bytes", async () => {
    const w = workdir();
    writeFileSync(join(w, "target"), "payload\n");
    writeFileSync(join(w, "p"), "payload\n");
    const asFile = await computeReviewedFingerprint(w, ["p"]);
    rmSync(join(w, "p"));
    symlinkSync(join(w, "target"), join(w, "p")); // resolves to identical bytes
    const asSymlink = await computeReviewedFingerprint(w, ["p"]);
    // symlink is NOT followed — the fingerprint must differ from the file
    expect(asSymlink).not.toBe(asFile);
  });

  it("changes when a symlink's target changes", async () => {
    const w = workdir();
    symlinkSync("/etc/one", join(w, "link"));
    const before = await computeReviewedFingerprint(w, ["link"]);
    unlinkSync(join(w, "link"));
    symlinkSync("/etc/two", join(w, "link"));
    expect(await computeReviewedFingerprint(w, ["link"])).not.toBe(before);
  });
});
