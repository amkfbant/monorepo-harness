import type Database from "better-sqlite3";

/**
 * Repository for v32 `review_refute_votes`.
 *
 * The table is append-only and declares no foreign keys. Refute target
 * normalization/binding is owned by `core/refute-binding`; this repository
 * persists the already-verified `targetChangeHash`. The hard guard here is
 * the advisory finding binding: when `findingId` is supplied, it must exist
 * and any supplied `hitchId` must match that finding's hitch.
 */

export type ReviewRefuteVerdict = "uphold" | "refute" | "inconclusive";
export type ReviewRefuteCounterEvidenceKind = "diff" | "test" | "none";
export type ReviewRefuteValidationStatus = "passed" | "rejected";

export interface ReviewRefuteVoteInput {
  runId: string;
  hitchId?: string;
  targetChangeHash: string;
  targetChangeIdx?: number;
  findingId?: string;
  reviewerId: string;
  refuteVerdict?: ReviewRefuteVerdict;
  confidence?: number;
  reasoning?: string;
  refuteReason?: string;
  counterEvidenceKind?: ReviewRefuteCounterEvidenceKind;
  counterEvidenceRef?: string;
  refuteCondition?: string;
  retractCondition?: string;
  model?: string;
  promptSha256: string;
  promptProvenance?: unknown;
  usageKind?: string;
  usageSeq?: number;
  sourceYaml?: string;
  sourceSha256: string;
  validationStatus: ReviewRefuteValidationStatus;
  rejectReason?: string;
  createdAt: string;
}

export interface ReviewRefuteVoteRow {
  refuteId: number;
  runId: string;
  hitchId: string | null;
  targetChangeHash: string;
  targetChangeIdx: number | null;
  findingId: string | null;
  reviewerId: string;
  refuteVerdict: ReviewRefuteVerdict | null;
  confidence: number | null;
  reasoning: string | null;
  refuteReason: string | null;
  counterEvidenceKind: ReviewRefuteCounterEvidenceKind | null;
  counterEvidenceRef: string | null;
  refuteCondition: string | null;
  retractCondition: string | null;
  model: string | null;
  promptSha256: string;
  promptProvenanceJson: string | null;
  usageKind: string | null;
  usageSeq: number | null;
  sourceYaml: string;
  sourceSha256: string;
  validationStatus: ReviewRefuteValidationStatus;
  rejectReason: string | null;
  createdAt: string;
}

export interface ReviewRefuteVoteInsertResult {
  row: ReviewRefuteVoteRow;
  inserted: boolean;
}

