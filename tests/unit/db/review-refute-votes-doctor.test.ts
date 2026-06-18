import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { targetChangeHash } from "../../../src/core/refute-binding.js";
import { MIGRATIONS, runMigrations } from "../../../src/db/migrations.js";
import { runDoctor, DEFAULT_CHECKS } from "../../../src/db/doctor.js";
import { REVIEW_REFUTE_VOTE_DOCTOR_CHECKS } from "../../../src/db/review-refute-vote-doctor-checks.js";

const NOW = "2026-06-17T00:00:00.000Z";

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function preV32Db(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  ).run();
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of [...MIGRATIONS]
    .filter((m) => m.version < 32)
    .sort((a, b) => a.version - b.version)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    insert.run(m.version, m.name, NOW);
  }
  return db;
}

function seedHitch(db: Database.Database, hitchId: string): void {
  db.prepare(
    `INSERT INTO hitch_sessions
       (hitch_id, title, status, scope_json, close_conditions_json,
        policy_json, max_iterations, max_review_cycles, max_reruns,
        max_total_new_findings, created_by, created_source,
        created_at, updated_at)
     VALUES (?, ?, 'open', '{}', '[]', '{}', 10, 5, 3, 100,
             'tester', 'cli', ?, ?)`,
  ).run(hitchId, `session ${hitchId}`, NOW, NOW);
}

function seedFinding(
  db: Database.Database,
  hitchId: string,
  findingId: string,
): void {
  db.prepare(
    `INSERT INTO hitch_findings
       (finding_id, hitch_id, stable_key, source, severity, category,
        scope_status, lifecycle_status, summary, file_path,
        first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'review', 'P1', 'core', 'unknown', 'open',
             'a finding', 'src/a.ts', ?, ?)`,
  ).run(findingId, hitchId, `key-${findingId}`, NOW, NOW);
}

function insertReviewRefuteVote(
  db: Database.Database,
  opts: {
    runId?: string;
    hitchId?: string | null;
    findingId?: string | null;
    targetChangeHash?: string;
    validationStatus?: "passed" | "rejected";
    rejectReason?: string | null;
    promptSha256?: string;
  },
): void {
  db.prepare(
    `INSERT INTO review_refute_votes
       (run_id, hitch_id, target_change_hash, finding_id, reviewer_id,
        refute_verdict, prompt_sha256, source_sha256, validation_status,
        reject_reason, created_at)
     VALUES (?, ?, ?, ?, 'reviewer-a', 'uphold', ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId ?? "run-1",
    opts.hitchId ?? null,
    opts.targetChangeHash ?? targetChangeHash("target change"),
    opts.findingId ?? null,
    opts.promptSha256 ?? "prompt-a",
    `source-${opts.promptSha256 ?? "a"}`,
    opts.validationStatus ?? "passed",
    opts.validationStatus === "rejected"
      ? (opts.rejectReason ?? "binding failed")
      : (opts.rejectReason ?? null),
    NOW,
  );
}

function seedRequiredChange(
  db: Database.Database,
  runId: string,
  idx: number,
  changeText: string,
): void {
  db.prepare(
    `INSERT INTO review_required_changes (run_id, idx, change_text)
     VALUES (?, ?, ?)`,
  ).run(runId, idx, changeText);
}

function flaggedCheckIds(db: Database.Database): string[] {
  return runDoctor(db, { category: "review" })
    .findings.filter((f) => f.status === "flagged")
    .map((f) => f.checkId);
}

describe("doctor review_refute_votes.orphan_rows", () => {
  it("flags a vote whose finding no longer exists", () => {
    const db = migratedDb();
    insertReviewRefuteVote(db, { hitchId: "h1", findingId: "ghost" });
    expect(flaggedCheckIds(db)).toContain("review_refute_votes.orphan_rows");
  });

  it("does not flag a vote without finding_id as an orphan", () => {
    const db = migratedDb();
    insertReviewRefuteVote(db, { hitchId: "h1", findingId: null });
    expect(flaggedCheckIds(db)).not.toContain(
      "review_refute_votes.orphan_rows",
    );
  });
});

describe("doctor review_refute_votes.hitch_mismatch", () => {
  it("flags a vote whose stored hitch_id disagrees with hitch_findings", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedHitch(db, "h2");
    seedFinding(db, "h1", "f1");
    insertReviewRefuteVote(db, { hitchId: "h2", findingId: "f1" });
    expect(flaggedCheckIds(db)).toContain(
      "review_refute_votes.hitch_mismatch",
    );
  });

  it("does not flag an orphan as a hitch mismatch", () => {
    const db = migratedDb();
    insertReviewRefuteVote(db, { hitchId: "h1", findingId: "ghost" });
    expect(flaggedCheckIds(db)).not.toContain(
      "review_refute_votes.hitch_mismatch",
    );
  });

  it("does not flag a matching finding binding", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    insertReviewRefuteVote(db, { hitchId: "h1", findingId: "f1" });
    const ids = flaggedCheckIds(db);
    expect(ids).not.toContain("review_refute_votes.orphan_rows");
    expect(ids).not.toContain("review_refute_votes.hitch_mismatch");
  });
});

describe("doctor review_refute_votes.target_hash_mismatch", () => {
  it("flags a passed vote whose target hash is not an active required change", () => {
    const db = migratedDb();
    seedRequiredChange(db, "run-1", 0, "add validation");
    insertReviewRefuteVote(db, {
      targetChangeHash: targetChangeHash("unknown target"),
    });
    expect(flaggedCheckIds(db)).toContain(
      "review_refute_votes.target_hash_mismatch",
    );
  });

  it("does not flag a passed vote whose hash matches after normalization", () => {
    const db = migratedDb();
    seedRequiredChange(db, "run-1", 0, " Cafe\u0301\tneeds   validation\r\nsoon ");
    insertReviewRefuteVote(db, {
      targetChangeHash: targetChangeHash("Café needs validation\nsoon"),
    });
    expect(flaggedCheckIds(db)).not.toContain(
      "review_refute_votes.target_hash_mismatch",
    );
  });

  it("does not flag rejected votes with unbound target hashes", () => {
    const db = migratedDb();
    seedRequiredChange(db, "run-1", 0, "add validation");
    insertReviewRefuteVote(db, {
      targetChangeHash: targetChangeHash("unknown target"),
      validationStatus: "rejected",
    });
    expect(flaggedCheckIds(db)).not.toContain(
      "review_refute_votes.target_hash_mismatch",
    );
  });
});

describe("review_refute_votes doctor check registration", () => {
  it("registers the v32 advisory checks in DEFAULT_CHECKS", () => {
    for (const check of REVIEW_REFUTE_VOTE_DOCTOR_CHECKS) {
      expect(DEFAULT_CHECKS.map((c) => c.id)).toContain(check.id);
      expect(check.severity).toBe("warn");
      expect(check.category).toBe("review");
    }
  });

  it("skips safely on a pre-v32 DB", () => {
    const db = preV32Db();
    expect(() => runDoctor(db, { category: "review" })).not.toThrow();
    expect(flaggedCheckIds(db)).not.toContain(
      "review_refute_votes.orphan_rows",
    );
  });
});
