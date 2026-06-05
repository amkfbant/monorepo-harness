import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGhCopilotReviewer } from "../../src/core/copilot-reviewer-gh.js";

/**
 * A fake `gh`. `api ... requested_reviewers` records its argv to
 * `$dir/request-called`. `pr view --json reviews` prints a reviews array whose
 * sole author login is `$reviewerLogin` (empty → no reviews).
 */
function writeFakeGh(reviewerLogin: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  const reviewsJson =
    reviewerLogin === ""
      ? "{\"reviews\":[]}"
      : `{"reviews":[{"author":{"login":"${reviewerLogin}"}}]}`;
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "api" ]; then',
    `  echo "$@" > "${dir}/request-called"`,
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  printf '${reviewsJson}'`,
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
  writeFileSync(bin, `${script}\n`);
  execFileSync("chmod", ["+x", bin]);
  return { bin, dir };
}

function writeSleepingGh(): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  const script = [
    "#!/usr/bin/env node",
    'if (process.argv[2] === "pr" && process.argv[3] === "view") {',
    "  setTimeout(() => {",
    "    process.stdout.write('{\"reviews\":[]}');",
    "    process.exit(0);",
    "  }, 5000);",
    "} else {",
    "  process.exit(1);",
    "}",
  ].join("\n");
  writeFileSync(bin, `${script}\n`);
  execFileSync("chmod", ["+x", bin]);
  return { bin, dir };
}

describe("createGhCopilotReviewer", () => {
  it("request invokes `gh api ... requested_reviewers` with Copilot", async () => {
    const { bin, dir } = writeFakeGh("");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    await reviewer.request(42);
    const called = readFileSync(join(dir, "request-called"), "utf8");
    expect(called).toContain("requested_reviewers");
    expect(called).toContain("reviewers[]=Copilot");
  });

  it("poll returns reviewed when Copilot's bot author is present", async () => {
    const { bin } = writeFakeGh("copilot-pull-request-reviewer");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    expect(await reviewer.poll(42)).toBe("reviewed");
  });

  it("poll returns pending when no Copilot review is present", async () => {
    const { bin } = writeFakeGh("");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    expect(await reviewer.poll(42)).toBe("pending");
  });

  it("poll detects reviewed with no timeoutMs (adapter falls back to its default timeout)", async () => {
    // When runCopilotReview passes undefined (remaining <= 0 on the mandatory
    // first poll), the adapter must use its own default timeout — not 1ms —
    // so a real gh has time to run and `reviewed` is not lost.
    const { bin } = writeFakeGh("copilot-pull-request-reviewer");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    // explicit no-arg call (timeoutMs undefined).
    expect(await reviewer.poll(42)).toBe("reviewed");
  });

  it("poll returns pending for a non-Copilot reviewer (a human review)", async () => {
    const { bin } = writeFakeGh("some-human");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    expect(await reviewer.poll(42)).toBe("pending");
  });

  it("poll abort signal aborts the in-flight gh child", async () => {
    const { bin } = writeSleepingGh();
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    timer.unref?.();
    try {
      await expect(reviewer.poll(42, 5_000, controller.signal)).rejects.toThrow(
        /aborted/,
      );
    } finally {
      clearTimeout(timer);
    }
  });

  it("request throws on a gh non-zero exit (so the orchestration can retry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
    const bin = join(dir, "gh");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n");
    execFileSync("chmod", ["+x", bin]);
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    await expect(reviewer.request(42)).rejects.toThrow();
    expect(existsSync(join(dir, "request-called"))).toBe(false);
  });
});
