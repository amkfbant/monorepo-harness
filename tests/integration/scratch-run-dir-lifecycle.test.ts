import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDomainCoding } from "../../src/core/workflow-runner.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";
import { openDb } from "../../src/db/connection.js";
import { _resetExportModeWarningForTest } from "../../src/config/export-mode.js";

/**
 * Phase 9 post-close P2 #4 fix — end-to-end coverage for the
 * `HARNESS_EXPORT_FILES=0` scratch-run-dir lifecycle.
 *
 * Phase 9-7 implements: with file export OFF, the `runs/<runId>` dir is
 * scratch — deleted on a successful run once the artifacts are
 * DB-canonical, preserved (with a stderr warning) when ingest fails.
 * The Phase 9 fixture matrix only checks the env-default-OFF accessor;
 * this file covers the actual scratch removal at workflow-runner level.
 */

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-target-scratch-"));
  const g = (a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(
    join(repo, "apps/user/src/profile.ts"),
    "export const x = 0;\n",
  );
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return repo;
}

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-scratch-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  writeFileSync(
    join(root, "policies/global.yaml"),
    "always_deny_write:\n  - .git/**\n",
  );
  writeFileSync(
    join(root, "policies/repos/t.yaml"),
    [
      "repo_id: t",
      "read: []",
      "domains:",
      "  apps/user:",
      "    read: [apps/user/**]",
      "    write: [apps/user/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );
  return root;
}

describe("scratch runDir lifecycle — HARNESS_EXPORT_FILES=0 (Phase 9 post-close P2 #4)", () => {
  let repoPath: string;
  let harness: string;
  const PRIOR_EXPORT = process.env.HARNESS_EXPORT_FILES;

  beforeEach(() => {
    repoPath = setupRepo();
    harness = setupHarness();
    // override the tests/setup-export-mode.ts global pin so this file
    // exercises the Phase 9 default-OFF path.
    process.env.HARNESS_EXPORT_FILES = "0";
    process.env.HARNESS_SUPPRESS_EXPORT_MODE_WARNING = "1";
    _resetExportModeWarningForTest();
  });

  afterEach(() => {
    if (PRIOR_EXPORT === undefined) delete process.env.HARNESS_EXPORT_FILES;
    else process.env.HARNESS_EXPORT_FILES = PRIOR_EXPORT;
    _resetExportModeWarningForTest();
  });

  it("removes the runs/<id> dir after a successful ingest", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-23T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");

    // runs/<id> must be gone — DB has the artifacts
    const runDir = join(harness, "runs", r.runId);
    expect(existsSync(runDir)).toBe(false);

    // and the DB still records the artifacts
    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?")
        .get(r.runId) as { n: number };
      expect(count.n).toBeGreaterThan(0);
      const meta = db
        .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
        .get(r.runId) as { meta_json: string };
      expect(JSON.parse(meta.meta_json).status).toBe("needs_review");
    } finally {
      db.close();
    }
  });

  it("preserves the runs/<id> dir when scratch removal is bypassed (export ON re-check)", async () => {
    // sanity guard against a regression that would delete the runDir
    // even with export ON — this scenario is the inverse of the fix.
    process.env.HARNESS_EXPORT_FILES = "1";
    _resetExportModeWarningForTest();
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-23T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    expect(existsSync(join(harness, "runs", r.runId, "meta.json"))).toBe(true);
  });
});
