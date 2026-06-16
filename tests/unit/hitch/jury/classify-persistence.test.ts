import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../../src/db/migrations.js";
import { persistAuditRows } from "../../../../src/hitch/jury/classify-persistence.js";
import { auditSeverity } from "../../../../src/hitch/jury/severity-audit.js";
import type { DeliberationOutcome } from "../../../../src/hitch/jury/deliberate.js";
import type {
  JuryClassificationProposal,
  JuryLens,
} from "../../../../src/hitch/jury/types.js";
import type { HitchFindingSeverity } from "../../../../src/hitch/types.js";

/**
 * FIX 4 (cross-cutting P2): jury_severity_audits.jury_votes_json MUST be the
 * SAME vote set the persisted verdict (audit_status / jury_severity) was
 * computed over — the FINAL-round votes (selectFinalRound), NOT every round.
 *
 * deliberate.buildSeverityAudit computes severityAudit from the final-round
 * votes, while persistAuditRows previously wrote jury_votes_json from ALL
 * proposals (R1+R2). When critique ran and the R1/R2 severity votes differ the
 * persisted audit votes contradicted the persisted verdict.
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
     VALUES (?, ?, ?, 'review', 'P2', 'core', 'unknown', 'open',
             'a finding', 'src/a.ts', ?, ?)`,
  ).run(findingId, hitchId, `key-${findingId}`, NOW, NOW);
}

const v = () =>
  ({ citation: "src/a.ts:1", kind: "file" as const, claim: "c", verified: true });

function proposal(
  lens: JuryLens,
  round: 1 | 2,
  severity: HitchFindingSeverity,
): JuryClassificationProposal {
  return {
    findingId: "f1",
    lens,
    proposedScope: "in_scope",
    proposalStatus: "complete",
    evidence: [v()],
    round,
    proposedSeverity: severity,
  };
}

describe("persistAuditRows — jury_votes_json reflects the verdict basis (FIX 4)", () => {
  it("when critique ran and R1/R2 severities differ, jury_votes_json carries the FINAL-round votes (matching the verdict)", () => {
    const db = migratedDb();
    seedHitch(db, "h1");
    seedFinding(db, "h1", "f1");

    // R1: all three lenses vote P1 severity. R2 (final, post-critique): all
    // three vote P0. The harness severity is P2, so the FINAL-round audit
    // diverges to P0. If jury_votes_json (wrongly) included R1+R2, it would
    // carry P1 votes that contradict the P0 verdict.
    const r1: JuryClassificationProposal[] = [
      proposal("correctness", 1, "P1"),
      proposal("scope_fit", 1, "P1"),
      proposal("spec_adherence", 1, "P1"),
    ];
    const r2: JuryClassificationProposal[] = [
      proposal("correctness", 2, "P0"),
      proposal("scope_fit", 2, "P0"),
      proposal("spec_adherence", 2, "P0"),
    ];
    const finalRound = r2;
    const severityAudit = auditSeverity({
      harnessSeverity: "P2",
      juryVotes: finalRound.map((p) => ({
        lens: p.lens,
        juryProposedSeverity: p.proposedSeverity as HitchFindingSeverity,
      })),
      finding: { findingId: "f1", summary: "a finding" },
    });
    // sanity: the verdict basis is the final round -> jury consensus P0.
    expect(severityAudit.juryConsensus).toBe("P0");
    expect(severityAudit.status).toBe("diverged");

    const outcome: DeliberationOutcome = {
      deliberationId: "d1",
      proposals: [...r1, ...r2],
      refutation: null,
      severityAudit,
      result: {
        decision: "escalate",
        reason: "irrelevant",
        gateTrace: {
          scopeUnanimous: false,
          lensDistinct: false,
          noInconclusive: false,
          allHaveVerifiedEvidence: false,
          proximityOk: false,
          refuterUpheld: null,
        },
      },
      critiqueRan: true,
    };

    persistAuditRows(
      db,
      { findingId: "f1", hitchId: "h1", harnessSeverity: "P2" },
      outcome,
      null,
    );

    const row = db
      .prepare(
        `SELECT jury_votes_json, jury_severity, audit_status
           FROM jury_severity_audits WHERE finding_id = 'f1'`,
      )
      .get() as {
      jury_votes_json: string;
      jury_severity: string | null;
      audit_status: string;
    };
    const votes = JSON.parse(row.jury_votes_json) as {
      proposedSeverity: string;
      round: number;
    }[];

    // The persisted verdict basis is the final round (P0). The persisted votes
    // MUST match that basis: every vote is from the final round and is P0.
    expect(row.jury_severity).toBe("P0");
    expect(row.audit_status).toBe("diverged");
    expect(votes).toHaveLength(3);
    expect(votes.every((x) => x.round === 2)).toBe(true);
    expect(votes.every((x) => x.proposedSeverity === "P0")).toBe(true);
    // no stale round-1 (P1) vote leaked in.
    expect(votes.some((x) => x.proposedSeverity === "P1")).toBe(false);
  });
});
