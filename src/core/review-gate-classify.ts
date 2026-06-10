import type { ReviewGateKind } from "./reviewer-agent-errors.js";

/**
 * Classification of why a run cannot be auto-reviewed, disambiguating two
 * states that previously shared the opaque "review-decision.yaml not found;
 * the run may not have completed normally" message (#77):
 *
 *   - `already_decided` — the run was already reviewed; re-orchestrating it is
 *     a no-op. With file export OFF the `review-decision.yaml` sidecar is
 *     deleted after a non-pending decision, so a missing file does NOT imply
 *     an incomplete run when the DB holds the verdict.
 *   - `run_incomplete`  — the run genuinely did not finish: status is still
 *     `needs_review`, no decision file, and no recorded decision in the DB.
 *     This is the recoverable case (recover the workspace and re-run).
 *
 * This is a pure function over already-resolved inputs so it can be unit
 * tested without a run directory or DB; the caller resolves
 * `decisionFileExists` / `recordedDecision` deterministically.
 */
export type ReviewGateClassification =
  | { kind: "ok" }
  | { kind: ReviewGateKind; message: string };

export function classifyReviewGate(opts: {
  runId: string;
  status: string;
  decisionFileExists: boolean;
  recordedDecision: string | null;
}): ReviewGateClassification {
  if (opts.status !== "needs_review") {
    return {
      kind: "already_decided",
      message:
        `run ${opts.runId} is already "${opts.status}", not needs_review — it ` +
        `has already been reviewed. No re-review is needed; re-orchestrating an ` +
        `already-decided run is a no-op.`,
    };
  }
  if (!opts.decisionFileExists) {
    if (opts.recordedDecision !== null) {
      return {
        kind: "already_decided",
        message:
          `run ${opts.runId} was already reviewed ` +
          `(decision="${opts.recordedDecision}") — its review-decision.yaml ` +
          `sidecar is absent because file export is OFF. No re-review is needed.`,
      };
    }
    return {
      kind: "run_incomplete",
      message:
        `run ${opts.runId} is incomplete: review-decision.yaml not found and no ` +
        `recorded review in the DB. The run may not have completed normally — ` +
        `recover the workspace (commit/push the reviewed diff) and re-run.`,
    };
  }
  return { kind: "ok" };
}
