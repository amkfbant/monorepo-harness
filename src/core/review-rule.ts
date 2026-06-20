import { createHash } from "node:crypto";
import type { ProfileReviewRule } from "../project/schema.js";
import { assertPathSafeReviewerId, InvalidReviewerIdError } from "../db/repositories/reviewers.js";
import { ReviewRuleCompileError, DEFAULT_REVIEW_RULE, assertCompiledReviewRuleInvariants, type ReviewRuleRequirement, type ReviewRuleRefuteRequirement, type ReviewRule, type ReviewRuleResolution, type ReviewRuleDispatchRequirement } from "./review-rule-types.js";

// #125 A15: 型/既定値/invariant 検証は review-rule-types.ts、snapshot 読み戻しは
// review-rule-snapshot.ts へ behaviour-zero 抽出。外部 import 互換のため leaf の全 public
// symbol を re-export し、parseReviewRuleSnapshot も再 export（importer のパス不変）。
export * from "./review-rule-types.js";
export { parseReviewRuleSnapshot } from "./review-rule-snapshot.js";

/**
 * Canonical JSON serialiser — keys sorted lexicographically, no
 * whitespace. Used to compute a stable `source_sha256` so two
 * equivalent rule values map to the same `review_rules` row.
 */
export function canonicaliseRule(rule: ReviewRule): string {
  return JSON.stringify(rule, sortedReplacer);
}

export function ruleSha256(rule: ReviewRule): string {
  return createHash("sha256").update(canonicaliseRule(rule)).digest("hex");
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}

export function compileProfileReviewRule(profile: {
  review?: ProfileReviewRule | undefined;
}): ReviewRule {
  const review = profile.review;
  if (review === undefined) return DEFAULT_REVIEW_RULE;

  const mode = review.mode ?? DEFAULT_REVIEW_RULE.mode;
  const maxReviewers = validatePositiveInt(
    review.max_reviewers,
    "review.max_reviewers",
  );
  const requirements = (review.requirements ?? []).map((req, index) => {
    const path = `review.requirements.${index}`;
    const minApprovals = validateRequiredPositiveInt(
      req.min_approvals,
      `${path}.min_approvals`,
    );
    const quorumMinParticipants = validatePositiveInt(
      req.quorum?.min_participants,
      `${path}.quorum.min_participants`,
    );
    const reviewerIds =
      req.reviewer_ids !== undefined
        ? validateStringList(req.reviewer_ids, `${path}.reviewer_ids`)
        : undefined;
    const lensAxes =
      req.lens_axes !== undefined
        ? validateStringList(req.lens_axes, `${path}.lens_axes`)
        : undefined;
    const reqMaxReviewers = validatePositiveInt(
      req.max_reviewers,
      `${path}.max_reviewers`,
    );

    return {
      group: nonEmpty(req.group, `${path}.group`),
      minApprovals,
      blockingDecisions: validateBlockingDecisions(
        req.blocking_decisions,
        `${path}.blocking_decisions`,
      ),
      ...(quorumMinParticipants !== undefined
        ? { quorum: { minParticipants: quorumMinParticipants } }
        : {}),
      ...(reviewerIds !== undefined ? { reviewerIds } : {}),
      ...(lensAxes !== undefined ? { lensAxes } : {}),
      ...(reqMaxReviewers !== undefined ? { maxReviewers: reqMaxReviewers } : {}),
    };
  });
  const refute =
    review.refute === undefined
      ? undefined
      : compileProfileRefuteRequirement(review.refute);

  const rule: ReviewRule = {
    mode,
    ...(maxReviewers !== undefined ? { maxReviewers } : {}),
    ...(refute !== undefined ? { refute } : {}),
    requirements,
    overrides: {
      allowedReviewers:
        review.overrides?.allowed_reviewers ??
        DEFAULT_REVIEW_RULE.overrides.allowedReviewers,
      requireReason:
        review.overrides?.require_reason ??
        DEFAULT_REVIEW_RULE.overrides.requireReason,
    },
    staleProposal: {
      rejectSuperseded:
        review.stale_proposal?.reject_superseded ??
        DEFAULT_REVIEW_RULE.staleProposal.rejectSuperseded,
      ...(review.stale_proposal?.max_age_hours !== undefined
        ? { maxAgeHours: review.stale_proposal.max_age_hours }
        : {}),
    },
  };

  // Structural validation (snake_case → camelCase, positive-int, etc.) happens
  // above as each field is parsed. The value-vs-value *semantic* invariants are
  // factored into a single shared assertion so the snapshot read-back boundary
  // (parseReviewRuleSnapshot) enforces the same set, never drifting.
  assertCompiledReviewRuleInvariants(rule);
  return rule;
}

