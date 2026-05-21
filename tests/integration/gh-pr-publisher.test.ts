import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGhPrPublisher } from "../../src/core/gh-pr-publisher.js";

/** Write a fake `gh` executable that sleeps (to trigger the timeout). */
function writeSlowGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  writeFileSync(bin, "#!/bin/sh\nsleep 10\n");
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

describe("gh PR publisher", () => {
  it("a gh timeout fails loudly (not swallowed by the idempotency lookup)", async () => {
    const slowGh = writeSlowGh();
    // 300ms timeout — the fake gh sleeps 10s, so `gh pr list` times out.
    const publisher = createGhPrPublisher(slowGh, 300);
    await expect(
      publisher.publish({
        repoDir: tmpdir(),
        base: "main",
        head: "harness/x",
        title: "t",
        body: "b",
        draft: true,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
