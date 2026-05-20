import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUntrackedPatch } from "../../../src/reporter/untracked-patch.js";

describe("buildUntrackedPatch", () => {
  it("returns empty when no untracked files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    expect(await buildUntrackedPatch(dir, [])).toBe("");
  });

  it("emits a new-file unified diff per path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    mkdirSync(join(dir, "apps/user"), { recursive: true });
    writeFileSync(
      join(dir, "apps/user/new.ts"),
      "export const x = 1;\nexport const y = 2;\n",
    );
    const patch = await buildUntrackedPatch(dir, ["apps/user/new.ts"]);
    expect(patch).toMatch(/diff --git a\/apps\/user\/new\.ts b\/apps\/user\/new\.ts/);
    expect(patch).toMatch(/new file mode 100644/);
    expect(patch).toMatch(/--- \/dev\/null/);
    expect(patch).toMatch(/\+export const x = 1;/);
    expect(patch).toMatch(/\+export const y = 2;/);
  });

  it("notes truncation when the file is too large", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const big = "x".repeat(300 * 1024);
    writeFileSync(join(dir, "big.txt"), big);
    const patch = await buildUntrackedPatch(dir, ["big.txt"]);
    expect(patch).toMatch(/truncated/);
  });

  it("annotates unreadable paths instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const patch = await buildUntrackedPatch(dir, ["does-not-exist.ts"]);
    expect(patch).toMatch(/unreadable/);
  });
});
