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
  buildUntrackedSecretsReport,
} from "../../../src/reporter/untracked-patch.js";

describe("buildUntrackedPatch", () => {
  it("returns empty when no untracked files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const r = await buildUntrackedPatch(dir, []);
    expect(r.patch).toBe("");
    expect(r.secretSuspects).toEqual([]);
  });

  it("emits a new-file unified diff per text path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    mkdirSync(join(dir, "apps/user"), { recursive: true });
    writeFileSync(
      join(dir, "apps/user/new.ts"),
      "export const x = 1;\nexport const y = 2;\n",
    );
    const r = await buildUntrackedPatch(dir, ["apps/user/new.ts"]);
    expect(r.patch).toMatch(
      /diff --git a\/apps\/user\/new\.ts b\/apps\/user\/new\.ts/,
    );
    expect(r.patch).toMatch(/\+export const x = 1;/);
    expect(r.secretSuspects).toEqual([]);
  });

  it("omits oversized files with size + sha256 instead of inlining content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const big = "x".repeat(300 * 1024);
    writeFileSync(join(dir, "big.txt"), big);
    const r = await buildUntrackedPatch(dir, ["big.txt"]);
    expect(r.patch).toMatch(/omitted \(size=\d+ bytes, sha256=[0-9a-f]{64}\)/);
    expect(r.patch).not.toMatch(/^\+xxxxx/m);
  });

  it("omits binary files with size + sha256 instead of inlining bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const bytes = Buffer.from([
      0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b,
    ]);
    writeFileSync(join(dir, "out.bin"), bytes);
    const r = await buildUntrackedPatch(dir, ["out.bin"]);
    expect(r.patch).toMatch(
      /omitted \(binary, size=16 bytes, sha256=[0-9a-f]{64}\)/,
    );
  });

  it("does not follow symlinks; records target instead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const outside = mkdtempSync(join(tmpdir(), "harness-secret-"));
    writeFileSync(join(outside, "secret"), "SUPERSECRET\n");
    symlinkSync(join(outside, "secret"), join(dir, "leak.ts"));
    const r = await buildUntrackedPatch(dir, ["leak.ts"]);
    expect(r.patch).not.toMatch(/SUPERSECRET/);
    expect(r.patch).toMatch(/@@ symlink @@/);
    expect(r.patch).toMatch(/symlink target:/);
  });

  it("annotates unreadable paths instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    const r = await buildUntrackedPatch(dir, ["does-not-exist.ts"]);
    expect(r.patch).toMatch(/unreadable/);
  });

  it("redacts files matched by secret filename heuristic (no content inline)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    mkdirSync(join(dir, "apps/user"), { recursive: true });
    writeFileSync(
      join(dir, "apps/user/.env.local"),
      "DB_URL=postgres://user:secret@host/db\n",
    );
    const r = await buildUntrackedPatch(dir, ["apps/user/.env.local"]);
    expect(r.patch).not.toMatch(/postgres:\/\//);
    expect(r.patch).toMatch(/@@ secret-suspect/);
    expect(r.secretSuspects).toHaveLength(1);
    expect(r.secretSuspects[0]?.path).toBe("apps/user/.env.local");
    expect(r.secretSuspects[0]?.reasons).toEqual(
      expect.arrayContaining(["filename:.env"]),
    );
  });

  it("redacts files matched by secret content heuristic (PEM, AWS, OpenAI)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-up-"));
    writeFileSync(
      join(dir, "notes.md"),
      "Here is a key: AKIAIOSFODNN7EXAMPLE\n",
    );
    const r = await buildUntrackedPatch(dir, ["notes.md"]);
    expect(r.patch).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(r.secretSuspects[0]?.reasons).toContain(
      "content:aws-access-key-id",
    );
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

describe("buildUntrackedSecretsReport", () => {
  it("formats suspects with reasons", () => {
    const out = buildUntrackedSecretsReport([
      { path: "apps/user/.env.local", reasons: ["filename:.env"] },
      {
        path: "apps/user/notes.md",
        reasons: ["content:aws-access-key-id"],
      },
    ]);
    expect(out).toMatch(/apps\/user\/\.env\.local\s+reasons=filename:\.env/);
    expect(out).toMatch(
      /apps\/user\/notes\.md\s+reasons=content:aws-access-key-id/,
    );
  });

  it("returns empty when no suspects", () => {
    expect(buildUntrackedSecretsReport([])).toBe("");
  });
});
