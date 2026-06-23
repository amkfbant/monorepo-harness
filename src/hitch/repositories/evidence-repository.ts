import type Database from "better-sqlite3";
import type {
  EvidenceAttester,
  HitchEvidence,
  HitchEvidenceKind,
} from "../types.js";
import { json } from "./shared.js";

/**
 * #91 Stage A — composition-delegation repository for the `hitch_evidence`
 * table. Holds the facade's `db` handle; opens NO transaction of its own so
 * its writes compose inside any transaction the caller already opened.
 *
 * Methods:
 *   - `insertEvidence` — raw INSERT; serializes `summaryMetrics` to JSON and
 *     booleans to 0/1.
 *   - `listEvidence(hitchId)` — ordered by `created_at ASC, evidence_id ASC`
 *     for stability; deserializes on read.
 *   - `getEvidence(evidenceId)` — single-row lookup; null for unknown id.
 *
 * Read `docs/specs/db.md` and `src/db/schema.ts` MIGRATION_V39_STATEMENTS
 * before modifying the column set.
 */

interface HitchEvidenceRow {
  evidence_id: string;
  hitch_id: string;
  run_id: string | null;
  condition_id: string | null;
  kind: HitchEvidenceKind;
  attester: EvidenceAttester;
  label: string;
  command: string | null;
  exit_code: number | null;
  summary_metrics_json: string;
  metrics_schema: number;
  output_excerpt: string | null;
  secret_suspect: number;
  redacted: number;
  created_at: string;
}

function rowToEvidence(row: HitchEvidenceRow): HitchEvidence {
  const parsed = JSON.parse(row.summary_metrics_json) as unknown;
  const summaryMetrics =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    evidenceId: row.evidence_id,
    hitchId: row.hitch_id,
    runId: row.run_id,
    conditionId: row.condition_id,
    kind: row.kind,
    attester: row.attester,
    label: row.label,
    command: row.command,
    exitCode: row.exit_code,
    summaryMetrics,
    metricsSchema: row.metrics_schema,
    outputExcerpt: row.output_excerpt,
    secretSuspect: row.secret_suspect !== 0,
    redacted: row.redacted !== 0,
    createdAt: row.created_at,
  };
}

export class EvidenceRepository {
  constructor(private readonly db: Database.Database) {}

  insertEvidence(row: HitchEvidence): void {
    this.db
      .prepare(
        `INSERT INTO hitch_evidence (
           evidence_id, hitch_id, run_id, condition_id, kind, attester,
           label, command, exit_code, summary_metrics_json,
           metrics_schema, output_excerpt, secret_suspect, redacted, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.evidenceId,
        row.hitchId,
        row.runId,
        row.conditionId,
        row.kind,
        row.attester,
        row.label,
        row.command,
        row.exitCode,
        json(row.summaryMetrics),
        row.metricsSchema,
        row.outputExcerpt,
        row.secretSuspect ? 1 : 0,
        row.redacted ? 1 : 0,
        row.createdAt,
      );
  }

  listEvidence(hitchId: string): HitchEvidence[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_evidence
          WHERE hitch_id = ?
          ORDER BY created_at ASC, evidence_id ASC`,
      )
      .all(hitchId) as HitchEvidenceRow[];
    return rows.map(rowToEvidence);
  }

  getEvidence(evidenceId: string): HitchEvidence | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_evidence WHERE evidence_id = ?")
      .get(evidenceId) as HitchEvidenceRow | undefined;
    return row === undefined ? null : rowToEvidence(row);
  }
}
