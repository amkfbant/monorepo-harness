import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack } from "../../../src/project/context-pack-builder.js";
import type { NormalizedContextPack } from "../../../src/project/context-pack-spec.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-cpb-"));
  writeFileSync(join(dir, "README.md"), "# readme\n");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "guide.md"), "guide\n");
  return dir;
}

function pack(o: Partial<NormalizedContextPack> & { globs: string[] }): NormalizedContextPack {
  return {
    id: o.id ?? "test-pack",
    globs: o.globs,
    maxBytes: o.maxBytes ?? 32768,
    denySecretLike: o.denySecretLike ?? true,
    binary: o.binary ?? "skip",
    missing: o.missing ?? "warn",
  };
}

describe("buildContextPack", () => {
  it("E5-6-3: collects files matching the pack globs", async () => {
    const r = await buildContextPack(
      repo(),
      pack({ globs: ["README.md", "docs/**/*.md"] }),
    );
    const included = r.files.filter((f) => f.included).map((f) => f.path);
    expect(included).toEqual(["README.md", "docs/guide.md"]);
    expect(r.includedBytes).toBeGreaterThan(0);
  });

  it("warns when a glob matches nothing", async () => {
    const r = await buildContextPack(
      repo(),
      pack({ globs: ["nonexistent/**"] }),
    );
    expect(r.findings.some((f) => /matched no file/.test(f.message))).toBe(
      true,
    );
  });

  it("E5-6-4: withholds a secret-shaped file", async () => {
    const dir = repo();
    writeFileSync(
      join(dir, ".env"),
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz12\n",
    );
    const r = await buildContextPack(dir, pack({ globs: [".env"] }));
    const envFile = r.files.find((f) => f.path === ".env");
    expect(envFile?.included).toBe(false);
    expect(r.findings.some((f) => f.level === "error")).toBe(true);
  });

  it("skips a binary file", async () => {
    const dir = repo();
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    const r = await buildContextPack(dir, pack({ globs: ["blob.bin"] }));
    expect(r.files.find((f) => f.path === "blob.bin")?.included).toBe(false);
  });

  it("E5-6-5: enforces the byte cap", async () => {
    const dir = repo();
    writeFileSync(join(dir, "big.md"), "x".repeat(500));
    const r = await buildContextPack(
      dir,
      pack({ globs: ["big.md"], maxBytes: 100 }),
    );
    expect(r.files.find((f) => f.path === "big.md")?.included).toBe(false);
  });
});
