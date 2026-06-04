import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { harnessPaths } from "../../src/config/paths.js";
import { runMigrations } from "../../src/db/migrations.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

/** A fake `gh` whose `pr view --json reviews` reports a Copilot review. */
function writeReviewedGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "api" ]; then exit 0; fi',
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  printf '{"reviews":[{"author":{"login":"copilot-pull-request-reviewer"}}]}'`,
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
  writeFileSync(bin, `${script}\n`);
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

/** A fake `gh` whose `pr view --json reviews` reports no reviews (pending). */
function writePendingGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "api" ]; then exit 0; fi',
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  printf '{"reviews":[]}'`,
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
  writeFileSync(bin, `${script}\n`);
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

/** Initialise an empty harness root with a migrated DB. */
function initRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-root-"));
  const paths = harnessPaths(root);
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = new Database(paths.dbPath);
  runMigrations(db);
  db.close();
  return root;
}

function runCli(
  root: string,
  ghBin: string,
  args: string[],
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, HARNESS_ROOT: root, HARNESS_GH_BIN: ghBin },
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

describe("harness pr request-review", () => {
  it("exits 0 and reports reviewed, recording a copilot-review operation", () => {
    const root = initRoot();
    const gh = writeReviewedGh();
    const r = runCli(root, gh, [
      "pr",
      "request-review",
      "55",
      "--repo",
      tmpdir(),
      "--poll-interval",
      "1",
      "--timeout",
      "1",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/copilot-review=reviewed/);
    // an audit row was recorded.
    const db = new Database(harnessPaths(root).dbPath);
    const row = db
      .prepare(
        "SELECT status FROM operations WHERE operation_type = 'copilot-review'",
      )
      .get() as { status: string } | undefined;
    db.close();
    expect(row?.status).toBe("succeeded");
  });

  it("exits 0 and reports skipped (pending review timed out), recording pending", () => {
    const root = initRoot();
    const gh = writePendingGh();
    const r = runCli(root, gh, [
      "pr",
      "request-review",
      "55",
      "--repo",
      tmpdir(),
      "--poll-interval",
      "1",
      "--timeout",
      "0",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/copilot-review=skipped/);
    const db = new Database(harnessPaths(root).dbPath);
    const row = db
      .prepare(
        "SELECT status FROM operations WHERE operation_type = 'copilot-review'",
      )
      .get() as { status: string } | undefined;
    db.close();
    expect(row?.status).toBe("pending");
  });

  it("exits 2 on an invalid --timeout (NaN guard)", () => {
    const root = initRoot();
    const gh = writeReviewedGh();
    const r = runCli(root, gh, [
      "pr",
      "request-review",
      "55",
      "--repo",
      tmpdir(),
      "--timeout",
      "foo",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/invalid.*--timeout|timeout/i);
  });

  it("exits 2 on --poll-interval 0 (must be > 0)", () => {
    const root = initRoot();
    const gh = writeReviewedGh();
    const r = runCli(root, gh, [
      "pr",
      "request-review",
      "55",
      "--repo",
      tmpdir(),
      "--poll-interval",
      "0",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/poll-interval/i);
  });

  it("exits 2 on a non-integer --request-attempts (1.5)", () => {
    const root = initRoot();
    const gh = writeReviewedGh();
    const r = runCli(root, gh, [
      "pr",
      "request-review",
      "55",
      "--repo",
      tmpdir(),
      "--request-attempts",
      "1.5",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/request-attempts/i);
  });

  it("exits non-zero when the request can never be established (failed)", () => {
    const root = initRoot();
    const failDir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
    const failGh = join(failDir, "gh");
    writeFileSync(failGh, "#!/bin/sh\nexit 1\n");
    execFileSync("chmod", ["+x", failGh]);
    const r = runCli(root, failGh, [
      "pr",
      "request-review",
      "55",
      "--repo",
      tmpdir(),
      "--poll-interval",
      "1",
      "--request-attempts",
      "1",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/copilot-review=failed|failed/);
  });
});
