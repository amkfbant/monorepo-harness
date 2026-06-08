import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openDbReadonly } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";
import { runReviewerAgent } from "../../src/core/reviewer-agent.js";
import { syncRunArtifactsToDb } from "../../src/core/run-materialize.js";
import { recordOperationalKnowledge } from "../../src/core/operational-knowledge.js";
import type { CodexExecRunner } from "../../src/codex/codex-exec-runner.js";

/**
 * Phase 8-13 — `review auto` in DB-only mode.
 *
 * A db-first run written with file export OFF has no run dir. The
 * reviewer agent materializes it from the DB before running, so review
 * works without the operator first re-exporting files.
 */

const APPROVED_OUTPUT = [
  "```yaml",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "```",
].join("\n");

function fakeRunner(output: string): CodexExecRunner {
  return {
    async run(input) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      return { exitCode: 0, timedOut: false };
    },
  };
}

/** A fake runner that also records every prompt it is given. */
function capturingRunner(output: string): {
  runner: CodexExecRunner;
  prompts: string[];
} {
  const prompts: string[] = [];
  const runner: CodexExecRunner = {
    async run(input) {
      prompts.push(input.prompt);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      return { exitCode: 0, timedOut: false };
    },
  };
  return { runner, prompts };
}

interface Fixture {
  runsDir: string;
  dbPath: string;
  runId: string;
}

/** A db-first needs_review run that exists ONLY in the DB (no run dir). */
function dbOnlyNeedsReview(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-radb-"));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const runId = "run-20260523-apps-user-radb1";
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    const meta = {
      runId,
      repoId: "t",
      repoPath: "/tmp/t",
      domain: "apps/user",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: "harness/x",
      status: "needs_review",
      safetyStatus: "allowed",
      startedAt: "2026-05-23T00:00:00Z",
    };
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at,
         meta_json)
       VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
         'db-first', 2, 'disabled', '2026-05-23T00:00:00Z', ?)`,
    ).run(runId, JSON.stringify(meta));
    // a db-stored artifact body so the materialized run dir has content
    const blob = storeArtifactBlob(db, Buffer.from("# summary\nlooks ok\n"));
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
         content_type, bytes, sha256, storage, blob_sha256, body_status)
       VALUES (?, ?, 'summary', 'summary.md', 'text/markdown', ?, ?, 'db',
         ?, 'db_available')`,
    ).run(`${runId}:summary.md`, runId, blob.bytes, blob.sha256, blob.sha256);
  } finally {
    db.close();
  }
  return { runsDir, dbPath, runId };
}

describe("review auto — DB-only mode (Phase 8-13)", () => {
  it("materializes a fileless db-first run, then reviews it", async () => {
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    // precondition: no run dir exists
    expect(existsSync(join(runsDir, runId, "meta.json"))).toBe(false);

    const r = await runReviewerAgent({
      runsDir,
      runId,
      dbPath,
      codexRunner: fakeRunner(APPROVED_OUTPUT),
      now: new Date("2026-05-23T01:00:00Z"),
    });

    expect(r.decision).toBe("approved");
    // the run was materialized from the DB so the reviewer could read it
    expect(existsSync(join(runsDir, runId, "meta.json"))).toBe(true);
    expect(existsSync(join(runsDir, runId, "summary.md"))).toBe(true);
    expect(existsSync(join(runsDir, runId, "review-decision.yaml"))).toBe(
      true,
    );
  });

  it("injects scoped operational knowledge into the reviewer prompt (issue #57)", async () => {
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    const db = openDb(dbPath);
    try {
      recordOperationalKnowledge(db, { key: "repo-note", title: "Repo CI quirk", body: "spending limit fails fast", repoId: "t", actor: "op" });
      recordOperationalKnowledge(db, { key: "portable-note", title: "Portable env note", body: "ext4 only", actor: "op" });
      recordOperationalKnowledge(db, { key: "other-repo", title: "Other repo note", body: "irrelevant", repoId: "z", actor: "op" });
    } finally {
      db.close();
    }
    const { runner, prompts } = capturingRunner(APPROVED_OUTPUT);
    const r = await runReviewerAgent({ runsDir, runId, dbPath, codexRunner: runner });
    expect(r.decision).toBe("approved");
    expect(prompts).toHaveLength(1);
    const p = prompts[0] as string;
    expect(p).toContain("<operational-knowledge>");
    expect(p).toContain("Repo CI quirk"); // repo t — in scope
    expect(p).toContain("Portable env note"); // portable — in scope
    expect(p).not.toContain("Other repo note"); // repo z — out of scope
  });

  it("omits the operational-knowledge section when there is none in scope", async () => {
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    const { runner, prompts } = capturingRunner(APPROVED_OUTPUT);
    await runReviewerAgent({ runsDir, runId, dbPath, codexRunner: runner });
    expect(prompts[0]).not.toContain("<operational-knowledge>");
  });

  it("without a dbPath a fileless run still fails (no silent fallback)", async () => {
    const { runsDir, runId } = dbOnlyNeedsReview();
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        codexRunner: fakeRunner(APPROVED_OUTPUT),
      }),
    ).rejects.toThrow();
  });

  it("syncRunArtifactsToDb captures the reviewer-agent logs into the DB", async () => {
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    await runReviewerAgent({
      runsDir,
      runId,
      dbPath,
      codexRunner: fakeRunner(APPROVED_OUTPUT),
      now: new Date("2026-05-23T01:00:00Z"),
    });
    syncRunArtifactsToDb({ dbPath, runsDir, runId });

    const db = openDbReadonly(dbPath);
    try {
      const rows = db
        .prepare(
          "SELECT relative_path FROM artifacts WHERE run_id = ? AND storage = 'db'",
        )
        .all(runId) as { relative_path: string }[];
      const paths = rows.map((r) => r.relative_path);
      // the reviewer's own log is now a DB-canonical artifact
      expect(paths).toContain("reviewer-agent.out.log");
    } finally {
      db.close();
    }
  });
});
