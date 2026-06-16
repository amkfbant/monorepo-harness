import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { runDoctor } from "../../../src/db/doctor.js";

/**
 * RED for Task A3 (#230) — doctor checks for jury audit integrity.
 *
 * The three v31 jury tables (`jury_classification_proposals`,
 * `jury_classification_refutations`, `jury_severity_audits`) carry no
 * foreign keys: `finding_id` is the authoritative key, `hitch_id` an
 * advisory denormalised column. doctor reports — never silently repairs —
 * inconsistencies that a missing FK would otherwise hide.
 *
 * checks under test (category "review"):
 *  1. jury.orphan_rows          — finding/hitch gone but jury rows remain.
 *  2. jury.hitch_mismatch       — stored hitch_id != hitch_findings join.
 *  3. jury.refutation_mismatch  — refutation.target_scope != proposals'
 *                                 unanimous scope, OR packet.refuter
 *                                 (from recommended_next_action JSON) !=
 *                                 stored refutation.refute_verdict.
 */

const NOW = "2026-01-01T00:00:00Z";

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
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

/** Insert a proposal row directly (bypassing the repository guard). */
function insertProposal(
  db: Database.Database,
  opts: {
    findingId: string;
    hitchId: string;
    lens: string;
    reviewerId: string;
    proposedScope: string;
    deliberationId: string;
    round?: number;
    promptSha256?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jury_classification_proposals
       (finding_id, hitch_id, lens, reviewer_id, proposed_scope,
        proposal_status, prompt_sha256, round, evidence_json,
        deliberation_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, '[]', ?, ?)`,
  ).run(
    opts.findingId,
    opts.hitchId,
    opts.lens,
    opts.reviewerId,
    opts.proposedScope,
    opts.promptSha256 ?? `${opts.lens}-sha`,
    opts.round ?? 1,
    opts.deliberationId,
    NOW,
  );
}

/** Insert a refutation row directly (bypassing the repository guard). */
function insertRefutation(
  db: Database.Database,
  opts: {
    findingId: string;
    hitchId: string;
    targetScope: string;
    refuteVerdict: string;
    deliberationId: string;
    reviewerId?: string;
    promptSha256?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jury_classification_refutations
       (finding_id, hitch_id, target_scope, refute_verdict, reviewer_id,
        prompt_sha256, deliberation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.findingId,
    opts.hitchId,
    opts.targetScope,
    opts.refuteVerdict,
    opts.reviewerId ?? "refuter",
    opts.promptSha256 ?? "ref-sha",
    opts.deliberationId,
    NOW,
  );
}

function flaggedCheckIds(db: Database.Database): string[] {
  return runDoctor(db, { category: "review" })
    .findings.filter((f) => f.status === "flagged")
    .map((f) => f.checkId);
}

describe("doctor jury.orphan_rows", () => {
  it("flags a proposal whose finding no longer exists", () => {
    const db = migratedDb();
    // No hitch / finding seeded — an orphan proposal row.
    insertProposal(db, {
      findingId: "ghost",
      hitchId: "h1",
      lens: "correctness",
      reviewerId: "r1",
      proposedScope: "in_scope",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).toContain("jury.orphan_rows");
  });

  it("flags a refutation whose finding no longer exists", () => {
    const db = migratedDb();
    insertRefutation(db, {
      findingId: "ghost",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).toContain("jury.orphan_rows");
  });

  it("flags a severity audit whose finding no longer exists", () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO jury_severity_audits
         (finding_id, hitch_id, harness_severity, audit_status,
          escalate_flag, prompt_sha256, jury_votes_json,
          deliberation_id, created_at)
       VALUES ('ghost', 'h1', 'P1', 'aligned', 0, 'sha', '[]', 'd1', ?)`,
    ).run(NOW);
    expect(flaggedCheckIds(db)).toContain("jury.orphan_rows");
  });

  it("does NOT flag a proposal whose finding still exists", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    insertProposal(db, {
      findingId: "f1",
      hitchId: "h1",
      lens: "correctness",
      reviewerId: "r1",
      proposedScope: "in_scope",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).not.toContain("jury.orphan_rows");
  });

  it("orphan finding is advisory: severity is warn (not error/critical)", () => {
    const db = migratedDb();
    insertProposal(db, {
      findingId: "ghost",
      hitchId: "h1",
      lens: "correctness",
      reviewerId: "r1",
      proposedScope: "in_scope",
      deliberationId: "d1",
    });
    const orphan = runDoctor(db, { category: "review" }).findings.find(
      (f) => f.checkId === "jury.orphan_rows" && f.status === "flagged",
    );
    expect(orphan).toBeDefined();
    expect(orphan?.severity).toBe("warn");
  });
});

