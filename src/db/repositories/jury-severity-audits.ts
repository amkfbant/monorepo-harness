import type Database from "better-sqlite3";
import { assertFindingHitchConsistency } from "../jury-consistency.js";

/**
 * Repository for `jury_severity_audits` (#230 deliberation jury, advisory
 * severity audit votes + verdict). No foreign keys; `finding_id` is the
 * authoritative key. Insert is fail-closed: it asserts the
 * `(finding_id, hitch_id)` pair matches the stored finding (design §0.1
 * R5/P2f), then `INSERT OR IGNORE` so the business-key UNIQUE index
 * `(finding_id, prompt_sha256, deliberation_id)` dedups retries (R15).
 *
 * The severity audit is advisory only — it never drives a state
 * transition on `hitch_findings.severity`; it is persisted for audit.
 */

export type HitchFindingSeverity = "P0" | "P1" | "P2" | "P3" | "info";
export type SeverityAuditStatus = "aligned" | "diverged" | "inconclusive";

export interface JurySeverityAuditInput {
  findingId: string;
  hitchId: string;
  runId?: string;
  harnessSeverity: HitchFindingSeverity;
  jurySeverity?: HitchFindingSeverity;
  auditStatus: SeverityAuditStatus;
  escalateFlag: boolean;
  reasoning?: string;
  model?: string;
  promptSha256: string;
  usageKind?: string;
  usageSeq?: number;
  /** [{lens, proposedSeverity, reasoning, round}] */
  juryVotes: readonly unknown[];
  deliberationId: string;
  createdAt: string;
}

export class JurySeverityAuditRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: JurySeverityAuditInput): void {
    assertFindingHitchConsistency(this.db, input.findingId, input.hitchId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jury_severity_audits
           (finding_id, hitch_id, run_id, harness_severity, jury_severity,
            audit_status, escalate_flag, reasoning, model, prompt_sha256,
            usage_kind, usage_seq, jury_votes_json, deliberation_id,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.findingId,
        input.hitchId,
        input.runId ?? null,
        input.harnessSeverity,
        input.jurySeverity ?? null,
        input.auditStatus,
        input.escalateFlag ? 1 : 0,
        input.reasoning ?? null,
        input.model ?? null,
        input.promptSha256,
        input.usageKind ?? null,
        input.usageSeq ?? null,
        JSON.stringify(input.juryVotes),
        input.deliberationId,
        input.createdAt,
      );
  }
}
