// codex の YAML 出力を ReviewDecisionFile に検証変換する境界。
// LLM 出力は信用しない: 全フィールドを fail-closed に検証し、不正なら
// ReviewerAgentGateError を投げる（reason は sanitizeGateReason で無害化）。
import {
  ReviewDecisionFileSchema,
  type ReviewDecisionFile,
} from "./review-decision-schema.js";
import { ReviewerAgentGateError } from "./reviewer-agent-errors.js";
import { sanitizeGateReason } from "./gate-reason.js";

/**
 * Extract the YAML body from a fenced block. Codex sometimes adds prose
 * around the block; we only trust the contents of the first fence.
 */
export function extractYamlBlock(output: string): string {
  const fenced = output.match(/```ya?ml\s*\n([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  // fall back: try the whole output as YAML
  return output.trim();
}

/**
 * Try to coerce the codex output into a ReviewDecisionFile. The agent
 * only writes the four optional fields; we merge with runId/domain from
 * meta.json and stamp reviewer + reviewed_at ourselves.
 */
export interface PartialDecision {
  decision?: unknown;
  required_changes?: unknown;
  non_blocking_comments?: unknown;
  out_of_scope_suggestions?: unknown;
}

function requireStringArray(field: string, v: unknown): string[] {
  if (!Array.isArray(v)) {
    throw new ReviewerAgentGateError(
      `reviewer output field "${field}" must be an array of strings`,
      {
        sanitizedReason: sanitizeGateReason({
          code: "reviewer_output_field_not_string_array",
          field,
          value: v,
        }),
      },
    );
  }
  for (const x of v) {
    if (typeof x !== "string") {
      throw new ReviewerAgentGateError(
        `reviewer output field "${field}" contains non-string entries`,
        {
          sanitizedReason: sanitizeGateReason({
            code: "reviewer_output_field_non_string_entry",
            field,
            value: x,
          }),
        },
      );
    }
  }
  return v as string[];
}

export function buildDecision(
  runId: string,
  domain: string,
  raw: PartialDecision,
  reviewer: string,
  reviewedAt: string,
): ReviewDecisionFile {
  if (
    raw.decision !== "approved" &&
    raw.decision !== "changes_requested" &&
    raw.decision !== "rejected"
  ) {
    throw new ReviewerAgentGateError(
      `reviewer output has missing or unknown decision: ${JSON.stringify(raw.decision)} (expected approved | changes_requested | rejected)`,
      {
        sanitizedReason: sanitizeGateReason({
          code: "reviewer_output_unknown_decision",
          field: "decision",
          value: raw.decision,
        }),
      },
    );
  }
  const required = requireStringArray("required_changes", raw.required_changes);
  const nonBlocking = requireStringArray(
    "non_blocking_comments",
    raw.non_blocking_comments,
  );
  const outOfScope = requireStringArray(
    "out_of_scope_suggestions",
    raw.out_of_scope_suggestions,
  );
  if (raw.decision === "changes_requested" && required.length === 0) {
    throw new ReviewerAgentGateError(
      "reviewer output is decision=changes_requested but required_changes is empty",
      {
        sanitizedReason: sanitizeGateReason({
          code: "reviewer_output_empty_required_changes",
          field: "required_changes",
          value: raw.required_changes,
        }),
      },
    );
  }
  const file: ReviewDecisionFile = {
    runId,
    domain,
    decision: raw.decision,
    required_changes: required,
    non_blocking_comments: nonBlocking,
    out_of_scope_suggestions: outOfScope,
    reviewer,
    reviewed_at: reviewedAt,
  };
  return ReviewDecisionFileSchema.parse(file);
}
