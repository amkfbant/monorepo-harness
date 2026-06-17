import type Database from "better-sqlite3";
import type { DoctorCheck, DoctorFinding } from "./doctor.js";

/**
 * Doctor checks for v32 `review_refute_votes`.
 *
 * The table has no foreign keys by design. `finding_id` is the authoritative
 * parent binding when present, while `hitch_id` is advisory denormalized
 * provenance. These checks report post-hoc drift left by parent purge or manual
 * DB edits; they never repair rows automatically.
 */

const REVIEW_REFUTE_VOTE_TABLES = [
  "review_refute_votes",
  "hitch_findings",
] as const;

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  return row !== undefined;
}

function guardOnTables(
  required: readonly string[],
  run: DoctorCheck["run"],
): DoctorCheck["run"] {
  return (db) => {
    for (const table of required) {
      if (!tableExists(db, table)) return [];
    }
    return run(db);
  };
}

export const reviewRefuteVotesOrphanRowsCheck: DoctorCheck = {
  id: "review_refute_votes.orphan_rows",
  category: "review",
  severity: "warn",
  description:
    "review_refute_votes row references a finding that no longer exists",
  run: guardOnTables(REVIEW_REFUTE_VOTE_TABLES, (db) => {
    const rows = db
      .prepare(
        `SELECT v.refute_id, v.run_id, v.finding_id, v.hitch_id
           FROM review_refute_votes v
          WHERE v.finding_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM hitch_findings f
               WHERE f.finding_id = v.finding_id
            )
          LIMIT 50`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      checkId: "review_refute_votes.orphan_rows",
      severity: "warn" as const,
      status: "flagged" as const,
      message:
        `review_refute_votes row ${r.refute_id} references missing finding ` +
        `${r.finding_id} (orphan; advisory)`,
      repairable: false,
      details: {
        refuteId: r.refute_id,
        runId: r.run_id,
        findingId: r.finding_id,
        hitchId: r.hitch_id,
      },
    }));
  }),
};

export const reviewRefuteVotesHitchMismatchCheck: DoctorCheck = {
  id: "review_refute_votes.hitch_mismatch",
  category: "review",
  severity: "warn",
  description:
    "review_refute_votes stored hitch_id disagrees with hitch_findings join",
  run: guardOnTables(REVIEW_REFUTE_VOTE_TABLES, (db) => {
    const rows = db
      .prepare(
        `SELECT v.refute_id, v.run_id, v.finding_id,
                v.hitch_id AS stored_hitch_id,
                f.hitch_id AS join_hitch_id
           FROM review_refute_votes v
           JOIN hitch_findings f ON f.finding_id = v.finding_id
          WHERE v.hitch_id IS NOT NULL
            AND v.hitch_id != f.hitch_id
          LIMIT 50`,
      )
      .all() as Record<string, unknown>[];
    const out: DoctorFinding[] = [];
    for (const r of rows) {
      out.push({
        checkId: "review_refute_votes.hitch_mismatch",
        severity: "warn",
        status: "flagged",
        message:
          `review_refute_votes row ${r.refute_id} (finding ${r.finding_id}) ` +
          `stored hitch_id=${r.stored_hitch_id} but join=${r.join_hitch_id}`,
        repairable: false,
        details: {
          refuteId: r.refute_id,
          runId: r.run_id,
          findingId: r.finding_id,
          storedHitchId: r.stored_hitch_id,
          joinHitchId: r.join_hitch_id,
        },
      });
    }
    return out;
  }),
};

export const REVIEW_REFUTE_VOTE_DOCTOR_CHECKS: readonly DoctorCheck[] = [
  reviewRefuteVotesOrphanRowsCheck,
  reviewRefuteVotesHitchMismatchCheck,
];

export { REVIEW_REFUTE_VOTE_TABLES };
