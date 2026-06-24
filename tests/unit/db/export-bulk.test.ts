import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { exportFiles } from "../../../src/db/export-bulk.js";
import { checkConsistency } from "../../../src/db/consistency.js";
import { ingestRunArtifacts } from "../../../src/db/run-artifacts.js";

/**
 * Phase 7-11 — `db export-files` bulk re-export and the export-tracking
 * consistency checks.
 */

function setup(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "harness-exp-bulk-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { root, db };
}

function seedRun(db: Database.Database, runId: string): void {
  const meta = { runId, repoId: "r", domain: "apps/x", status: "needs_review" };
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch, status,
       updated_at, source_mode, db_revision, export_status, meta_json)
     VALUES (?, 'r', 'apps/x', 'domain-coding', 'main', 'needs_review',
       '2026-05-22T00:00:00Z', 'db-first', 1, 'dirty', ?)`,
  ).run(runId, JSON.stringify(meta, null, 2));
}

function seedBacklog(db: Database.Database, itemId: string): void {
  db.prepare(
    `INSERT INTO backlog_items (item_id, domain, title, goal, status, priority,
       tags_json, created_at, source_mode, db_revision, export_status)
     VALUES (?, 'd', 't', 'g', 'open', 'medium', '[]',
       '2026-05-22T00:00:00Z', 'db-first', 1, 'dirty')`,
  ).run(itemId);
}

describe("db export-files (bulk)", () => {
  it("re-exports every db-first row and marks it synced", () => {
    const { root, db } = setup();
    seedRun(db, "run-x-001");
    seedBacklog(db, "item-20260522-001");

    const results = exportFiles(db, { harnessRoot: root });
    const run = results.find((r) => r.scope === "run");
    const backlog = results.find((r) => r.scope === "backlog");
    expect(run?.synced).toBe(1);
    expect(backlog?.synced).toBe(1);
    expect(
      existsSync(join(root, "runs", "run-x-001", "meta.json")),
    ).toBe(true);
    expect(
      existsSync(join(root, "backlog", "open", "item-20260522-001.yaml")),
    ).toBe(true);

    const status = db
      .prepare("SELECT export_status FROM runs WHERE run_id = ?")
      .get("run-x-001") as { export_status: string };
    expect(status.export_status).toBe("synced");
    db.close();
  });

  it("--scope restricts the export to one scope", () => {
    const { root, db } = setup();
    seedRun(db, "run-x-001");
    seedBacklog(db, "item-20260522-001");
    const results = exportFiles(db, { harnessRoot: root, scope: "backlog" });
    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBe("backlog");
    // the run was not exported
    expect(existsSync(join(root, "runs", "run-x-001", "meta.json"))).toBe(
      false,
    );
    db.close();
  });

  it("--id restricts the export to one row", () => {
    const { root, db } = setup();
    seedBacklog(db, "item-20260522-001");
    seedBacklog(db, "item-20260522-002");
    const results = exportFiles(db, {
      harnessRoot: root,
      scope: "backlog",
      id: "item-20260522-001",
    });
    expect(results[0]?.total).toBe(1);
    expect(
      existsSync(join(root, "backlog", "open", "item-20260522-002.yaml")),
    ).toBe(false);
    db.close();
  });

  it("re-projects knowledge decision sidecars and recovers a failed export", () => {
    const { root, db } = setup();
    mkdirSync(join(root, "runs", "run-knw-1"), { recursive: true });
    // a db-first rejected candidate whose sidecar export previously failed
    db.prepare(
      `INSERT INTO knowledge_candidates (candidate_id, run_id, domain, kind,
         title, body, status, created_at, decided_at, reviewer, reason,
         source_mode, db_revision, export_status)
       VALUES ('run-knw-1:0', 'run-knw-1', 'apps/x', 'policy_improvement',
         't', 'c', 'rejected', '2026-05-22T00:00:00Z', '2026-05-22T01:00:00Z',
         'kn', 'too specific', 'db-first', 1, 'failed')`,
    ).run();

    const results = exportFiles(db, { harnessRoot: root, scope: "knowledge" });
    expect(results[0]?.synced).toBe(1);
    expect(
      existsSync(join(root, "runs", "run-knw-1", "knowledge-decisions.yaml")),
    ).toBe(true);
    // the candidate's failed export is recovered to synced
    const status = db
      .prepare(
        "SELECT export_status FROM knowledge_candidates WHERE candidate_id = ?",
      )
      .get("run-knw-1:0") as { export_status: string };
    expect(status.export_status).toBe("synced");
    db.close();
  });

  it("does not export a knowledge decision sidecar for db-first runs without rejections", () => {
    const { root, db } = setup();
    mkdirSync(join(root, "runs", "run-knw-promoted"), { recursive: true });
    db.prepare(
      `INSERT INTO knowledge_candidates (candidate_id, run_id, domain, kind,
         title, body, status, created_at, decided_at, reviewer, reason,
         source_mode, db_revision, export_status)
       VALUES ('run-knw-promoted:0', 'run-knw-promoted', 'apps/x',
         'policy_improvement', 't', 'c', 'promoted',
         '2026-05-22T00:00:00Z', '2026-05-22T01:00:00Z',
         'kn', NULL, 'db-first', 1, 'synced')`,
    ).run();
    writeFileSync(
      join(root, "runs", "run-knw-promoted", "knowledge-decisions.yaml"),
      "decisions:\n\n",
    );
    db.prepare(
      `INSERT INTO exported_files (scope_type, scope_id, relative_path,
         sha256, bytes, db_revision, exported_at)
       VALUES ('knowledge_decisions', 'run-knw-promoted',
         'knowledge-decisions.yaml', 'stale-empty', 12, 1,
         '2026-05-22T02:00:00Z')`,
    ).run();

    const results = exportFiles(db, { harnessRoot: root, scope: "knowledge" });
    expect(results[0]).toMatchObject({ total: 0, synced: 0, failed: 0 });
    expect(
      existsSync(
        join(root, "runs", "run-knw-promoted", "knowledge-decisions.yaml"),
      ),
    ).toBe(false);
    const tracked = db
      .prepare(
        `SELECT count(*) AS n FROM exported_files
         WHERE scope_type = 'knowledge_decisions'
           AND scope_id = 'run-knw-promoted'`,
      )
      .get() as { n: number };
    expect(tracked.n).toBe(0);
    db.close();
  });

  it("clears stale empty knowledge decision tracking for db-first runs with no candidates", () => {
    const { root, db } = setup();
    seedRun(db, "run-knw-empty");
    mkdirSync(join(root, "runs", "run-knw-empty"), { recursive: true });
    writeFileSync(
      join(root, "runs", "run-knw-empty", "knowledge-decisions.yaml"),
      "decisions:\n\n",
    );
    db.prepare(
      `INSERT INTO exported_files (scope_type, scope_id, relative_path,
         sha256, bytes, db_revision, exported_at)
       VALUES ('knowledge_decisions', 'run-knw-empty',
         'knowledge-decisions.yaml', 'stale-empty', 12, 1,
         '2026-05-22T02:00:00Z')`,
    ).run();

    const results = exportFiles(db, { harnessRoot: root, scope: "knowledge" });

    expect(results[0]).toMatchObject({ total: 0, synced: 0, failed: 0 });
    expect(
      existsSync(join(root, "runs", "run-knw-empty", "knowledge-decisions.yaml")),
    ).toBe(false);
    const tracked = db
      .prepare(
        `SELECT count(*) AS n FROM exported_files
         WHERE scope_type = 'knowledge_decisions'
           AND scope_id = 'run-knw-empty'`,
      )
      .get() as { n: number };
    expect(tracked.n).toBe(0);
    db.close();
  });

  it("does not resurrect a run dir removed by cleanup --scope run (P1-4)", () => {
    const { root, db } = setup();
    seedRun(db, "run-cleaned");
    // cleanup --scope run removed the dir and recorded the action
    db.prepare(
      `INSERT INTO cleanup_actions (run_id, action_type, target, status,
         executed_at, error_message)
       VALUES ('run-cleaned', 'run_dir_remove', NULL, 'done',
         '2026-05-22T00:00:00Z', NULL)`,
    ).run();
    const results = exportFiles(db, { harnessRoot: root, scope: "run" });
    // the cleaned run is excluded — db export-files must not recreate its dir
    expect(results[0]?.total).toBe(0);
    expect(existsSync(join(root, "runs", "run-cleaned", "meta.json"))).toBe(
      false,
    );
    db.close();
  });

  it("flags a hand-edited knowledge-decisions.yaml as drift (P1-6)", () => {
    const { root, db } = setup();
    mkdirSync(join(root, "runs", "run-knw-2"), { recursive: true });
    db.prepare(
      `INSERT INTO knowledge_candidates (candidate_id, run_id, domain, kind,
         title, body, status, created_at, decided_at, reviewer, reason,
         source_mode, db_revision, export_status)
       VALUES ('run-knw-2:0', 'run-knw-2', 'apps/x', 'policy_improvement',
         't', 'c', 'rejected', '2026-05-22T00:00:00Z', '2026-05-22T01:00:00Z',
         'kn', 'x', 'db-first', 1, 'dirty')`,
    ).run();
    exportFiles(db, { harnessRoot: root, scope: "knowledge" });
    // hand-edit the exported sidecar so its sha256 no longer matches
    writeFileSync(
      join(root, "runs", "run-knw-2", "knowledge-decisions.yaml"),
      "decisions: []\n",
    );
    db.close();
    const ro = openDb(join(root, ".harness", "harness.sqlite"));
    const report = checkConsistency({ db: ro, harnessRoot: root });
    ro.close();
    expect(
      report.items.some(
        (i) => i.kind === "export:knowledge_decisions" && i.status === "drift",
      ),
    ).toBe(true);
  });

  it("detects a hand-edited db-stored artifact body as drift (8-4 / P2-2)", () => {
    const { root, db } = setup();
    seedRun(db, "run-art-d");
    const runDir = join(root, "runs", "run-art-d");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "codex-output.log"), "codex ran\n");
    ingestRunArtifacts(db, runDir, "run-art-d"); // body → artifact_blobs
    exportFiles(db, { harnessRoot: root, scope: "run" }); // → exported_files
    // the artifact body file is recorded in exported_files
    const tracked = (
      db
        .prepare(
          `SELECT count(*) AS n FROM exported_files
           WHERE scope_id = 'run-art-d' AND relative_path = 'codex-output.log'`,
        )
        .get() as { n: number }
    ).n;
    expect(tracked).toBe(1);
    // hand-edit the exported artifact body → check-consistency sees drift
    writeFileSync(join(runDir, "codex-output.log"), "tampered\n");
    db.close();
    const ro = openDb(join(root, ".harness", "harness.sqlite"));
    const report = checkConsistency({ db: ro, harnessRoot: root });
    ro.close();
    expect(
      report.items.some(
        (i) => i.kind.startsWith("export") && i.status === "drift",
      ),
    ).toBe(true);
  });

  it("does not export legacy-file rows", () => {
    const { root, db } = setup();
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, updated_at, source_mode, db_revision)
       VALUES ('run-legacy', 'r', 'd', 'domain-coding', 'main', 'needs_review',
         '2026-05-22T00:00:00Z', 'legacy-file', 0)`,
    ).run();
    const results = exportFiles(db, { harnessRoot: root, scope: "run" });
    expect(results[0]?.total).toBe(0);
    db.close();
  });
});

