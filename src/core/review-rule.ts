import { createHash } from "node:crypto";

/**
 * Review rule (Phase 11-3).
 *
 * Phase 11 stores the *effective* rule snapshot per run so that profile
 * changes do not retroactively alter ongoing runs. This module defines
 * the shape, the default rule (= pre-Phase-11 behaviour), and a
 * canonical serialiser used to compute `source_sha256`.
 *
 * Reading the rule from a project profile is delegated to Phase 14
 * (project profile DB canonical). For now, `resolveEffectiveRule`
 * returns the default rule whenever the profile does not carry an
 * explicit `review:` section.
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
  requirements: ReviewRuleRequirement[];
  overrides: ReviewRuleOverrides;
  staleProposal: ReviewRuleStaleProposal;
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

/**
 * Resolve the effective review rule for a run scope.
 *
 * Phase 11-3 minimum: the project profile's `review:` section is not
 * loaded yet — that lands in Phase 14 (project profile DB canonical).
 * For now, always return the default rule. The signature carries
 * `projectId` / `repoId` / `domain` to keep call sites stable for the
 * upcoming Phase 14 work.
 */
export function resolveEffectiveRule(_scope: {
  projectId?: string;
  repoId?: string;
  domain?: string;
}): ReviewRule {
  return DEFAULT_REVIEW_RULE;
}
