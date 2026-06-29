// (#396 part 2) Deterministic decision for a failed close-PR `git push`: does a
// close-ready hitch bound-retry (recheck), terminal-escalate, or rethrow to the
// orchestrator's existing fail-closed handling? This is the ONLY place the close
// path deviates from "any throw escalates" — and it does so only for a narrow,
// classified, budget-bounded transient `PrPushError`.
//
// Fail-closed ordering (each step defaults toward escalate/rethrow on doubt):
//   1. abort / lease-loss → rethrow (the orchestrator maps it to the abort/lease
//      cause, never to escalate; see invariant in docs/specs/hitch-convergence.md).
//   2. narrow type gate → only a `PrPushError` (the git-push exit-code site) is a
//      retry candidate; every other PrGateError (safety gates, publish, adopted /
//      not-ready) rethrows → existing terminal escalate.
//   3. deterministic classify → permanent (default for unknown) escalates.
//   4. bounded run-scoped budget → transient under budget rechecks; over budget
//      escalates.

import { findTransientLeaseCause } from "../workspace/db-domain-lock.js";
import { PrPushError } from "../core/pr-creator.js";
import { classifyPushFailure } from "../core/push-failure-classifier.js";
import { withManagedDb } from "../db/managed-connection.js";
import { HitchRepository } from "./repository.js";

/** Max transient close-push retries per close episode before escalating. */
export const MAX_CLOSE_PUSH_ATTEMPTS = 5;

export type ClosePushOutcome =
  | { kind: "recheck"; summary: string }
  | { kind: "escalate"; reason: string }
  | { kind: "rethrow" };

/**
 * Classify a close-PR push failure and, for a transient one, record an attempt
 * against the converged `runId`'s budget. Returns the deterministic decision; the
 * caller (closeAndPr runner) performs the status write / escalate-return / rethrow.
 * The increment runs ONLY for a transient `PrPushError` (permanent classification
 * dominates and never touches the counter).
 */
export function classifyAndRecordClosePushFailure(
  deps: { dbPath: string },
  hitchId: string,
  runId: string,
  error: unknown,
  signalAborted: boolean,
): ClosePushOutcome {
  // 1. abort / lease loss beats everything — never reclassify as retry/escalate.
  if (signalAborted) return { kind: "rethrow" };
  if (findTransientLeaseCause(error) !== undefined) return { kind: "rethrow" };
  // 2. only the git-push site is a retry candidate; gates / publish / adopted /
  //    not-ready (plain PrGateError or other) escalate via the existing catch.
  if (!(error instanceof PrPushError)) return { kind: "rethrow" };
  // 3. deterministic classification (fail-closed permanent default).
  if (classifyPushFailure(`${error.stderr}\n${error.stdout}`) !== "transient") {
    return {
      kind: "escalate",
      reason: `close PR push failed (permanent): ${error.message}`,
    };
  }
  // 4. transient under a bounded, run-scoped budget.
  const attempts = withManagedDb({ dbPath: deps.dbPath }, (db) =>
    new HitchRepository(db).incrementClosePushAttempts(hitchId, runId),
  );
  if (attempts > MAX_CLOSE_PUSH_ATTEMPTS) {
    return {
      kind: "escalate",
      reason:
        `close PR push failed transiently ${attempts - 1}× then exhausted the ` +
        `${MAX_CLOSE_PUSH_ATTEMPTS}-retry budget; escalating: ${error.message}`,
    };
  }
  return {
    kind: "recheck",
    summary:
      `close PR push failed transiently (attempt ${attempts}/${MAX_CLOSE_PUSH_ATTEMPTS}) ` +
      `— re-run hitch orchestrate to retry`,
  };
}