describe("doctor jury.hitch_mismatch", () => {
  it("flags a proposal whose stored hitch_id != hitch_findings join", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedHitch(db, "h2");
    seedFinding(db, "h1", "f1"); // f1 truly belongs to h1
    // stored hitch_id says h2 — a denormalisation drift.
    insertProposal(db, {
      findingId: "f1",
      hitchId: "h2",
      lens: "correctness",
      reviewerId: "r1",
      proposedScope: "in_scope",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).toContain("jury.hitch_mismatch");
  });

  it("does NOT flag when stored hitch_id matches the join", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    insertProposal(db, {
      findingId: "f1",
      hitchId: "h1",
      lens: "correctness",
      reviewerId: "r1",
      proposedScope: "in_scope",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).not.toContain("jury.hitch_mismatch");
  });

  it("does NOT flag an orphan as a hitch mismatch (orphan has no join row)", () => {
    const db = migratedDb();
    insertProposal(db, {
      findingId: "ghost",
      hitchId: "h1",
      lens: "correctness",
      reviewerId: "r1",
      proposedScope: "in_scope",
      deliberationId: "d1",
    });
    // orphan is reported by jury.orphan_rows, not hitch_mismatch.
    expect(flaggedCheckIds(db)).not.toContain("jury.hitch_mismatch");
  });
});

describe("doctor jury.refutation_mismatch", () => {
  it("flags refutation.target_scope != proposals' unanimous scope", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    // three lenses unanimous in_scope
    for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "in_scope",
        deliberationId: "d1",
      });
    }
    // refuter targeted the WRONG scope (out_of_scope) for d1.
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "out_of_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).toContain("jury.refutation_mismatch");
  });

  it("does NOT flag when refutation.target_scope == unanimous scope", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "in_scope",
        deliberationId: "d1",
      });
    }
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).not.toContain("jury.refutation_mismatch");
  });

  it("does NOT flag a refutation when proposals are split (no unanimous scope to compare)", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    insertProposal(db, {
      findingId: "f1",
      hitchId: "h1",
      lens: "correctness",
      reviewerId: "correctness",
      proposedScope: "in_scope",
      deliberationId: "d1",
    });
    insertProposal(db, {
      findingId: "f1",
      hitchId: "h1",
      lens: "scope_fit",
      reviewerId: "scope_fit",
      proposedScope: "out_of_scope",
      deliberationId: "d1",
    });
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    // No unanimous scope => target_scope check is vacuous; no flag from it.
    expect(flaggedCheckIds(db)).not.toContain("jury.refutation_mismatch");
  });

  it("uses the LATEST round's proposals when computing unanimity", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    // round 1 split, round 2 (latest) unanimous in_scope.
    for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: lens === "scope_fit" ? "out_of_scope" : "in_scope",
        deliberationId: "d1",
        round: 1,
        promptSha256: `${lens}-r1`,
      });
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "in_scope",
        deliberationId: "d1",
        round: 2,
        promptSha256: `${lens}-r2`,
      });
    }
    // refuter targeted in_scope (matches the LATEST round unanimous scope).
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).not.toContain("jury.refutation_mismatch");
  });

  it("flags when packet.refuter (recommended_next_action JSON) disagrees with stored refutation verdict", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "in_scope",
        deliberationId: "d1",
      });
    }
    // stored refutation says 'refute' ...
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "refute",
      deliberationId: "d1",
    });
    // ... but the persisted packet says the refuter upheld it.
    seedDecisionWithPacket(db, "h1", {
      decisionPacket: {
        findingId: "f1",
        deliberationId: "d1",
        deliberation: { refuter: { refuteVerdict: "uphold" } },
      },
    });
    expect(flaggedCheckIds(db)).toContain("jury.refutation_mismatch");
  });

  it("does NOT flag when packet.refuter agrees with stored refutation verdict", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "in_scope",
        deliberationId: "d1",
      });
    }
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    seedDecisionWithPacket(db, "h1", {
      decisionPacket: {
        findingId: "f1",
        deliberationId: "d1",
        deliberation: { refuter: { refuteVerdict: "uphold" } },
      },
    });
    expect(flaggedCheckIds(db)).not.toContain("jury.refutation_mismatch");
  });

  it("does NOT crash on a malformed recommended_next_action JSON (defensive parse)", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "in_scope",
        deliberationId: "d1",
      });
    }
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    db.prepare(
      `INSERT INTO hitch_convergence_decisions
         (decision_id, hitch_id, decision, reason, metrics_json,
          recommended_next_action, created_at, created_by)
       VALUES ('dec-bad', 'h1', 'escalate', 'r', '{}',
               'not json at all', ?, 'tester')`,
    ).run(NOW);
    expect(() => runDoctor(db, { category: "review" })).not.toThrow();
    // packet absent/unparseable => only the target_scope sub-check applies;
    // target_scope matches, so no flag.
    expect(flaggedCheckIds(db)).not.toContain("jury.refutation_mismatch");
  });
});

/**
 * Seed a `hitch_convergence_decisions` row whose recommended_next_action
 * carries a `decisionPacket` (#230 packet v2 — additive optional field).
 */
function seedDecisionWithPacket(
  db: Database.Database,
  hitchId: string,
  nextAction: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO hitch_convergence_decisions
       (decision_id, hitch_id, decision, reason, metrics_json,
        recommended_next_action, created_at, created_by)
     VALUES (?, ?, 'escalate', 'escalated', '{}', ?, ?, 'tester')`,
  ).run(
    `dec-${randomId()}`,
    hitchId,
    JSON.stringify(nextAction),
    NOW,
  );
}

function randomId(): string {
  return Math.random().toString(36).slice(2);
}
