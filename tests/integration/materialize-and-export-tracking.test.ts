import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { ReviewProposalRepository } from "../../src/db/repositories/review-proposals.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";
import { exportRun } from "../../src/db/export-files.js";
import {
  ensureRunMaterialized,
} from "../../src/core/run-materialize.js";
import { _resetExportModeWarningForTest } from "../../src/config/export-mode.js";

/**
 * Phase 9 post-close (second review) — added test coverage for the
 * materialize / export-tracking boundary.
 *
 * (2) review auto-style proposal + `db export-files` (i.e. forced
 *     `exportRun`) emits the active proposal as the sidecar, not the
 *     pending template (P1-2).
 * (6) `ensureRunMaterialized` is a scratch materialization — it writes
 *     files but must NOT update `exported_files` or
 *     `runs.export_status='synced'` (P1-1).
 */

const RUN_ID = "run-20260523-apps-user-mx1";
const PRIOR_EXPORT = process.env.HARNESS_EXPORT_FILES;

function setupRoot(): { runsDir: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-mxtrack-"));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  return { runsDir, dbPath: join(root, ".harness", "harness.sqlite") };
}

function seedDbFirstRun(dbPath: string, runId: string): void {
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
         status, source_mode, db_revision, export_status, started_at,
         updated_at, meta_json)
       VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
         'db-first', 1, 'disabled', ?, ?, ?)`,
    ).run(runId, meta.startedAt, meta.startedAt, JSON.stringify(meta));
    // an artifact body so materialize has something to write
    const blob = storeArtifactBlob(db, Buffer.from("summary\n"));
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
         content_type, bytes, sha256, storage, blob_sha256, body_status)
       VALUES (?, ?, 'summary', 'summary.md', 'text/markdown', ?, ?, 'db',
         ?, 'db_available')`,
    ).run(`${runId}:summary.md`, runId, blob.bytes, blob.sha256, blob.sha256);
  } finally {
    db.close();
  }
}

function insertActiveProposal(dbPath: string, runId: string, sourceYaml: string): void {
  const db = openDb(dbPath);
  try {
    new ReviewProposalRepository(db).insertProposal({
      runId,
      reviewer: "codex-reviewer",
      decision: "approved",
      requiredChanges: [],
      nonBlockingComments: [],
      outOfScopeSuggestions: [],
      reviewedAt: "2026-05-23T10:00:00Z",
      sourceYaml,
      sourceSha256: "dead",
      createdAt: "2026-05-23T10:00:00Z",
    });
  } finally {
    db.close();
  }
}

const PROPOSAL_YAML = [
  `runId: ${RUN_ID}`,
  "domain: apps/user",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "reviewer: codex-reviewer",
  "reviewed_at: 2026-05-23T10:00:00Z",
  "",
].join("\n");

beforeEach(() => {
  process.env.HARNESS_SUPPRESS_EXPORT_MODE_WARNING = "1";
  _resetExportModeWarningForTest();
});

afterEach(() => {
  if (PRIOR_EXPORT === undefined) delete process.env.HARNESS_EXPORT_FILES;
  else process.env.HARNESS_EXPORT_FILES = PRIOR_EXPORT;
  _resetExportModeWarningForTest();
});

describe("exportRun review sidecar — active proposal wins over pending (P1-2)", () => {
  it("forced export emits the active proposal as review-decision.yaml", () => {
    const { runsDir, dbPath } = setupRoot();
    seedDbFirstRun(dbPath, RUN_ID);
    insertActiveProposal(dbPath, RUN_ID, PROPOSAL_YAML);

    const db = openDb(dbPath);
    try {
      // simulate `harness db export-files` for this run
      const r = exportRun(db, RUN_ID, { runsDir, force: true });
      expect(r.status).toBe("synced");
      const yaml = readFileSync(
        join(runsDir, RUN_ID, "review-decision.yaml"),
        "utf8",
      );
      // must contain the proposal's decision, NOT a `pending` template
      expect(yaml).toMatch(/decision: approved/);
      expect(yaml).not.toMatch(/decision: pending/);
      expect(yaml).toMatch(/reviewer: codex-reviewer/);
    } finally {
      db.close();
    }
  });
});

describe("ensureRunMaterialized — scratch materialization (P1-1)", () => {
  it(
    "writes files but does NOT update exported_files or " +
      "runs.export_status='synced'",
    () => {
      const { runsDir, dbPath } = setupRoot();
      seedDbFirstRun(dbPath, RUN_ID);

      // baseline: run row is `export_status='disabled'`, no exported_files
      {
        const db = openDb(dbPath);
        try {
          const before = db
            .prepare("SELECT export_status FROM runs WHERE run_id = ?")
            .get(RUN_ID) as { export_status: string };
          expect(before.export_status).toBe("disabled");
          const efCount = db
            .prepare(
              "SELECT COUNT(*) AS n FROM exported_files WHERE scope_id = ?",
            )
            .get(RUN_ID) as { n: number };
          expect(efCount.n).toBe(0);
        } finally {
          db.close();
        }
      }

      const wrote = ensureRunMaterialized({ dbPath, runsDir, runId: RUN_ID });
      expect(wrote).toBe(true);
      // files exist (the reviewer agent needs them on disk)
      expect(existsSync(join(runsDir, RUN_ID, "meta.json"))).toBe(true);
      expect(existsSync(join(runsDir, RUN_ID, "summary.md"))).toBe(true);

      // CRUCIAL: the export tracking is untouched — Phase 9 post-close
      // P1-1 fix. A scratch materialize must NOT advertise itself as a
      // compatibility export, or `run show` (file-first) would lock in
      // on the scratch dir even after it gets cleaned up.
      const db = openDb(dbPath);
      try {
        const after = db
          .prepare("SELECT export_status FROM runs WHERE run_id = ?")
          .get(RUN_ID) as { export_status: string };
        expect(after.export_status).toBe("disabled");
        const efCount = db
          .prepare(
            "SELECT COUNT(*) AS n FROM exported_files WHERE scope_id = ?",
          )
          .get(RUN_ID) as { n: number };
        expect(efCount.n).toBe(0);
      } finally {
        db.close();
      }
    },
  );
});
