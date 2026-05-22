import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";
import {
  renderRunShow,
  renderRunTimeline,
  renderRunArtifacts,
  RunViewError,
} from "../../src/core/run-viewer.js";
import { buildRerunChain, formatChain } from "../../src/core/rerun.js";

/**
 * Phase 8-12 — the read-only viewers fall back to the DB when a db-first
 * run has no exported files (file export OFF, or run dir cleaned).
 */

let seq = 0;

interface Fixture {
  runsDir: string;
  dbPath: string;
  runId: string;
}

/** A DB with one db-first run (meta_json + events + a db-stored artifact)
 *  and an EMPTY runs dir — i.e. the DB-only state. */
function dbOnlyRun(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `harness-rvdb-${seq++}-`));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true }); // exists, but no run subdir
  const dbPath = join(root, ".harness", "harness.sqlite");
  const runId = "run-20260523-apps-web-db1";
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    const meta = {
      runId,
      repoId: "demo",
      repoPath: "/repo",
      domain: "apps/web",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: `harness/${runId}`,
      status: "needs_review",
      safetyStatus: "allowed",
      changedFilesCount: 3,
      commandResults: [],
    };
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, updated_at, meta_json)
       VALUES (?, 'demo', 'apps/web', 'domain-coding', 'main',
         'needs_review', 'db-first', '2026-05-23T00:00:00Z', ?)`,
    ).run(runId, JSON.stringify(meta));
    db.prepare(
      `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
       VALUES (?, 1, 'run_started', NULL, ?)`,
    ).run(runId, JSON.stringify({ type: "run_started", stage: "start" }));
    const blob = storeArtifactBlob(db, Buffer.from("codex log body"));
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
         bytes, sha256, storage, blob_sha256, body_status)
       VALUES ('a1', ?, 'codex-log', 'codex.log', 14, ?, 'db', ?,
         'db_available')`,
    ).run(runId, blob.sha256, blob.sha256);
  } finally {
    db.close();
  }
  return { runsDir, dbPath, runId };
}

describe("run viewer — DB fallback (Phase 8-12)", () => {
  it("run show renders a db-first run with no exported files", async () => {
    const { runsDir, dbPath, runId } = dbOnlyRun();
    const out = await renderRunShow(runsDir, runId, undefined, dbPath);
    expect(out).toContain(runId);
    expect(out).toContain("apps/web");
    expect(out).toContain("needs_review");
    expect(out).toContain("codex.log"); // artifact listed from the DB
  });

  it("run timeline renders events from the DB", async () => {
    const { runsDir, dbPath, runId } = dbOnlyRun();
    const out = await renderRunTimeline(runsDir, runId, dbPath);
    expect(out).toContain("run_started");
  });

  it("run artifacts lists the DB artifact manifest", async () => {
    const { runsDir, dbPath, runId } = dbOnlyRun();
    const out = await renderRunArtifacts(runsDir, runId, dbPath);
    expect(out).toContain("codex.log");
  });

  it("without a dbPath a fileless run is reported not found", async () => {
    const { runsDir, runId } = dbOnlyRun();
    await expect(renderRunShow(runsDir, runId)).rejects.toBeInstanceOf(
      RunViewError,
    );
  });

  it("a run absent from both files and DB is not found", async () => {
    const { runsDir, dbPath } = dbOnlyRun();
    await expect(
      renderRunShow(runsDir, "run-20260523-apps-web-zzz", undefined, dbPath),
    ).rejects.toBeInstanceOf(RunViewError);
  });

  it("rerun chain builds from the DB for a fileless run", async () => {
    const { runsDir, dbPath, runId } = dbOnlyRun();
    const root = await buildRerunChain({ runsDir, runId, dbPath });
    expect(root.runId).toBe(runId);
    expect(formatChain(root)).toContain(runId);
  });
});
