import { stringify } from "yaml";
import type { ReviewDecisionFile } from "../core/review-decision-schema.js";

export type {
  ReviewDecisionFile,
  ReviewDecisionValue,
} from "../core/review-decision-schema.js";

export interface ReviewDecisionInputs {
  runId: string;
  domain: string;
}

export function buildReviewDecision(i: ReviewDecisionInputs): string {
  const initial: ReviewDecisionFile = {
    runId: i.runId,
    domain: i.domain,
    decision: "pending",
    required_changes: [],
    non_blocking_comments: [],
    out_of_scope_suggestions: [],
    reviewer: null,
    reviewed_at: null,
  };
  return stringify(initial);
}
