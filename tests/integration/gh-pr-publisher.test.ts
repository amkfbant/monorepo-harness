import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGhPrPublisher,
  createGhPrMerger,
  createGhCiStatus,
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
      merger.merge({ repoDir: tmpdir(), prNumber: 1, method: "squash", expectedHeadSha: "x" }),
    ).rejects.toThrow(/timed out/);
  });

  it("fail-closed: a malformed `gh pr view` payload aborts the merge (does not proceed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
    const bin = join(dir, "gh");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
        // warnings mixed into stdout → unparseable as JSON.
        '  printf \'warning: something\\n{not json\'',
        "  exit 0",
        "fi",
        'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then',
        `  echo "$@" > "${dir}/merge-called"`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    execFileSync("chmod", ["+x", bin]);
    const merger = createGhPrMerger(bin, 5_000);
    await expect(
      merger.merge({ repoDir: tmpdir(), prNumber: 5, method: "squash", expectedHeadSha: "sha" }),
    ).rejects.toThrow(/unknown PR state/);
    expect(existsSync(join(dir, "merge-called"))).toBe(false);
  });
});

/** A fake `gh` whose `pr view --json headRefOid,statusCheckRollup` returns the
 *  given head OID + rollup as a single atomic JSON snapshot. */
function writeFakeGhCi(headOid: string, rollupJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      `  printf '{"headRefOid":"${headOid}","statusCheckRollup":${rollupJson}}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

describe("gh CI status probe (Phase 3)", () => {
  const GREEN = '[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]';

  it("green when head matches and all checks succeed", async () => {
    const ci = createGhCiStatus(tmpdir(), writeFakeGhCi("reviewedsha", GREEN), 5_000);
    expect(await ci(5, "reviewedsha")).toBe(true);
  });

  it("fail-closed: head mismatch (the rollup is for a different commit) → false", async () => {
    // even though the checks are green, the snapshot's head is not the
    // reviewed commit, so the green result is not trusted (A→B→A safety).
    const ci = createGhCiStatus(tmpdir(), writeFakeGhCi("othersha", GREEN), 5_000);
    expect(await ci(5, "reviewedsha")).toBe(false);
  });

  it("fail-closed: a pending check → false", async () => {
    const pending = '[{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":null}]';
    const ci = createGhCiStatus(tmpdir(), writeFakeGhCi("reviewedsha", pending), 5_000);
    expect(await ci(5, "reviewedsha")).toBe(false);
  });

  it("fail-closed: a failing check → false", async () => {
    const failing = '[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]';
    const ci = createGhCiStatus(tmpdir(), writeFakeGhCi("reviewedsha", failing), 5_000);
    expect(await ci(5, "reviewedsha")).toBe(false);
  });

  it("fail-closed: an empty rollup (no CI evidence) → false", async () => {
    const ci = createGhCiStatus(tmpdir(), writeFakeGhCi("reviewedsha", "[]"), 5_000);
    expect(await ci(5, "reviewedsha")).toBe(false);
  });
});