describe("check-consistency — export tracking", () => {
  it("flags a row with a dirty export_status", () => {
    const { root, db } = setup();
    seedRun(db, "run-x-001"); // export_status = 'dirty'
    db.close();
    const ro = openDb(join(root, ".harness", "harness.sqlite"));
    const report = checkConsistency({ db: ro, harnessRoot: root });
    ro.close();
    expect(
      report.items.some(
        (i) => i.kind === "export:run" && i.status === "drift",
      ),
    ).toBe(true);
  });

  it("does not flag a synced db-first run as drift", () => {
    const { root, db } = setup();
    seedRun(db, "run-x-001");
    // export it — export_status flips to synced, exported_files recorded
    exportFiles(db, { harnessRoot: root, scope: "run" });
    db.close();
    const ro = openDb(join(root, ".harness", "harness.sqlite"));
    const report = checkConsistency({ db: ro, harnessRoot: root });
    ro.close();
    // a db-first run uses export tracking, not the file-fingerprint check
    expect(
      report.items.some((i) => i.id === "run-x-001" && i.status !== "ok"),
    ).toBe(false);
  });

  it("flags an exported file whose content drifted", () => {
    const { root, db } = setup();
    seedBacklog(db, "item-20260522-001");
    exportFiles(db, { harnessRoot: root, scope: "backlog" });
    // hand-edit the exported file so its sha256 no longer matches
    writeFileSync(
      join(root, "backlog", "open", "item-20260522-001.yaml"),
      "tampered\n",
    );
    db.close();
    const ro = openDb(join(root, ".harness", "harness.sqlite"));
    const report = checkConsistency({ db: ro, harnessRoot: root });
    ro.close();
    expect(
      report.items.some(
        (i) => i.kind === "export:backlog_item" && i.status === "drift",
      ),
    ).toBe(true);
  });
});
