import type Database from "better-sqlite3";
import { assertFindingHitchConsistency } from "../jury-consistency.js";

/**
 * Repository for `jury_classification_refutations` (#230 deliberation
 * jury, Stage 4 adversarial refute). No foreign keys; `finding_id` is the
 * authoritative key. Insert is fail-closed: it asserts the
 * `(finding_id, hitch_id)` pair matches the stored finding (design §0.1
 * R5/P2f), then `INSERT OR IGNORE` so the business-key UNIQUE index
 * `(finding_id, target_scope, reviewer_id, prompt_sha256, deliberation_id)`
 * dedups retries (R15).
 *
 * `counterEvidence` is `VerifiedJuryEvidence[]` (verified upstream); this
 * repository only persists it.
 */

export type RefuterTargetScope = "in_scope" | "out_of_scope";
export type RefuteVerdict = "uphold" | "refute" | "inconclusive";

export interface JuryClassificationRefutationInput {
  findingId: string;
  hitchId: string;
  runId?: string;
  targetScope: RefuterTargetScope;
  refuteVerdict: RefuteVerdict;
  /** VerifiedJuryEvidence[] (already verified upstream). */
  counterEvidence?: readonly unknown[];
  reasoning?: string;
  reviewerId: string;
  model?: string;
  promptSha256: string;
  promptProvenance?: unknown;
  usageKind?: string;
  usageSeq?: number;
  auditDirPath?: string;
  deliberationId: string;
  createdAt: string;
}

export class JuryClassificationRefutationRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: JuryClassificationRefutationInput): void {
    assertFindingHitchConsistency(this.db, input.findingId, input.hitchId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jury_classification_refutations
           (finding_id, hitch_id, run_id, target_scope, refute_verdict,
            counter_evidence_json, reasoning, reviewer_id, model,
            prompt_sha256, prompt_provenance_json, usage_kind, usage_seq,
            audit_dir_path, deliberation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.findingId,
        input.hitchId,
        input.runId ?? null,
        input.targetScope,
        input.refuteVerdict,
        jsonOrNull(input.counterEvidence),
        input.reasoning ?? null,
        input.reviewerId,
        input.model ?? null,
        input.promptSha256,
        jsonOrNull(input.promptProvenance),
        input.usageKind ?? null,
        input.usageSeq ?? null,
        input.auditDirPath ?? null,
        input.deliberationId,
        input.createdAt,
      );
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
