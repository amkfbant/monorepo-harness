import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, runMigrations } from "../../../src/db/migrations.js";
import { runDoctor, DEFAULT_CHECKS } from "../../../src/db/doctor.js";
import { JURY_DOCTOR_CHECKS, JURY_TABLES } from "../../../src/db/jury-doctor-checks.js";

const DOCTOR_CHECKS_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/jury-doctor-checks.ts",
);

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

/**
 * A genuinely PRE-v31 DB: every migration BELOW v31 is applied directly, so the
 * three v31 jury tables (`jury_classification_proposals`,
 * `jury_classification_refutations`, `jury_severity_audits`) are ABSENT — exactly
 * the state a read-only caller (e.g. `dbRepairDryRunTool` → `DEFAULT_CHECKS.flatMap`)
 * sees before the harness has been upgraded/migrated to v31.
 */
function preV31Db(): Database.Database {
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
    .filter((m) => m.version < 31)
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
    proposalStatus?: string;
    /** Stored VerifiedJuryEvidence[] (defaults to '[]'). */
    evidenceJson?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jury_classification_proposals
       (finding_id, hitch_id, lens, reviewer_id, proposed_scope,
        proposal_status, prompt_sha256, round, evidence_json,
        deliberation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.findingId,
    opts.hitchId,
    opts.lens,
    opts.reviewerId,
    opts.proposedScope,
    opts.proposalStatus ?? "complete",
    opts.promptSha256 ?? `${opts.lens}-sha`,
    opts.round ?? 1,
    opts.evidenceJson ?? "[]",
    opts.deliberationId,
    NOW,
  );
}

/**
 * A verified+proximate file-kind evidence JSON for finding.file_path 'src/a.ts'.
 * The replay check reconstructs VerifiedJuryEvidence from this stored JSON; the
 * citation segment must match the finding's filePath for proximityOk to pass.
 */
function verifiedEvidenceJson(citation = "src/a.ts:1"): string {
  return JSON.stringify([
    { citation, kind: "file", claim: "c", verified: true },
  ]);
}

/**
 * Seed a fully jury-auto_confirmed finding: 3 distinct lenses unanimous
 * in_scope with verified+proximate evidence, an uphold refutation, and the
 * finding's classification_reason embedding the deliberation_id. Replaying
 * aggregateDeliberation over these rows yields decision==='auto_confirm'.
 */
