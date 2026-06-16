import type Database from "better-sqlite3";
import { assertFindingHitchConsistency } from "../jury-consistency.js";

/**
 * Repository for `jury_classification_proposals` (#230 deliberation jury,
 * Stage 1 propose / Stage 3 post-critique re-vote). The table has no
 * foreign keys; `finding_id` is the authoritative key. Insert is
 * fail-closed: it first asserts the `(finding_id, hitch_id)` pair matches
 * the stored finding (design §0.1 R5/P2f), then `INSERT OR IGNORE` so the
 * business-key UNIQUE index
 * `(finding_id, lens, reviewer_id, round, prompt_sha256, deliberation_id)`
 * silently dedups retries (R15).
 *
 * Per design §0.1 R1 the `evidence` stored here is already
 * `VerifiedJuryEvidence` (it passed through `verifyEvidence` upstream in
 * Layer 1/2). This repository only persists it — it does not verify.
 */

export type JuryLens = "correctness" | "scope_fit" | "spec_adherence";
export type JuryProposedScope = "in_scope" | "out_of_scope" | "unknown";
export type JuryProposalStatus =
  | "complete"
  | "timeout"
  | "parse_error"
  | "inconclusive";

export interface JuryClassificationProposalInput {
  findingId: string;
  hitchId: string;
  runId?: string;
  lens: JuryLens;
  reviewerId: string;
  proposedScope: JuryProposedScope;
  proposalStatus: JuryProposalStatus;
  confidence?: number;
  reasoning?: string;
  model?: string;
  promptSha256: string;
  promptProvenance?: unknown;
  usageKind?: string;
  usageSeq?: number;
  auditDirPath?: string;
  round: 1 | 2;
  /** VerifiedJuryEvidence[] (already verified upstream). */
  evidence: readonly unknown[];
  refutationCondition?: string;
  uncertainty?: string;
  /** R2 only. */
  voteChanged?: boolean;
  /** R2 only — critique objections raised against other lenses. */
  critique?: readonly unknown[];
  deliberationId: string;
  createdAt: string;
}

export class JuryClassificationProposalRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: JuryClassificationProposalInput): void {
    assertFindingHitchConsistency(this.db, input.findingId, input.hitchId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jury_classification_proposals
           (finding_id, hitch_id, run_id, lens, reviewer_id,
            proposed_scope, proposal_status, confidence, reasoning, model,
            prompt_sha256, prompt_provenance_json, usage_kind, usage_seq,
            audit_dir_path, round, evidence_json, refutation_condition,
            uncertainty, vote_changed, critique_json, deliberation_id,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?)`,
      )
      .run(
        input.findingId,
        input.hitchId,
        input.runId ?? null,
        input.lens,
        input.reviewerId,
        input.proposedScope,
        input.proposalStatus,
        input.confidence ?? null,
        input.reasoning ?? null,
        input.model ?? null,
        input.promptSha256,
        jsonOrNull(input.promptProvenance),
        input.usageKind ?? null,
        input.usageSeq ?? null,
        input.auditDirPath ?? null,
        input.round,
        JSON.stringify(input.evidence),
        input.refutationCondition ?? null,
        input.uncertainty ?? null,
        boolOrNull(input.voteChanged),
        jsonOrNull(input.critique),
        input.deliberationId,
        input.createdAt,
      );
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function boolOrNull(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}
