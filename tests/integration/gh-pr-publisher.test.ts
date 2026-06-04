import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGhPrPublisher,
  createGhPrMerger,
} from "../../src/core/gh-pr-publisher.js";

/** Write a fake `gh` executable that sleeps (to trigger the timeout). */
function writeSlowGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  writeFileSync(bin, "#!/bin/sh\nsleep 10\n");
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

/**
 * Write a fake `gh` that branches on the subcommand. `pr view` reports the
 * given state; `pr merge` records the call to `$dir/merge-called` and exits 0.
 */
function writeFakeGh(state: "OPEN" | "MERGED"): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  printf '{"state":"${state}","mergedAt":${state === "MERGED" ? '"2026-06-05T00:00:00Z"' : "null"}}'`,
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then',
    `  echo "$@" > "${dir}/merge-called"`,
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
  writeFileSync(bin, `${script}\n`);
  execFileSync("chmod", ["+x", bin]);
  return { bin, dir };
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

describe("gh PR merger (Phase 3-2)", () => {
  it("merges an open PR via gh pr merge", async () => {
    const { bin, dir } = writeFakeGh("OPEN");
    const merger = createGhPrMerger(bin, 5_000);
    const r = await merger.merge({ repoDir: tmpdir(), prNumber: 42, method: "squash" });
    expect(r).toEqual({ merged: true, alreadyMerged: false });
    const called = readFileSync(join(dir, "merge-called"), "utf8");
    expect(called).toContain("pr merge 42 --squash");
  });

  it("is idempotent: an already-merged PR is a no-op (no second merge)", async () => {
    const { bin, dir } = writeFakeGh("MERGED");
    const merger = createGhPrMerger(bin, 5_000);
    const r = await merger.merge({ repoDir: tmpdir(), prNumber: 7, method: "squash" });
    expect(r).toEqual({ merged: true, alreadyMerged: true });
    expect(existsSync(join(dir, "merge-called"))).toBe(false);
  });

  it("a gh timeout fails loudly", async () => {
    const slowGh = writeSlowGh();
    const merger = createGhPrMerger(slowGh, 300);
    await expect(
      merger.merge({ repoDir: tmpdir(), prNumber: 1, method: "squash" }),
    ).rejects.toThrow(/timed out/);
  });
});
