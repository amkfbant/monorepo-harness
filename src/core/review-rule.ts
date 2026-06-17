import { createHash } from "node:crypto";
import type { ProfileReviewRule } from "../project/schema.js";

/**
 * Review rule (Phase 11-3).
 *
 * Phase 11 stores the *effective* rule snapshot per run so that profile
 * changes do not retroactively alter ongoing runs. This module defines
 * the shape, the default rule (= pre-Phase-11 behaviour), and a
 * canonical serialiser used to compute `source_sha256`.
 *
 * Project profile `review:` sections are compiled here into the runtime
 * `ReviewRule` shape. Missing `review:` keeps the default rule; present
 * but semantically invalid review config throws `ReviewRuleCompileError`
 * so callers fail closed instead of silently downgrading to latest-proposal.
 */

export type ReviewMode = "latest-proposal" | "consensus";

/**
 * Phase 2-1: quorum / participation requirement for a reviewer group.
 *
 * Independent of `minApprovals`: a group can require N approvals AND a
 * minimum participation (distinct reviewers that submitted a non-pending
 * verdict). `undefined` on a requirement = legacy behaviour (no quorum
 * check). fail-closed: a participation-rate requirement without a positive
 * `groupSize` is treated as not satisfiable.
 */
export interface ReviewRuleQuorum {
  /** Minimum number of distinct reviewers that must submit a non-pending verdict. */
  minParticipants?: number;
  /** Minimum participation rate (0..1). Requires a positive `groupSize`. */
  minParticipationRate?: number;
  /** Expected group size — the denominator for `minParticipationRate`. */
  groupSize?: number;
}

export interface ReviewRuleRequirement {
  /** reviewer group_id to apply this requirement to. */
  group: string;
  minApprovals: number;
  blockingDecisions: Array<"changes_requested" | "rejected">;
  /** Phase 2-1: optional quorum. `undefined` = no quorum check (legacy). */
  quorum?: ReviewRuleQuorum;
  /** Explicit frozen reviewer set for this requirement, when declared by a profile. */
  reviewerIds?: string[];
  /** Declared review lenses for multi-reviewer requirements. */
  lensAxes?: string[];
  /** Per-requirement reviewer dispatch cap. Runtime dispatch consumes this later. */
  maxReviewers?: number;
}

export interface ReviewRuleOverrides {
  allowedReviewers: string[];
  requireReason: boolean;
}

export interface ReviewRuleStaleProposal {
  rejectSuperseded: boolean;
  maxAgeHours?: number;
}

export interface ReviewRule {
  mode: ReviewMode;
  /** Default reviewer dispatch cap for profile-authored requirements. */
  maxReviewers?: number;
  requirements: ReviewRuleRequirement[];
  overrides: ReviewRuleOverrides;
  staleProposal: ReviewRuleStaleProposal;
}

export interface ReviewRuleResolution {
  rule: ReviewRule;
  source: "default" | "project-profile";
  ruleSha256: string;
}

export class ReviewRuleCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRuleCompileError";
  }
}

/**
 * Default rule (Phase 11 baseline = pre-Phase-11 behaviour):
 *   - `mode: latest-proposal` — `review process` takes the most recent
 *     active proposal and promotes it directly.
 *   - no requirements (consensus not evaluated).
 *   - overrides disallowed (no allowed reviewers).
 *   - superseded proposals are rejected.
 */
export const DEFAULT_REVIEW_RULE: ReviewRule = {
  mode: "latest-proposal",
  requirements: [],
  overrides: {
    allowedReviewers: [],
    requireReason: true,
  },
  staleProposal: {
    rejectSuperseded: true,
  },
};

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
    const effectiveMaxReviewers = reqMaxReviewers ?? maxReviewers;
    if (
      reviewerIds !== undefined &&
      effectiveMaxReviewers !== undefined &&
      reviewerIds.length > effectiveMaxReviewers
    ) {
      throw new ReviewRuleCompileError(
        `${path}.reviewer_ids has ${reviewerIds.length} entries, exceeding max_reviewers=${effectiveMaxReviewers}`,
      );
    }

    const requiredParticipants = Math.max(
      minApprovals,
      quorumMinParticipants ?? 1,
    );
    const multiReviewerRequired =
      minApprovals > 1 || (quorumMinParticipants ?? 1) > 1;
    if (mode === "consensus" && multiReviewerRequired) {
      if (reviewerIds === undefined) {
        throw new ReviewRuleCompileError(
          `${path}.reviewer_ids is required when min_approvals or quorum.min_participants requires multiple reviewers`,
        );
      }
      if (lensAxes === undefined) {
        throw new ReviewRuleCompileError(
          `${path}.lens_axes is required when min_approvals or quorum.min_participants requires multiple reviewers`,
        );
      }
    }
    if (reviewerIds !== undefined && reviewerIds.length < requiredParticipants) {
      throw new ReviewRuleCompileError(
        `${path}.reviewer_ids has ${reviewerIds.length} distinct entries, but ${requiredParticipants} reviewer(s) are required`,
      );
    }

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
  if (mode === "consensus" && requirements.length === 0) {
    throw new ReviewRuleCompileError(
      "consensus mode requires at least one requirement",
    );
  }
  // fail-closed: requirements are only evaluated in consensus mode. A profile
  // that declares requirements but leaves mode at its latest-proposal default
  // would silently drop the intended quorum/multi-reviewer gate (codex SP-10).
  if (mode !== "consensus" && requirements.length > 0) {
    throw new ReviewRuleCompileError(
      `review.requirements is set but review.mode is "${mode}"; requirements ` +
        `are only evaluated in consensus mode — set mode: consensus explicitly ` +
        `(a missing mode defaults to latest-proposal and would drop the gate)`,
    );
  }

  return {
    mode,
    ...(maxReviewers !== undefined ? { maxReviewers } : {}),
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