function seedAutoConfirmedFinding(
  db: Database.Database,
  opts: { hitchId: string; findingId: string; deliberationId: string },
): void {
  for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
    insertProposal(db, {
      findingId: opts.findingId,
      hitchId: opts.hitchId,
      lens,
      reviewerId: lens,
      proposedScope: "in_scope",
      deliberationId: opts.deliberationId,
      evidenceJson: verifiedEvidenceJson(),
      promptSha256: `${opts.findingId}-${lens}`,
    });
  }
  insertRefutation(db, {
    findingId: opts.findingId,
    hitchId: opts.hitchId,
    targetScope: "in_scope",
    refuteVerdict: "uphold",
    deliberationId: opts.deliberationId,
    promptSha256: `ref-${opts.findingId}`,
  });
  db.prepare(
    `UPDATE hitch_findings
        SET scope_status = 'in_scope',
            classification_reason = ?
      WHERE finding_id = ?`,
  ).run(
    `jury auto_confirm (deliberation_id=${opts.deliberationId})`,
    opts.findingId,
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

  it("flags a refutation whose stored hitch_id != hitch_findings join", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedHitch(db, "h2");
    seedFinding(db, "h1", "f1"); // f1 truly belongs to h1
    // stored hitch_id says h2 — a denormalisation drift on the refutation row.
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h2",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).toContain("jury.hitch_mismatch");
  });

  it("flags a severity audit whose stored hitch_id != hitch_findings join", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedHitch(db, "h2");
    seedFinding(db, "h1", "f1"); // f1 truly belongs to h1
    // stored hitch_id says h2 — a denormalisation drift on the audit row.
    db.prepare(
      `INSERT INTO jury_severity_audits
         (finding_id, hitch_id, harness_severity, audit_status,
          escalate_flag, prompt_sha256, jury_votes_json,
          deliberation_id, created_at)
       VALUES ('f1', 'h2', 'P1', 'aligned', 0, 'sha', '[]', 'd1', ?)`,
    ).run(NOW);
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

  it("uses the LATEST round's unanimous scope (a post-critique re-vote supersedes round 1)", () => {
    // This case is constructed so it DISCRIMINATES the MAX(round) rule from
    // both buggy variants:
    //  - round 1 is unanimous in_scope; round 2 (latest) is unanimous
    //    out_of_scope (a post-critique flip).
    //  - the refuter targeted in_scope — the STALE round-1 value.
    // Correct MAX(round): latest unanimous scope = out_of_scope, which
    //   disagrees with target_scope=in_scope => MUST FLAG.
    // Buggy all-rounds: round 1+2 mix in_scope & out_of_scope => not
    //   unanimous => null => would NOT flag.
    // Buggy earliest-round (MIN): round 1 unanimous in_scope == target_scope
    //   in_scope => would NOT flag.
    // So asserting the FLAG genuinely pins MAX(round) behaviour.
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
      // round 1: unanimous in_scope.
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "in_scope",
        deliberationId: "d1",
        round: 1,
        promptSha256: `${lens}-r1`,
      });
      // round 2 (latest): unanimous out_of_scope — supersedes round 1.
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "out_of_scope",
        deliberationId: "d1",
        round: 2,
        promptSha256: `${lens}-r2`,
      });
    }
    // refuter targeted in_scope — the STALE round-1 value, NOT the latest.
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d1",
    });
    // The latest round (out_of_scope) disagrees with target_scope (in_scope).
    expect(flaggedCheckIds(db)).toContain("jury.refutation_mismatch");
    // And it is flagged specifically as a target_scope mismatch against the
    // LATEST unanimous scope (out_of_scope), not the stale round-1 scope.
    const targetScopeFinding = runDoctor(db, { category: "review" }).findings.find(
      (f) =>
        f.checkId === "jury.refutation_mismatch" &&
        f.status === "flagged" &&
        (f.details as { kind?: string }).kind === "target_scope",
    );
    expect(targetScopeFinding).toBeDefined();
    expect((targetScopeFinding?.details as { unanimousScope?: string }).unanimousScope).toBe(
      "out_of_scope",
    );
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
    // Authoritative packet shape (design §0.1 R14 / §5.2 / codex#252-P1):
    // findingId + deliberationId live PER-FINDING in findings[]; the packet
    // carries a single deliberation.refuter block. There is NO top-level
    // packet.findingId / packet.deliberationId.
    seedDecisionWithPacket(db, "h1", {
      decisionPacket: {
        findings: [{ findingId: "f1", deliberationId: "d1" }],
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
        findings: [{ findingId: "f1", deliberationId: "d1" }],
        deliberation: { refuter: { refuteVerdict: "uphold" } },
      },
    });
    expect(flaggedCheckIds(db)).not.toContain("jury.refutation_mismatch");
  });

  it("FIX 3 (codex P1): in a BUNDLED multi-finding packet, packet.deliberation is the LEAD/summary only — the NON-lead finding is NOT falsely packet-mismatched", () => {
    // A mixed-batch escalate packet bundles several findings, each with its
    // OWN deliberationId, under a SINGLE deliberation.refuter block that
    // reflects ONLY the LEAD split (design §0.1 R14 / §5.2 / buildJurySplit
    // Packet: deliberation = splits[0]). Mapping that shared verdict to EVERY
    // finding produces FALSE matches/mismatches for non-lead findings.
    //
    // Here the packet's shared refuter is 'refute' (the LEAD f1's verdict).
    // f1's stored refutation = refute (agrees with the shared block, no flag).
    // f2's stored refutation = uphold and matches f2's OWN deliberation; the
    // shared 'refute' is NOT f2's authority, so f2 must NOT be packet-mismatched.
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    seedFinding(db, "h1", "f2");
    for (const findingId of ["f1", "f2"]) {
      for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
        insertProposal(db, {
          findingId,
          hitchId: "h1",
          lens,
          reviewerId: lens,
          proposedScope: "in_scope",
          deliberationId: `d-${findingId}`,
          promptSha256: `${findingId}-${lens}`,
        });
      }
    }
    // LEAD f1's stored refutation AGREES with the shared (lead) refuter verdict.
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "refute",
      deliberationId: "d-f1",
      promptSha256: "ref-f1",
    });
    // NON-lead f2's stored refutation is 'uphold' — consistent with f2's OWN
    // deliberation rows; it must NOT be compared against the lead's shared
    // 'refute' block (that comparison would be a FALSE mismatch).
    insertRefutation(db, {
      findingId: "f2",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d-f2",
      promptSha256: "ref-f2",
    });
    seedDecisionWithPacket(db, "h1", {
      decisionPacket: {
        findings: [
          { findingId: "f1", deliberationId: "d-f1" },
          { findingId: "f2", deliberationId: "d-f2" },
        ],
        deliberation: { refuter: { refuteVerdict: "refute" } },
      },
    });
    const flagged = runDoctor(db, { category: "review" }).findings.filter(
      (f) => f.checkId === "jury.refutation_mismatch" && f.status === "flagged",
    );
    const packetVerdictFindings = flagged
      .filter((f) => (f.details as { kind?: string }).kind === "packet_verdict")
      .map((f) => (f.details as { findingId?: string }).findingId);
    // The NON-lead finding (f2) must NOT be packet-mismatched against the lead's
    // shared verdict, and the LEAD (f1) agrees so it is not flagged either.
    expect(packetVerdictFindings).not.toContain("f2");
    expect(packetVerdictFindings).not.toContain("f1");
  });

  it("FIX 3 (codex P1): the LEAD finding IS packet-mismatched when its stored refutation disagrees with packet.deliberation.refuter", () => {
    // The packet.deliberation block is the LEAD's summary, so the LEAD finding
    // is still validated against it. Lead f1 stored=uphold but packet shared
    // refuter=refute -> flag f1; f2 (non-lead) is unaffected.
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    seedFinding(db, "h1", "f2");
    for (const findingId of ["f1", "f2"]) {
      for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
        insertProposal(db, {
          findingId,
          hitchId: "h1",
          lens,
          reviewerId: lens,
          proposedScope: "in_scope",
          deliberationId: `d-${findingId}`,
          promptSha256: `${findingId}-${lens}`,
        });
      }
    }
    insertRefutation(db, {
      findingId: "f1",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d-f1",
      promptSha256: "ref-f1",
    });
    insertRefutation(db, {
      findingId: "f2",
      hitchId: "h1",
      targetScope: "in_scope",
      refuteVerdict: "uphold",
      deliberationId: "d-f2",
      promptSha256: "ref-f2",
    });
    seedDecisionWithPacket(db, "h1", {
      decisionPacket: {
        findings: [
          { findingId: "f1", deliberationId: "d-f1" },
          { findingId: "f2", deliberationId: "d-f2" },
        ],
        deliberation: { refuter: { refuteVerdict: "refute" } },
      },
    });
    const flagged = runDoctor(db, { category: "review" }).findings.filter(
      (f) => f.checkId === "jury.refutation_mismatch" && f.status === "flagged",
    );
    const packetVerdictFindings = flagged
      .filter((f) => (f.details as { kind?: string }).kind === "packet_verdict")
      .map((f) => (f.details as { findingId?: string }).findingId);
    expect(packetVerdictFindings).toContain("f1");
    expect(packetVerdictFindings).not.toContain("f2");
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

describe("doctor jury.auto_confirm_replay (FIX 2 / design P2b)", () => {
  it("does NOT flag a jury-auto_confirmed finding whose stored rows replay to auto_confirm", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    seedAutoConfirmedFinding(db, {
      hitchId: "h1",
      findingId: "f1",
      deliberationId: "d1",
    });
    expect(flaggedCheckIds(db)).not.toContain("jury.auto_confirm_replay");
  });

  it("FLAGS a jury-auto_confirmed finding when a stored proposal is tampered so replay yields escalate (LLM->state leak)", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    seedAutoConfirmedFinding(db, {
      hitchId: "h1",
      findingId: "f1",
      deliberationId: "d1",
    });
    // Tamper one stored proposal to out_of_scope -> the replayed set is no
    // longer unanimous -> aggregateDeliberation yields escalate. The finding
    // is still recorded as jury auto_confirm, so the replay must FLAG it.
    db.prepare(
      `UPDATE jury_classification_proposals
          SET proposed_scope = 'out_of_scope'
        WHERE finding_id = 'f1' AND lens = 'spec_adherence'
          AND deliberation_id = 'd1'`,
    ).run();
    const flagged = runDoctor(db, { category: "review" }).findings.filter(
      (f) => f.checkId === "jury.auto_confirm_replay" && f.status === "flagged",
    );
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0]?.severity).toBe("warn");
    expect(flagged[0]?.repairable).toBe(false);
  });

  it("uses the round-2 (final) proposals when round-2 rows exist (selectFinalRound)", () => {
    // round 1 unanimous in_scope (would replay auto_confirm), round 2 (final)
    // split -> replay must consume round 2 and FLAG (proves selectFinalRound).
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    seedAutoConfirmedFinding(db, {
      hitchId: "h1",
      findingId: "f1",
      deliberationId: "d1",
    });
    // Add round-2 rows: a split (one lens dissents) with verified evidence.
    for (const lens of ["correctness", "scope_fit", "spec_adherence"]) {
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: lens === "spec_adherence" ? "out_of_scope" : "in_scope",
        deliberationId: "d1",
        round: 2,
        evidenceJson: verifiedEvidenceJson(),
        promptSha256: `f1-${lens}-r2`,
      });
    }
    expect(flaggedCheckIds(db)).toContain("jury.auto_confirm_replay");
  });

  it("does NOT flag findings that were NOT jury-auto_confirmed (no replay needed)", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");
    // A split deliberation persisted for an escalated (still-unknown) finding:
    // there is no 'jury auto_confirm' classification_reason, so the replay
    // check must not consider it.
    for (const lens of ["correctness", "scope_fit"]) {
      insertProposal(db, {
        findingId: "f1",
        hitchId: "h1",
        lens,
        reviewerId: lens,
        proposedScope: "in_scope",
        deliberationId: "d1",
        evidenceJson: verifiedEvidenceJson(),
        promptSha256: `f1-${lens}`,
      });
    }
    expect(flaggedCheckIds(db)).not.toContain("jury.auto_confirm_replay");
  });
});

