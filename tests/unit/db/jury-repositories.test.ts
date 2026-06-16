import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { JuryClassificationProposalRepository } from "../../../src/db/repositories/jury-classification-proposals.js";
import { JuryClassificationRefutationRepository } from "../../../src/db/repositories/jury-classification-refutations.js";
import { JurySeverityAuditRepository } from "../../../src/db/repositories/jury-severity-audits.js";

/**
 * Insert a minimal `hitch_sessions` row + a `hitch_findings` row so the
 * jury audit rows have a real (finding_id -> hitch_id) pair to validate
 * against. `hitch_findings` has an ON DELETE CASCADE FK to
 * `hitch_sessions`, so the session must exist first.
 */
function dbWithFinding(hitchId: string, findingId: string): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const now = "2026-01-01T00:00:00Z";
  db.prepare(
    `INSERT INTO hitch_sessions
       (hitch_id, title, status, scope_json, close_conditions_json,
        policy_json, max_iterations, max_review_cycles, max_reruns,
        max_total_new_findings, created_by, created_source,
        created_at, updated_at)
     VALUES (?, ?, 'open', '{}', '[]', '{}', 10, 5, 3, 100,
             'tester', 'cli', ?, ?)`,
  ).run(hitchId, `session ${hitchId}`, now, now);
  db.prepare(
    `INSERT INTO hitch_findings
       (finding_id, hitch_id, stable_key, source, severity, category,
        scope_status, lifecycle_status, summary, file_path,
        first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'review', 'P1', 'core', 'unknown', 'open',
             'a finding', 'src/a.ts', ?, ?)`,
  ).run(findingId, hitchId, `key-${findingId}`, now, now);
  return db;
}

