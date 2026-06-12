import type { SanitizedGateReason } from "./gate-reason.js";

/**
 * Why a run cannot be auto-reviewed. `already_decided` = the run was already
 * reviewed (re-orchestrate is a no-op); `run_incomplete` = the run did not
 * finish and is recoverable (#77). Undefined for other gate failures.
 */
export type ReviewGateKind = "already_decided" | "run_incomplete";

export class ReviewerAgentGateError extends Error {
  readonly kind?: ReviewGateKind;
  readonly reviewerEventsPublished: boolean;
  readonly sanitizedReason?: SanitizedGateReason;
  constructor(
    message: string,
    opts?: {
      kind?: ReviewGateKind;
      reviewerEventsPublished?: boolean;
      sanitizedReason?: SanitizedGateReason;
    },
  ) {
    super(message);
    this.name = "ReviewerAgentGateError";
    if (opts?.kind !== undefined) this.kind = opts.kind;
    this.reviewerEventsPublished = opts?.reviewerEventsPublished === true;
    if (opts?.sanitizedReason !== undefined) {
      this.sanitizedReason = opts.sanitizedReason;
    }
  }
}
