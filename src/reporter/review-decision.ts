import { stringify } from "yaml";

export interface ReviewDecisionInputs {
  runId: string;
  domain: string;
}

interface ReviewDecisionFile {
  runId: string;
  domain: string;
  decision: "pending" | "approved" | "changes_requested" | "rejected";
  required_changes: string[];
  non_blocking_comments: string[];
  out_of_scope_suggestions: string[];
  reviewer: string | null;
  reviewed_at: string | null;
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