describe("JuryClassificationProposalRepository", () => {
  it("insert persists a round-1 proposal with evidence_json and deliberation_id", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    repo.insert({
      findingId: "f1",
      hitchId: "h1",
      lens: "correctness",
      reviewerId: "r1",
      proposedScope: "in_scope",
      proposalStatus: "complete",
      round: 1,
      evidence: [
        { citation: "src/a.ts:10", kind: "file", claim: "x", verified: true },
      ],
      promptSha256: "abc",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const rows = db
      .prepare("SELECT * FROM jury_classification_proposals WHERE finding_id=?")
      .all("f1") as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.lens).toBe("correctness");
    expect(row.round).toBe(1);
    expect(row.deliberation_id).toBe("d1");
    expect(row.proposed_scope).toBe("in_scope");
    expect(JSON.parse(row.evidence_json as string)).toEqual([
      { citation: "src/a.ts:10", kind: "file", claim: "x", verified: true },
    ]);
  });

  it("empty evidence array round-trips as '[]' (not null)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    repo.insert({
      findingId: "f1",
      hitchId: "h1",
      lens: "scope_fit",
      reviewerId: "r1",
      proposedScope: "unknown",
      proposalStatus: "inconclusive",
      round: 1,
      evidence: [],
      promptSha256: "p",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const row = db
      .prepare(
        "SELECT evidence_json FROM jury_classification_proposals WHERE finding_id=?",
      )
      .get("f1") as { evidence_json: string };
    expect(JSON.parse(row.evidence_json)).toEqual([]);
  });

  it("business-key dedup: same (finding,lens,reviewer,round,prompt_sha256,deliberation_id) inserted twice -> 1 row", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    const base = {
      findingId: "f1",
      hitchId: "h1",
      lens: "correctness" as const,
      reviewerId: "r1",
      proposedScope: "in_scope" as const,
      proposalStatus: "complete" as const,
      round: 1 as const,
      evidence: [],
      promptSha256: "same",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    };
    repo.insert(base);
    repo.insert(base); // INSERT OR IGNORE on business key
    const c = db
      .prepare(
        "SELECT count(*) c FROM jury_classification_proposals WHERE finding_id=?",
      )
      .get("f1") as { c: number };
    expect(c.c).toBe(1);
  });

  it("different deliberation_id (retry) is a separate row (R15)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    const base = {
      findingId: "f1",
      hitchId: "h1",
      lens: "correctness" as const,
      reviewerId: "r1",
      proposedScope: "in_scope" as const,
      proposalStatus: "complete" as const,
      round: 1 as const,
      evidence: [],
      promptSha256: "same",
      createdAt: "2026-01-01T00:00:00Z",
    };
    repo.insert({ ...base, deliberationId: "d1" });
    repo.insert({ ...base, deliberationId: "d2" });
    const c = db
      .prepare(
        "SELECT count(*) c FROM jury_classification_proposals WHERE finding_id=?",
      )
      .get("f1") as { c: number };
    expect(c.c).toBe(2);
  });

  it("round 1 and round 2 are separate rows (business key includes round)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    const base = {
      findingId: "f1",
      hitchId: "h1",
      lens: "correctness" as const,
      reviewerId: "r1",
      proposedScope: "in_scope" as const,
      proposalStatus: "complete" as const,
      evidence: [],
      promptSha256: "p",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    };
    repo.insert({ ...base, round: 1 });
    repo.insert({ ...base, round: 2, voteChanged: false });
    const c = db
      .prepare(
        "SELECT count(*) c FROM jury_classification_proposals WHERE finding_id=?",
      )
      .get("f1") as { c: number };
    expect(c.c).toBe(2);
  });

  it("round 2 persists vote_changed and critique_json", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    repo.insert({
      findingId: "f1",
      hitchId: "h1",
      lens: "correctness",
      reviewerId: "r1",
      proposedScope: "out_of_scope",
      proposalStatus: "complete",
      round: 2,
      evidence: [],
      voteChanged: true,
      critique: [{ targetLens: "scope_fit", objection: "weak" }],
      promptSha256: "p2",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const row = db
      .prepare(
        "SELECT vote_changed, critique_json FROM jury_classification_proposals WHERE finding_id=? AND round=2",
      )
      .get("f1") as { vote_changed: number; critique_json: string };
    expect(row.vote_changed).toBe(1);
    expect(JSON.parse(row.critique_json)).toEqual([
      { targetLens: "scope_fit", objection: "weak" },
    ]);
  });

  it("rejects insert when finding_id->hitch_id mismatch (R5/P2f fail-closed)", () => {
    const db = dbWithFinding("h1", "f1"); // f1 belongs to h1
    const repo = new JuryClassificationProposalRepository(db);
    expect(() =>
      repo.insert({
        findingId: "f1",
        hitchId: "WRONG",
        lens: "correctness",
        reviewerId: "r1",
        proposedScope: "in_scope",
        proposalStatus: "complete",
        round: 1,
        evidence: [],
        promptSha256: "p",
        deliberationId: "d1",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/hitch_id mismatch/i);
    const c = db
      .prepare("SELECT count(*) c FROM jury_classification_proposals")
      .get() as { c: number };
    expect(c.c).toBe(0);
  });

  it("rejects insert when finding does not exist (fail-closed)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    expect(() =>
      repo.insert({
        findingId: "ghost",
        hitchId: "h1",
        lens: "correctness",
        reviewerId: "r1",
        proposedScope: "in_scope",
        proposalStatus: "complete",
        round: 1,
        evidence: [],
        promptSha256: "p",
        deliberationId: "d1",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/not found/i);
  });
});

describe("JuryClassificationRefutationRepository", () => {
  it("insert persists target_scope, refute_verdict, counter_evidence_json and deliberation_id", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationRefutationRepository(db);
    repo.insert({
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      counterEvidence: [
        { citation: "spec/x.md#a", kind: "spec", claim: "no", verified: true },
      ],
      reasoning: "holds",
      reviewerId: "r1",
      promptSha256: "abc",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const rows = db
      .prepare(
        "SELECT * FROM jury_classification_refutations WHERE finding_id=?",
      )
      .all("f1") as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.target_scope).toBe("in_scope");
    expect(row.refute_verdict).toBe("uphold");
    expect(row.deliberation_id).toBe("d1");
    expect(JSON.parse(row.counter_evidence_json as string)).toEqual([
      { citation: "spec/x.md#a", kind: "spec", claim: "no", verified: true },
    ]);
  });

  it("null counter_evidence stays null (not 'null' string)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationRefutationRepository(db);
    repo.insert({
      findingId: "f1",
      hitchId: "h1",
      targetScope: "out_of_scope",
      refuteVerdict: "refute",
      reasoning: "broken",
      reviewerId: "r1",
      promptSha256: "abc",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const row = db
      .prepare(
        "SELECT counter_evidence_json FROM jury_classification_refutations WHERE finding_id=?",
      )
      .get("f1") as { counter_evidence_json: string | null };
    expect(row.counter_evidence_json).toBeNull();
  });

  it("business-key dedup: same (finding,target_scope,reviewer,prompt_sha256,deliberation_id) twice -> 1 row", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationRefutationRepository(db);
    const base = {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope" as const,
      refuteVerdict: "uphold" as const,
      reviewerId: "r1",
      promptSha256: "same",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    };
    repo.insert(base);
    repo.insert(base);
    const c = db
      .prepare(
        "SELECT count(*) c FROM jury_classification_refutations WHERE finding_id=?",
      )
      .get("f1") as { c: number };
    expect(c.c).toBe(1);
  });

  it("different deliberation_id (retry) is a separate row (R15)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationRefutationRepository(db);
    const base = {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope" as const,
      refuteVerdict: "uphold" as const,
      reviewerId: "r1",
      promptSha256: "same",
      createdAt: "2026-01-01T00:00:00Z",
    };
    repo.insert({ ...base, deliberationId: "d1" });
    repo.insert({ ...base, deliberationId: "d2" });
    const c = db
      .prepare(
        "SELECT count(*) c FROM jury_classification_refutations WHERE finding_id=?",
      )
      .get("f1") as { c: number };
    expect(c.c).toBe(2);
  });

  it("rejects insert when finding_id->hitch_id mismatch (fail-closed)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationRefutationRepository(db);
    expect(() =>
      repo.insert({
        findingId: "f1",
        hitchId: "WRONG",
        targetScope: "in_scope",
        refuteVerdict: "uphold",
        reviewerId: "r1",
        promptSha256: "p",
        deliberationId: "d1",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/hitch_id mismatch/i);
  });
});

describe("JurySeverityAuditRepository", () => {
  it("insert persists jury_votes_json round-trip + verdict columns + deliberation_id", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JurySeverityAuditRepository(db);
    const juryVotes = [
      {
        lens: "correctness",
        proposedSeverity: "P0",
        reasoning: "critical",
        round: 1,
      },
      {
        lens: "scope_fit",
        proposedSeverity: "P1",
        reasoning: "high",
        round: 1,
      },
    ];
    repo.insert({
      findingId: "f1",
      hitchId: "h1",
      harnessSeverity: "P1",
      jurySeverity: "P0",
      auditStatus: "diverged",
      escalateFlag: true,
      reasoning: "jury raised it",
      juryVotes,
      promptSha256: "abc",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const rows = db
      .prepare("SELECT * FROM jury_severity_audits WHERE finding_id=?")
      .all("f1") as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.harness_severity).toBe("P1");
    expect(row.jury_severity).toBe("P0");
    expect(row.audit_status).toBe("diverged");
    expect(row.escalate_flag).toBe(1);
    expect(row.deliberation_id).toBe("d1");
    expect(JSON.parse(row.jury_votes_json as string)).toEqual(juryVotes);
  });

  it("escalateFlag false stores 0; null jurySeverity stays null", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JurySeverityAuditRepository(db);
    repo.insert({
      findingId: "f1",
      hitchId: "h1",
      harnessSeverity: "P2",
      auditStatus: "aligned",
      escalateFlag: false,
      juryVotes: [],
      promptSha256: "abc",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const row = db
      .prepare(
        "SELECT escalate_flag, jury_severity FROM jury_severity_audits WHERE finding_id=?",
      )
      .get("f1") as { escalate_flag: number; jury_severity: string | null };
    expect(row.escalate_flag).toBe(0);
    expect(row.jury_severity).toBeNull();
  });

  it("business-key dedup: same (finding,prompt_sha256,deliberation_id) twice -> 1 row", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JurySeverityAuditRepository(db);
    const base = {
      findingId: "f1",
      hitchId: "h1",
      harnessSeverity: "P1" as const,
      auditStatus: "aligned" as const,
      escalateFlag: false,
      juryVotes: [],
      promptSha256: "same",
      deliberationId: "d1",
      createdAt: "2026-01-01T00:00:00Z",
    };
    repo.insert(base);
    repo.insert(base);
    const c = db
      .prepare("SELECT count(*) c FROM jury_severity_audits WHERE finding_id=?")
      .get("f1") as { c: number };
    expect(c.c).toBe(1);
  });

  it("different deliberation_id (retry) is a separate row (R15)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JurySeverityAuditRepository(db);
    const base = {
      findingId: "f1",
      hitchId: "h1",
      harnessSeverity: "P1" as const,
      auditStatus: "aligned" as const,
      escalateFlag: false,
      juryVotes: [],
      promptSha256: "same",
      createdAt: "2026-01-01T00:00:00Z",
    };
    repo.insert({ ...base, deliberationId: "d1" });
    repo.insert({ ...base, deliberationId: "d2" });
    const c = db
      .prepare("SELECT count(*) c FROM jury_severity_audits WHERE finding_id=?")
      .get("f1") as { c: number };
    expect(c.c).toBe(2);
  });

  it("rejects insert when finding_id->hitch_id mismatch (fail-closed)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JurySeverityAuditRepository(db);
    expect(() =>
      repo.insert({
        findingId: "f1",
        hitchId: "WRONG",
        harnessSeverity: "P1",
        auditStatus: "aligned",
        escalateFlag: false,
        juryVotes: [],
        promptSha256: "p",
        deliberationId: "d1",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/hitch_id mismatch/i);
  });
});
