import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countTextLinesStreaming } from "../../../src/core/workflow-runner.js";

describe("countTextLinesStreaming", () => {
  it("counts large text files without loading the file as one buffer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-budget-lines-"));
    const path = join(dir, "large.txt");
    const lines = 50_000;
    writeFileSync(
      path,
      `${Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")}\n`,
    );

    await expect(countTextLinesStreaming(path)).resolves.toBe(lines);
  });

  it("counts a final unterminated line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-budget-lines-"));
    const path = join(dir, "unterminated.txt");
    writeFileSync(path, "one\ntwo");

    await expect(countTextLinesStreaming(path)).resolves.toBe(2);
  });

  it("treats binary-looking files as zero text lines from the leading sample", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-budget-lines-"));
    const nulPath = join(dir, "nul.bin");
    const invalidUtf8Path = join(dir, "invalid.bin");
    writeFileSync(nulPath, Buffer.from([0x61, 0x00, 0x0a, 0x62]));
    writeFileSync(invalidUtf8Path, Buffer.from([0xff, 0x0a, 0x61]));

    await expect(countTextLinesStreaming(nulPath)).resolves.toBe(0);
    await expect(countTextLinesStreaming(invalidUtf8Path)).resolves.toBe(0);
  });
});
