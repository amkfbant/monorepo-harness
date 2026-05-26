import type Database from "better-sqlite3";
import { GoalRepository } from "./repository.js";
import type {
  GoalAttempt,
  GoalAttemptStatus,
  GoalAttemptType,
} from "./types.js";

export interface RecordGoalAttemptForOperationInput {
  goalId: string;
  attemptType: GoalAttemptType;
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
): GoalAttempt {
  const repo = new GoalRepository(db);
  repo.requireSession(input.goalId);
  const attempt = repo.createAttempt({
    goalId: input.goalId,
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
  goalId: string,
  runId: string,
): GoalAttempt | null {
  const row = db
    .prepare(
      `SELECT attempt_id
         FROM goal_attempts
        WHERE goal_id = ? AND run_id = ?
        ORDER BY iteration DESC, created_at DESC, attempt_id DESC
        LIMIT 1`,
    )
    .get(goalId, runId) as { attempt_id: string } | undefined;
  if (row === undefined) return null;
  return new GoalRepository(db).requireAttempt(row.attempt_id);
}

function goalAttemptStatusForRun(
  runStatus: string | undefined,
  errorMessage: string | undefined,
): Exclude<GoalAttemptStatus, "pending" | "running"> {
  if (errorMessage !== undefined) return "failed";
  if (runStatus === undefined) return "succeeded";
  if (runStatus === "cancelled") return "cancelled";
  return runStatus.startsWith("failed") ? "failed" : "succeeded";
}