export class ReviewRefuteVotesRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: ReviewRefuteVoteInput): ReviewRefuteVoteInsertResult {
    assertFindingBinding(this.db, input.findingId, input.hitchId);
    try {
      const info = this.db
        .prepare(
          `INSERT INTO review_refute_votes
             (run_id, hitch_id, target_change_hash, target_change_idx,
              finding_id, reviewer_id, refute_verdict, confidence, reasoning,
              refute_reason, counter_evidence_kind, counter_evidence_ref,
              refute_condition, retract_condition, model, prompt_sha256,
              prompt_provenance_json, usage_kind, usage_seq, source_yaml,
              source_sha256, validation_status, reject_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.hitchId ?? null,
          input.targetChangeHash,
          input.targetChangeIdx ?? null,
          input.findingId ?? null,
          input.reviewerId,
          input.refuteVerdict ?? null,
          input.confidence ?? null,
          input.reasoning ?? null,
          input.refuteReason ?? null,
          input.counterEvidenceKind ?? null,
          input.counterEvidenceRef ?? null,
          input.refuteCondition ?? null,
          input.retractCondition ?? null,
          input.model ?? null,
          input.promptSha256,
          jsonOrNull(input.promptProvenance),
          input.usageKind ?? null,
          input.usageSeq ?? null,
          input.sourceYaml ?? "",
          input.sourceSha256,
          input.validationStatus,
          input.rejectReason ?? null,
          input.createdAt,
        );
      return {
        row: this.requireById(Number(info.lastInsertRowid)),
        inserted: true,
      };
    } catch (e) {
      if (isUniqueConstraint(e)) {
        const existing = this.findDuplicate(input);
        if (existing !== null) return { row: existing, inserted: false };
      }
      throw e;
    }
  }

  listByRun(runId: string): ReviewRefuteVoteRow[] {
    const rows = this.db
      .prepare(
        `SELECT *
           FROM review_refute_votes
          WHERE run_id = ?
          ORDER BY created_at ASC, refute_id ASC`,
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map(toRow);
  }

  listByTarget(runId: string, targetChangeHash: string): ReviewRefuteVoteRow[] {
    const rows = this.db
      .prepare(
        `SELECT *
           FROM review_refute_votes
          WHERE run_id = ? AND target_change_hash = ?
          ORDER BY created_at ASC, refute_id ASC`,
      )
      .all(runId, targetChangeHash) as Record<string, unknown>[];
    return rows.map(toRow);
  }

  private requireById(refuteId: number): ReviewRefuteVoteRow {
    const row = this.db
      .prepare("SELECT * FROM review_refute_votes WHERE refute_id = ?")
      .get(refuteId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new Error(`review_refute_votes row ${refuteId} not found`);
    }
    return toRow(row);
  }

  private findDuplicate(
    input: ReviewRefuteVoteInput,
  ): ReviewRefuteVoteRow | null {
    const row = findDuplicateRow(this.db, input);
    return row === undefined ? null : toRow(row);
  }
}

function findDuplicateRow(
  db: Database.Database,
  input: ReviewRefuteVoteInput,
): Record<string, unknown> | undefined {
  if (input.validationStatus === "rejected") {
    return db
      .prepare(
        `SELECT *
           FROM review_refute_votes
          WHERE run_id = ?
            AND target_change_hash = ?
            AND reviewer_id = ?
            AND prompt_sha256 = ?
            AND source_sha256 = ?
            AND validation_status = 'rejected'
          ORDER BY refute_id ASC
          LIMIT 1`,
      )
      .get(
        input.runId,
        input.targetChangeHash,
        input.reviewerId,
        input.promptSha256,
        input.sourceSha256,
      ) as Record<string, unknown> | undefined;
  }

  if (input.refuteVerdict === "inconclusive") {
    return db
      .prepare(
        `SELECT *
           FROM review_refute_votes
          WHERE run_id = ?
            AND target_change_hash = ?
            AND reviewer_id = ?
            AND prompt_sha256 = ?
            AND validation_status = 'passed'
            AND refute_verdict = 'inconclusive'
          ORDER BY refute_id ASC
          LIMIT 1`,
      )
      .get(
        input.runId,
        input.targetChangeHash,
        input.reviewerId,
        input.promptSha256,
      ) as Record<string, unknown> | undefined;
  }

  if (input.refuteVerdict === "uphold" || input.refuteVerdict === "refute") {
    return db
      .prepare(
        `SELECT *
           FROM review_refute_votes
          WHERE run_id = ?
            AND target_change_hash = ?
            AND reviewer_id = ?
            AND prompt_sha256 = ?
            AND validation_status = 'passed'
            AND refute_verdict IN ('uphold','refute')
          ORDER BY refute_id ASC
          LIMIT 1`,
      )
      .get(
        input.runId,
        input.targetChangeHash,
        input.reviewerId,
        input.promptSha256,
      ) as Record<string, unknown> | undefined;
  }

  return undefined;
}

function assertFindingBinding(
  db: Database.Database,
  findingId: string | undefined,
  hitchId: string | undefined,
): void {
  if (findingId === undefined) return;
  const row = db
    .prepare("SELECT hitch_id FROM hitch_findings WHERE finding_id = ?")
    .get(findingId) as { hitch_id: string } | undefined;
  if (row === undefined) {
    throw new Error(
      `review_refute_votes insert: finding_id ${findingId} not found ` +
        `(fail-closed)`,
    );
  }
  if (hitchId !== undefined && row.hitch_id !== hitchId) {
    throw new Error(
      `review_refute_votes insert: hitch_id mismatch for finding ` +
        `${findingId}: stored=${row.hitch_id} given=${hitchId}`,
    );
  }
}

function isUniqueConstraint(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function toRow(r: Record<string, unknown>): ReviewRefuteVoteRow {
  return {
    refuteId: r.refute_id as number,
    runId: r.run_id as string,
    hitchId: (r.hitch_id as string | null) ?? null,
    targetChangeHash: r.target_change_hash as string,
    targetChangeIdx: (r.target_change_idx as number | null) ?? null,
    findingId: (r.finding_id as string | null) ?? null,
    reviewerId: r.reviewer_id as string,
    refuteVerdict: (r.refute_verdict as ReviewRefuteVerdict | null) ?? null,
    confidence: (r.confidence as number | null) ?? null,
    reasoning: (r.reasoning as string | null) ?? null,
    refuteReason: (r.refute_reason as string | null) ?? null,
    counterEvidenceKind:
      (r.counter_evidence_kind as ReviewRefuteCounterEvidenceKind | null) ??
      null,
    counterEvidenceRef: (r.counter_evidence_ref as string | null) ?? null,
    refuteCondition: (r.refute_condition as string | null) ?? null,
    retractCondition: (r.retract_condition as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    promptSha256: r.prompt_sha256 as string,
    promptProvenanceJson: (r.prompt_provenance_json as string | null) ?? null,
    usageKind: (r.usage_kind as string | null) ?? null,
    usageSeq: (r.usage_seq as number | null) ?? null,
    sourceYaml: r.source_yaml as string,
    sourceSha256: r.source_sha256 as string,
    validationStatus: r.validation_status as ReviewRefuteValidationStatus,
    rejectReason: (r.reject_reason as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}
