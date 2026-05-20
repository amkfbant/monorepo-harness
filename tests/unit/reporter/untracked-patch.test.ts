import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUntrackedPatch,
  buildUntrackedDeniedReport,
} from "../../../src/reporter/untracked-patch.js";

describe("buildUntrackedPatch", () => {
  it("returns empty when no untracked files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    expect(await buildUntrackedPatch(dir, [])).toBe("");
  });

  it("emits a new-file unified diff per text path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    mkdirSync(join(dir, "apps/user"), { recursive: true });
    writeFileSync(
      join(dir, "apps/user/new.ts"),
      "export const x = 1;\nexport const y = 2;\n",
    );
    const patch = await buildUntrackedPatch(dir, ["apps/user/new.ts"]);
    expect(patch).toMatch(
      /diff --git a\/apps\/user\/new\.ts b\/apps\/user\/new\.ts/,
    );
    expect(patch).toMatch(/new file mode 100644/);
    expect(patch).toMatch(/--- \/dev\/null/);
    expect(patch).toMatch(/\+export const x = 1;/);
    expect(patch).toMatch(/\+export const y = 2;/);
  });

  it("omits oversized files with size + sha256 instead of inlining content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const big = "x".repeat(300 * 1024);
    writeFileSync(join(dir, "big.txt"), big);
    const patch = await buildUntrackedPatch(dir, ["big.txt"]);
    expect(patch).toMatch(/omitted \(size=\d+ bytes, sha256=[0-9a-f]{64}\)/);
    expect(patch).not.toMatch(/^\+xxxxx/m);
  });

  it("omits binary files with size + sha256 instead of inlining bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const bytes = Buffer.from([
      0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b,
    ]);
    writeFileSync(join(dir, "out.bin"), bytes);
    const patch = await buildUntrackedPatch(dir, ["out.bin"]);
    expect(patch).toMatch(
      /omitted \(binary, size=16 bytes, sha256=[0-9a-f]{64}\)/,
    );
  });

  it("does not follow symlinks; records target instead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const outside = mkdtempSync(join(tmpdir(), "harness-secret-"));
    writeFileSync(join(outside, "secret"), "SUPERSECRET\n");
    symlinkSync(join(outside, "secret"), join(dir, "leak.ts"));
    const patch = await buildUntrackedPatch(dir, ["leak.ts"]);
    expect(patch).not.toMatch(/SUPERSECRET/);
    expect(patch).toMatch(/@@ symlink @@/);
    expect(patch).toMatch(/symlink target:/);
  });

  it("annotates unreadable paths instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const patch = await buildUntrackedPatch(dir, ["does-not-exist.ts"]);
    expect(patch).toMatch(/unreadable/);
  });
});

describe("buildUntrackedDeniedReport", () => {
  it("records path + size + sha256 without exposing content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-upd-"));
    writeFileSync(join(dir, ".env"), "SECRET=hunter2\n");
    const report = await buildUntrackedDeniedReport(dir, [".env"]);
    expect(report).not.toMatch(/hunter2/);
    expect(report).toMatch(/\.env\s+size=15\s+sha256=[0-9a-f]{64}/);
  });

  it("records symlinks as target-only (no follow)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-upd-"));
    const outside = mkdtempSync(join(tmpdir(), "harness-secret-"));
    writeFileSync(join(outside, "secret"), "SUPERSECRET\n");
    symlinkSync(join(outside, "secret"), join(dir, "leak"));
    const report = await buildUntrackedDeniedReport(dir, ["leak"]);
    expect(report).not.toMatch(/SUPERSECRET/);
    expect(report).toMatch(/leak\s+symlink ->/);
  });

  it("returns empty when no denied paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-upd-"));
    expect(await buildUntrackedDeniedReport(dir, [])).toBe("");
  });
});
