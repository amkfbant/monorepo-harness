import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexBinaryVersion } from "../../../src/codex/codex-version.js";

function writeExecutableScript(dir: string, body: string): string {
  const path = join(dir, "fake-codex-version.js");
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("codexBinaryVersion", () => {
  it("returns the trimmed first stdout line and caches per binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-codex-version-"));
    const countPath = join(dir, "count.txt");
    const bin = writeExecutableScript(
      dir,
      [
        "const fs = require('node:fs');",
        `const countPath = ${JSON.stringify(countPath)};`,
        "const current = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;",
        "fs.writeFileSync(countPath, String(current + 1));",
        "process.stdout.write('codex-cli 1.2.3  \\nsecond line\\n');",
      ].join("\n"),
    );

    expect(codexBinaryVersion(bin)).toBe("codex-cli 1.2.3");
    expect(codexBinaryVersion(bin)).toBe("codex-cli 1.2.3");
    expect(readFileSync(countPath, "utf8")).toBe("1");
  });

  it("fails open to null when the version command fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-codex-version-fail-"));
    const bin = writeExecutableScript(dir, "process.exit(7);");

    expect(codexBinaryVersion(bin)).toBeNull();
  });
});
