import type Database from "better-sqlite3";
import { HitchRepository } from "./repository.js";
import type {
  HitchAttempt,
  HitchAttemptStatus,
  HitchAttemptType,
} from "./types.js";

export interface RecordGoalAttemptForOperationInput {
  hitchId: string;
  attemptType: HitchAttemptType;
  operationId: string;
  runId: string;
  iteration?: number;
  runStatus?: string;
  parentAttemptId?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorMessage?: string;
}

export function recordGoalAttemptForOperationResult(
  db: Database.Database,
  input: RecordGoalAttemptForOperationInput,
): HitchAttempt {
  const repo = new HitchRepository(db);
  repo.requireSession(input.hitchId);
  const attempt = repo.createAttempt({
    hitchId: input.hitchId,
    attemptType: input.attemptType,
    ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
    operationId: input.operationId,
    runId: input.runId,
    ...(input.parentAttemptId !== undefined
      ? { parentAttemptId: input.parentAttemptId }
      : {}),
    input: input.input ?? {},
  });
  return repo.completeAttempt({
    attemptId: attempt.attemptId,
    status: goalAttemptStatusForRun(input.runStatus, input.errorMessage),
    operationId: input.operationId,
    runId: input.runId,
    result: input.result ?? {},
    ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
  });
}

export function latestGoalAttemptForRun(
  db: Database.Database,
  hitchId: string,
  runId: string,
): HitchAttempt | null {
  const row = db
    .prepare(
      `SELECT attempt_id
         FROM hitch_attempts
        WHERE hitch_id = ? AND run_id = ?
        ORDER BY iteration DESC, created_at DESC, attempt_id DESC
        LIMIT 1`,
    )
    .get(hitchId, runId) as { attempt_id: string } | undefined;
  if (row === undefined) return null;
  return new HitchRepository(db).requireAttempt(row.attempt_id);
}

function goalAttemptStatusForRun(
  runStatus: string | undefined,
  errorMessage: string | undefined,
): Exclude<HitchAttemptStatus, "pending" | "running"> {
  if (errorMessage !== undefined) return "failed";
  if (runStatus === undefined) return "succeeded";
  if (runStatus === "cancelled") return "cancelled";
  return runStatus.startsWith("failed") ? "failed" : "succeeded";
}