describe("jury doctor checks are table-presence guarded on a pre-v31 DB (FIX 3, codex#254-R5 P2)", () => {
  it("the v31 jury tables are absent on a pre-v31 DB (precondition)", () => {
    const db = preV31Db();
    for (const table of JURY_TABLES) {
      const present = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table);
      expect(present).toBeUndefined();
    }
  });

  it("each jury check no-ops cleanly (no throw) when its v31 table is absent", () => {
    const db = preV31Db();
    for (const check of JURY_DOCTOR_CHECKS) {
      expect(() => check.run(db)).not.toThrow();
      // A guarded skip returns zero findings (nothing to flag — and crucially no
      // "no such table" crash). The default-checks wrapper then synthesises a
      // single ok row for the empty result.
      expect(check.run(db)).toEqual([]);
    }
  });

  it("running DEFAULT_CHECKS against a pre-v31 DB does NOT throw 'no such table'", () => {
    // This mirrors dbRepairDryRunTool: withReadonlyDb + DEFAULT_CHECKS.flatMap,
    // WITHOUT running migrations first.
    const db = preV31Db();
    expect(() => DEFAULT_CHECKS.flatMap((check) => check.run(db))).not.toThrow();
  });

  it("runDoctor(category='review') succeeds on a pre-v31 DB and the jury checks report ok (skip)", () => {
    const db = preV31Db();
    let result!: ReturnType<typeof runDoctor>;
    expect(() => {
      result = runDoctor(db, { category: "review" });
    }).not.toThrow();
    // The jury checks must NOT be flagged (there is nothing to audit pre-v31);
    // they appear as ok rows via the empty-result wrapper.
    const juryIds = JURY_DOCTOR_CHECKS.map((c) => c.id);
    const flagged = result.findings.filter(
      (f) => juryIds.includes(f.checkId) && f.status === "flagged",
    );
    expect(flagged).toEqual([]);
    for (const id of juryIds) {
      const row = result.findings.find((f) => f.checkId === id);
      expect(row?.status).toBe("ok");
    }
  });

  it("v31-present behaviour is unchanged: the jury checks still flag genuine inconsistencies", () => {
    // Sanity: after a real v31 migration the guard is a no-op and the orphan
    // check still fires (identical behaviour to the rest of the suite).
    const db = migratedDb();
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

/**
 * FIX 3 (codex#254 ROUND-3 P3): the jury-doctor source must stay TEXT, not
 * binary. `verdictKey` previously embedded a LITERAL NUL byte (the key
 * separator), which makes `grep`/`rg` classify the .ts file as binary and hide
 * its contents from repo search ("binary file matches"). The separator NUL byte
 * is preserved at RUNTIME via the `\0` escape sequence in the template literal —
 * but the SOURCE bytes must contain NO raw NUL so the file stays searchable.
 */
describe("jury-doctor-checks source is text-searchable (FIX 3, P3)", () => {
  it("contains NO raw NUL byte (de-binary source)", () => {
    const source = readFileSync(DOCTOR_CHECKS_SOURCE, "utf8");
    // A raw NUL anywhere makes rg/grep treat the file as binary and drop it from
    // search. The runtime separator NUL must come from the `\0` ESCAPE, not a
    // literal byte in the source.
    expect(/\u0000/.test(source)).toBe(false);
  });

  it("verdictKey is findable as plain text and uses the \\0 escape separator", () => {
    const source = readFileSync(DOCTOR_CHECKS_SOURCE, "utf8");
    // A search for the sentinel function name must succeed on the text source.
    expect(source).toContain("function verdictKey(");
    // The separator is the two-char escape `\0` (backslash + zero), never a raw
    // NUL — so runtime semantics (NUL separator) are unchanged but the source
    // stays text.
    expect(source).toContain("${findingId}\\0${deliberationId}");
  });
});
