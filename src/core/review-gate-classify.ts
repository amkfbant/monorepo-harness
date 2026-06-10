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
 *   - `run_incomplete`  — the run is not in a reviewable state. Either it is
 *     still `needs_review` with no decision file and no recorded DB decision
 *     (the run did not finish), or it is in-flight / failed (e.g. `running`,
 *     `failed-codex`) and so has no verdict yet. Both are recoverable: wait for
 *     `needs_review`, or recover the workspace and re-run.
 *
 * This is a pure function over already-resolved inputs so it can be unit
 * tested without a run directory or DB; the caller resolves
 * `decisionFileExists` / `recordedDecision` deterministically.
 */
export type ReviewGateClassification =
  | { kind: "ok" }
  | { kind: ReviewGateKind; message: string };

// Terminal review verdicts (plus the post-review `cleaned` state). ONLY these
// mean the run was genuinely already reviewed. In-flight (`running`,
// `generated`, `verified`) and failed (`failed-*`) statuses are NOT
// "already reviewed" — they simply are not reviewable yet (#77 review P2).
const DECIDED_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  "changes_requested",
  "rejected",
  "cleaned",
]);

export function classifyReviewGate(opts: {
  runId: string;
  status: string;
  decisionFileExists: boolean;
  recordedDecision: string | null;
}): ReviewGateClassification {
  if (opts.status !== "needs_review") {
    if (DECIDED_STATUSES.has(opts.status)) {
      return {
        kind: "already_decided",
        message:
          `run ${opts.runId} is already "${opts.status}", not needs_review — it ` +
          `has already been reviewed. No re-review is needed; re-orchestrating an ` +
          `already-decided run is a no-op.`,
      };
    }
    // In-flight or failed: no verdict exists, but the run was NOT reviewed.
    return {
      kind: "run_incomplete",
      message:
        `run ${opts.runId} is "${opts.status}", not needs_review — it is not in ` +
        `a reviewable state (no review verdict exists). Wait for it to reach ` +
        `needs_review, or recover the workspace and re-run if it failed.`,
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
