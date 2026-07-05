import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DbError } from "../../db/connection.js";
import type {
  HitchCloseCheck,
  HitchCloseCheckStatus,
  HitchCloseConditionKind,
} from "../types.js";
import {
  json,
  parseRecord,
  requireHitchSession,
  touchHitchSession,
} from "./shared.js";

/**
 * #125 Track C (C2) — the close-check concern extracted from the frozen
 * `HitchRepository` by composition delegation. Records the
 * `hitch_close_checks` evidence rows the close gate evaluates.
 *
 * Holds the FACADE's `db` handle and NO transaction of its own, so
 * `recordCloseCheck` composes inside the caller's transaction when one is open
 * (e.g. the atomic review import's single BEGIN). Behaviour-identical to the
 * former `HitchRepository.recordCloseCheck` / `getCloseCheck` /
 * `requireCloseCheck` / `listCloseChecks`.
 */
export interface RecordHitchCloseCheckInput {
  checkId?: string;
  hitchId: string;
  conditionId: string;
  status: HitchCloseCheckStatus;
  checkedAt?: string;
  checkedBy: string;
  evidence?: Record<string, unknown>;
  message?: string;
  recordingMode?: "manual" | "deterministic";
}

interface HitchCloseCheckRow {
  check_id: string;
  hitch_id: string;
  condition_id: string;
  status: HitchCloseCheckStatus;
  checked_at: string;
  checked_by: string;
  evidence_json: string;
  message: string | null;
}

export class CloseCheckRepository {
  constructor(private readonly db: Database.Database) {}

  recordCloseCheck(input: RecordHitchCloseCheckInput): HitchCloseCheck {
    assertCloseCheckRecordable(this.db, input);
    const checkedAt = input.checkedAt ?? new Date().toISOString();
    const checkId = input.checkId ?? `check-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO hitch_close_checks (
           check_id, hitch_id, condition_id, status, checked_at, checked_by,
           evidence_json, message
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkId,
        input.hitchId,
        input.conditionId,
        input.status,
        checkedAt,
        input.checkedBy,
        json(input.evidence ?? {}),
        input.message ?? null,
      );
    touchHitchSession(this.db, input.hitchId, checkedAt);
    return this.requireCloseCheck(checkId);
  }

  getCloseCheck(checkId: string): HitchCloseCheck | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_close_checks WHERE check_id = ?")
      .get(checkId) as HitchCloseCheckRow | undefined;
    return row === undefined ? null : rowToCloseCheck(row);
  }

  requireCloseCheck(checkId: string): HitchCloseCheck {
    const check = this.getCloseCheck(checkId);
    if (check === null) throw new DbError(`hitch close check not found: ${checkId}`);
    return check;
  }

  listCloseChecks(hitchId: string): HitchCloseCheck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_close_checks
          WHERE hitch_id = ?
          ORDER BY checked_at ASC, check_id ASC`,
      )
      .all(hitchId) as HitchCloseCheckRow[];
    return rows.map(rowToCloseCheck);
  }
}

const MANUALLY_RECORDABLE_CLOSE_CONDITION_KINDS =
  new Set<HitchCloseConditionKind>([
    "command",
    "manual",
    "operation_status",
    "db_doctor",
    "artifact_exists",
  ]);

function assertCloseCheckRecordable(
  db: Database.Database,
  input: RecordHitchCloseCheckInput,
): void {
  const session = requireHitchSession(db, input.hitchId);
  const condition = session.closeConditions.find(
    (candidate) => candidate.id === input.conditionId,
  );
  if (condition === undefined) {
    throw new DbError(
      `hitch close condition not declared: ${input.conditionId}`,
    );
  }
  if (
    (input.recordingMode ?? "manual") === "manual" &&
    !MANUALLY_RECORDABLE_CLOSE_CONDITION_KINDS.has(condition.kind)
  ) {
    throw new DbError(
      `close condition ${condition.id} kind=${condition.kind} cannot be ` +
        `recorded manually; use its deterministic evaluator. ` +
        manualRecordGuidance(input.hitchId, condition.id, condition.kind),
    );
  }
}

function manualRecordGuidance(
  hitchId: string,
  conditionId: string,
  kind: HitchCloseConditionKind,
): string {
  if (kind === "review_consensus") {
    return (
      `Next: run harness hitch orchestrate ${hitchId} --repo <path> to refresh ` +
      `review consensus, or attach accepted Codex review evidence with ` +
      `harness hitch evidence add ${hitchId} --condition ${conditionId} ` +
      `--kind transcript --label "Codex review" --output-file <path>.`
    );
  }
  if (kind === "evidence_attached") {
    return (
      `Next: attach condition-scoped evidence with harness hitch evidence add ` +
      `${hitchId} --condition ${conditionId} --label <text> ` +
      `(--command <text> | --output-file <path> | --metric k=v).`
    );
  }
  if (kind === "finding_policy") {
    return (
      `Next: resolve/classify the relevant findings, then run ` +
      `harness hitch check-convergence ${hitchId}.`
    );
  }
  if (kind === "facet_red_test") {
    return (
      `Next: provide the required RED-test evidence through the normal ` +
      `hitch flow, then run harness hitch check-convergence ${hitchId}.`
    );
  }
  return `Next: run harness hitch check-convergence ${hitchId}.`;
}

function rowToCloseCheck(row: HitchCloseCheckRow): HitchCloseCheck {
  return {
    checkId: row.check_id,
    hitchId: row.hitch_id,
    conditionId: row.condition_id,
    status: row.status,
    checkedAt: row.checked_at,
    checkedBy: row.checked_by,
    evidence: parseRecord(row.evidence_json),
    message: row.message,
  };
}
