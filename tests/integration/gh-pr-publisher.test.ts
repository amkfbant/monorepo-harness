import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createGhPrPublisher,
  createGhPrMerger,
  createGhCiStatus,
  createGhReviewVerdicts,
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

  it("writes the PR body inside a private mkdtemp directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
    const bin = join(dir, "gh");
    const metaPath = join(dir, "body-meta.json");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'pr' && args[1] === 'list') {",
        "  process.stdout.write('[]');",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'pr' && args[1] === 'create') {",
        "  const bodyFile = args[args.indexOf('--body-file') + 1];",
        "  const bodyDir = path.dirname(bodyFile);",
        `  fs.writeFileSync(${JSON.stringify(metaPath)}, JSON.stringify({`,
        "    bodyFile,",
        "    bodyDir,",
        "    bodyDirMode: fs.statSync(bodyDir).mode & 0o777,",
        "    body: fs.readFileSync(bodyFile, 'utf8'),",
        "  }));",
        "  process.stdout.write('https://github.com/example/repo/pull/123\\n');",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    execFileSync("chmod", ["+x", bin]);

    const publisher = createGhPrPublisher(bin, 5_000);
    const result = await publisher.publish({
      repoDir: tmpdir(),
      base: "main",
      head: "harness/private-body",
      title: "Private body",
      body: "secret body",
      draft: true,
    });

    expect(result).toEqual({
      url: "https://github.com/example/repo/pull/123",
      number: 123,
    });
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      bodyFile: string;
      bodyDir: string;
      bodyDirMode: number;
      body: string;
    };
    expect(meta.body).toBe("secret body");
    expect(basename(meta.bodyDir)).toMatch(/^harness-pr-body-/);
    expect(meta.bodyDirMode & 0o077).toBe(0);
    expect(existsSync(meta.bodyFile)).toBe(false);
    expect(existsSync(meta.bodyDir)).toBe(false);
  });

  it("removes the private body directory when writing the body fails", async () => {
    vi.resetModules();
    let bodyDir: string | null = null;
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
          bodyDir = await actual.mkdtemp(...args);
          return bodyDir;
        },
        writeFile: async () => {
          throw new Error("forced body write failure");
        },
      };
    });
    try {
      const { createGhPrPublisher: createPublisherWithFailingWrite } =
        await import("../../src/core/gh-pr-publisher.js");
      const publisher = createPublisherWithFailingWrite("gh", 5_000);

      await expect(
        publisher.publish({
          repoDir: tmpdir(),
          base: "main",
          head: "harness/private-body",
          title: "Private body",
          body: "secret body",
          draft: true,
        }),
      ).rejects.toThrow(/forced body write failure/);

      expect(bodyDir).toEqual(expect.any(String));
      expect(existsSync(bodyDir as string)).toBe(false);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
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
  const greenRollup = [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
  ];
  const pendingRollup = [
    { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
  ];
  const failingRollup = [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
  ];

  function createFakeCiProbe(
    snapshots: Array<{ headRefOid: string; statusCheckRollup: unknown[] }>,
    opts: { awaitTimeoutMs?: number; pollIntervalMs?: number } = {},
  ): {
    ci: ReturnType<typeof createGhCiStatus>;
    calls: string[][];
    timeouts: number[];
    sleeps: number[];
  } {
    let nowMs = 0;
    let snapshotIndex = 0;
    const calls: string[][] = [];
    const timeouts: number[] = [];
    const sleeps: number[] = [];
    const ci = createGhCiStatus(tmpdir(), "fake-gh", 5_000, {
      awaitTimeoutMs: opts.awaitTimeoutMs ?? 10_000,
      pollIntervalMs: opts.pollIntervalMs ?? 1_000,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      runGh: async (_ghBin, args, _cwd, timeoutMs) => {
        calls.push([...args]);
        timeouts.push(timeoutMs);
        const snapshot =
          snapshots[Math.min(snapshotIndex, snapshots.length - 1)] ??
          snapshots[snapshots.length - 1];
        snapshotIndex += 1;
        return JSON.stringify(snapshot);
      },
    });
    return { ci, calls, timeouts, sleeps };
  }

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

  it("pending checks are polled until all checks are terminal green → true", async () => {
    const { ci, calls, sleeps } = createFakeCiProbe([
      { headRefOid: "reviewedsha", statusCheckRollup: pendingRollup },
      { headRefOid: "reviewedsha", statusCheckRollup: greenRollup },
    ]);
    expect(await ci(5, "reviewedsha")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("fail-closed: terminal failure → false without waiting for timeout", async () => {
    const { ci, calls, sleeps } = createFakeCiProbe([
      { headRefOid: "reviewedsha", statusCheckRollup: failingRollup },
    ]);
    expect(await ci(5, "reviewedsha")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("fail-closed: head moved while polling → false", async () => {
    const { ci, calls, sleeps } = createFakeCiProbe([
      { headRefOid: "reviewedsha", statusCheckRollup: pendingRollup },
      { headRefOid: "othersha", statusCheckRollup: greenRollup },
    ]);
    expect(await ci(5, "reviewedsha")).toBe(false);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("fail-closed: timeout while checks are pending → false", async () => {
    const { ci, calls, timeouts, sleeps } = createFakeCiProbe(
      [{ headRefOid: "reviewedsha", statusCheckRollup: pendingRollup }],
      { awaitTimeoutMs: 2_500, pollIntervalMs: 1_000 },
    );
    expect(await ci(5, "reviewedsha")).toBe(false);
    expect(calls).toHaveLength(3);
    expect(timeouts).toEqual([2_500, 1_500, 500]);
    expect(sleeps).toEqual([1_000, 1_000, 500]);
  });

  it("fail-closed: an empty rollup (no CI evidence) times out → false", async () => {
    const { ci, calls, sleeps } = createFakeCiProbe(
      [{ headRefOid: "reviewedsha", statusCheckRollup: [] }],
      { awaitTimeoutMs: 2_000, pollIntervalMs: 1_000 },
    );
    expect(await ci(5, "reviewedsha")).toBe(false);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000, 1_000]);
  });
});

describe("external probe failure observability", () => {
  it("review verdicts probe preserves GitHub review ids and submitted timestamps", async () => {
    const verdicts = createGhReviewVerdicts(tmpdir(), "fake-gh", 5_000, async () =>
      JSON.stringify({
        reviews: [
          {
            id: "PRR_kwDO",
            databaseId: 123,
            author: { login: "codex[bot]" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-06-25T00:00:00Z",
          },
          {
            databaseId: 456,
            author: { login: "alice" },
            state: "APPROVED",
          },
        ],
      }),
    );

    expect(await verdicts(9)).toEqual([
      {
        author: "codex[bot]",
        state: "CHANGES_REQUESTED",
        githubReviewId: "PRR_kwDO",
        submittedAt: "2026-06-25T00:00:00Z",
      },
      {
        author: "alice",
        state: "APPROVED",
        githubReviewId: 456,
        submittedAt: null,
      },
    ]);
  });

  it("CI status probe surfaces an unexpected gh failure on stderr (still fail-safe false)", async () => {
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        warnings.push(String(chunk));
        return true;
      });
    try {
      const ci = createGhCiStatus(tmpdir(), "fake-gh", 5_000, {
        awaitTimeoutMs: 10_000,
        now: () => 0,
        runGh: async () => {
          throw new Error("gh blew up");
        },
      });
      // fail-safe: an unexpected failure is still treated as not-green.
      expect(await ci(7, "reviewedsha")).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("")).toMatch(
      /CI status check for PR #7 failed.*gh blew up/,
    );
  });

  it("review verdicts probe surfaces an unexpected gh failure on stderr (still fail-safe empty)", async () => {
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        warnings.push(String(chunk));
        return true;
      });
    try {
      const verdicts = createGhReviewVerdicts(tmpdir(), "fake-gh", 5_000, async () => {
        throw new Error("network down");
      });
      // fail-safe: a failure yields no verdicts (never an approval).
      expect(await verdicts(9)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("")).toMatch(
      /fetching external review verdicts for PR #9 failed.*network down/,
    );
  });
});
