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
    `  printf '{"state":"${state}","mergedAt":${state === "MERGED" ? '"2026-06-05T00:00:00Z"' : "null"},"headRefOid":"abc123sha"}'`,
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
  it("merges an open PR, pinned to the expected reviewed commit", async () => {
    const { bin, dir } = writeFakeGh("OPEN");
    const merger = createGhPrMerger(bin, 5_000);
    const r = await merger.merge({
      repoDir: tmpdir(),
      prNumber: 42,
      method: "squash",
      expectedHeadSha: "reviewedsha",
    });
    expect(r).toEqual({ merged: true, alreadyMerged: false });
    const called = readFileSync(join(dir, "merge-called"), "utf8");
    // the merge is pinned to the caller-supplied reviewed commit.
    expect(called).toContain("pr merge 42 --match-head-commit reviewedsha --squash");
  });

  it("fail-closed: refuses to merge an open PR without an expectedHeadSha", async () => {
    const { bin, dir } = writeFakeGh("OPEN");
    const merger = createGhPrMerger(bin, 5_000);
    await expect(
      merger.merge({ repoDir: tmpdir(), prNumber: 9, method: "squash" }),
    ).rejects.toThrow(/without an expectedHeadSha/);
    expect(existsSync(join(dir, "merge-called"))).toBe(false);
  });

  it("is idempotent: an already-merged PR (matching expected head) is a no-op", async () => {
    const { bin, dir } = writeFakeGh("MERGED");
    const merger = createGhPrMerger(bin, 5_000);
    const r = await merger.merge({
      repoDir: tmpdir(),
      prNumber: 7,
      method: "squash",
      expectedHeadSha: "abc123sha",
    });
    expect(r).toEqual({ merged: true, alreadyMerged: true });
    expect(existsSync(join(dir, "merge-called"))).toBe(false);
  });

  it("fail-closed: an already-merged PR at a DIFFERENT commit is rejected", async () => {
    const { bin, dir } = writeFakeGh("MERGED"); // head = abc123sha
    const merger = createGhPrMerger(bin, 5_000);
    await expect(
      merger.merge({
        repoDir: tmpdir(),
        prNumber: 7,
        method: "squash",
        expectedHeadSha: "different-sha",
      }),
    ).rejects.toThrow(/already merged at a different commit/);
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