function compileProfileRefuteRequirement(
  refute: NonNullable<ProfileReviewRule["refute"]>,
): ReviewRuleRefuteRequirement {
  const minParticipants = validatePositiveInt(
    refute.min_participants,
    "review.refute.min_participants",
  );
  const maxReviewers = validatePositiveInt(
    refute.max_reviewers,
    "review.refute.max_reviewers",
  );
  return {
    group: nonEmpty(refute.group, "review.refute.group"),
    reviewerIds: validateReviewerIdList(
      refute.reviewer_ids,
      "review.refute.reviewer_ids",
    ),
    ...(minParticipants !== undefined ? { minParticipants } : {}),
    ...(maxReviewers !== undefined ? { maxReviewers } : {}),
  };
}

/**
 * Resolve the effective review rule for a run scope.
 *
 * The resolver is pure: callers that loaded a project profile pass it in.
 * Missing `profile.review` preserves legacy semantics. A present but
 * semantically invalid `review:` section throws `ReviewRuleCompileError`
 * instead of silently falling back to the default rule.
 */
export function resolveEffectiveRule(scope: {
  projectId?: string;
  repoId?: string;
  domain?: string;
  profile?: { review?: ProfileReviewRule | undefined } | null;
}): ReviewRuleResolution {
  void scope.projectId;
  void scope.repoId;
  void scope.domain;
  const source =
    scope.profile?.review !== undefined ? "project-profile" : "default";
  const rule =
    source === "project-profile"
      ? compileProfileReviewRule(scope.profile as { review: ProfileReviewRule })
      : DEFAULT_REVIEW_RULE;
  return { rule, source, ruleSha256: ruleSha256(rule) };
}

export function requiredReviewersForRequirement(
  requirement: ReviewRuleRequirement,
): number {
  return Math.max(
    requirement.minApprovals,
    requirement.quorum?.minParticipants ?? 1,
  );
}

export function frozenReviewerIdsForRule(rule: ReviewRule): string[] {
  const reviewerIds = new Set<string>();
  for (const requirement of rule.requirements) {
    for (const reviewerId of requirement.reviewerIds ?? []) {
      reviewerIds.add(reviewerId);
    }
  }
  return [...reviewerIds].sort(compareStrings);
}

export function dispatchRequirementsForRule(
  rule: ReviewRule,
): ReviewRuleDispatchRequirement[] {
  if (rule.mode !== "consensus") return [];
  return rule.requirements
    .filter(
      (requirement) =>
        requirement.reviewerIds !== undefined &&
        requirement.reviewerIds.length > 0,
    )
    .map((requirement) => ({
      group: requirement.group,
      requiredReviewers: requiredReviewersForRequirement(requirement),
      reviewerIds: [...(requirement.reviewerIds ?? [])].sort(compareStrings),
    }));
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function validateRequiredPositiveInt(
  value: number | undefined,
  path: string,
): number {
  const parsed = validatePositiveInt(value, path);
  if (parsed === undefined) {
    throw new ReviewRuleCompileError(`${path} must be a positive integer`);
  }
  return parsed;
}

function validatePositiveInt(
  value: number | undefined,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new ReviewRuleCompileError(`${path} must be a positive integer`);
  }
  return value;
}

function nonEmpty(value: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReviewRuleCompileError(`${path} must be a non-empty string`);
  }
  return value;
}

function validateStringList(values: string[], path: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ReviewRuleCompileError(`${path} must be a non-empty list`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ReviewRuleCompileError(`${path} must contain non-empty strings`);
    }
    if (seen.has(value)) {
      throw new ReviewRuleCompileError(`${path} contains duplicate entry: ${value}`);
    }
    seen.add(value);
  }
  return values;
}

function validateReviewerIdList(values: string[], path: string): string[] {
  const ids = validateStringList(values, path);
  for (const id of ids) {
    try {
      assertPathSafeReviewerId(id);
    } catch (e) {
      if (e instanceof InvalidReviewerIdError) {
        throw new ReviewRuleCompileError(
          `${path} contains a non-path-safe reviewer id: ${JSON.stringify(id)}`,
        );
      }
      throw e;
    }
  }
  return ids;
}

function validateBlockingDecisions(
  values: Array<"changes_requested" | "rejected">,
  path: string,
): Array<"changes_requested" | "rejected"> {
  if (!Array.isArray(values)) {
    throw new ReviewRuleCompileError(`${path} must be a list`);
  }
  for (const value of values) {
    if (value !== "changes_requested" && value !== "rejected") {
      throw new ReviewRuleCompileError(
        `${path} contains unsupported decision: ${String(value)}`,
      );
    }
  }
  return values;
}
