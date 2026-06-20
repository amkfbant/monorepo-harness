
/**
 * Review rule の型・既定値・semantic invariant 検証（#125 A15: core/review-rule.ts から
 * behaviour-zero 抽出）。compile cluster(main) と snapshot reader の双方が参照する
 * assertCompiledReviewRuleInvariants をここに置くことで compile↔snapshot 循環を断つ
 * leaf モジュール（local import ゼロ）。
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

export interface ReviewRuleRefuteRequirement {
  /** reviewer group_id whose target-bound refute votes are eligible. */
  group: string;
  /** Frozen refute reviewer set used as the strict-majority denominator. */
  reviewerIds: string[];
  /** Optional minimum number of participant votes before the check can pass. */
  minParticipants?: number;
  /** Per-refute reviewer dispatch cap. Runtime dispatch consumes this later. */
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
  /** Phase 2: target-bound refute reviewer gate for blocking changes. */
  refute?: ReviewRuleRefuteRequirement;
  requirements: ReviewRuleRequirement[];
  overrides: ReviewRuleOverrides;
  staleProposal: ReviewRuleStaleProposal;
}

export interface ReviewRuleResolution {
  rule: ReviewRule;
  source: "default" | "project-profile";
  ruleSha256: string;
}

export interface ReviewRuleDispatchRequirement {
  group: string;
  requiredReviewers: number;
  reviewerIds: string[];
}

export class ReviewRuleCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRuleCompileError";
  }
}

/**
 * Raised when a *persisted* `review_rules` snapshot fails to parse or fails
 * structural validation. Extends {@link ReviewRuleCompileError} so existing
 * fail-closed catch sites that trap the compile error family also trap a
 * tampered/corrupt snapshot — callers must never silently downgrade to a
 * loose default when a snapshot is malformed.
 */
export class ReviewRuleSnapshotError extends ReviewRuleCompileError {
  constructor(message: string) {
    super(`invalid review rule snapshot: ${message}`);
    this.name = "ReviewRuleSnapshotError";
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
 * Options for {@link assertCompiledReviewRuleInvariants}.
 */
export interface AssertReviewRuleInvariantsOptions {
  /**
   * Require an explicit frozen reviewer set (`reviewerIds` + `lensAxes`) for any
   * consensus requirement that needs multiple reviewers.
   *
   * `true` (compile default): a profile authoring a multi-reviewer requirement
   * must declare a frozen reviewer set and its lenses — the stricter authoring
   * policy enforced by {@link compileProfileReviewRule}.
   *
   * `false` (snapshot read-back): a *non-frozen* consensus requirement — a
   * group-membership quorum with no `reviewerIds` — is a first-class runtime
   * shape (reviewers resolve from the reviewer group at dispatch time). The
   * read-back boundary must accept it instead of fail-closed rejecting a
   * legitimate persisted snapshot. Every other invariant (the fail-open shape
   * gates and the unsatisfiable / over-cap frozen-set bounds) still applies.
   */
  requireFrozenReviewerSet?: boolean;
}

/**
 * Assert the *semantic* (value-vs-value) invariants of an already-compiled
 * {@link ReviewRule} — i.e. consistency checks between fields after defaults
 * are applied and snake_case has been mapped to camelCase. Structural
 * validation (types, positive integers, non-empty/path-safe ids) is the
 * caller's responsibility and is performed while the rule is assembled.
 *
 * This is the single source of truth shared by {@link compileProfileReviewRule}
 * (which builds a rule from a profile) and {@link parseReviewRuleSnapshot}
 * (which reads a persisted snapshot back). Centralising the checks here removes
 * the whack-a-mole drift where one boundary mirrored an invariant and the other
 * silently did not.
 *
 * The two callers share every fail-open / unsatisfiable invariant: the
 * consensus/empty and latest-proposal/requirements shape gates, the
 * frozen/non-frozen requirement homogeneity gate (no mixing — see below), the
 * over-`max_reviewers` frozen-set bound, and the frozen-set-too-small-for-the
 * gate bound. They differ on exactly one axis — `requireFrozenReviewerSet`
 * (see {@link AssertReviewRuleInvariantsOptions}) — because a *non-frozen*
 * group-membership consensus requirement is invalid for profile authoring but
 * valid at runtime, so the snapshot boundary must not reject it. A *mix* of
 * frozen and non-frozen requirements is rejected on BOTH boundaries: the
 * consensus gate filters proposals by the union of all frozen reviewer_ids, so
 * a mix silently drops a non-frozen requirement's blocking verdict (fail-open).
 *
 * Throws {@link ReviewRuleCompileError} (the compile-side error type) on the
 * first violation; the snapshot boundary normalises this to
 * {@link ReviewRuleSnapshotError}. Error messages intentionally reuse the
 * profile-source (`review.requirements.<i>.<snake_case>`) wording so existing
 * compile diagnostics are preserved byte-for-byte.
 */
export function assertCompiledReviewRuleInvariants(
  rule: ReviewRule,
  opts: AssertReviewRuleInvariantsOptions = {},
): void {
  const requireFrozenReviewerSet = opts.requireFrozenReviewerSet ?? true;

  if (rule.mode === "consensus" && rule.requirements.length === 0) {
    throw new ReviewRuleCompileError(
      "consensus mode requires at least one requirement",
    );
  }
  // fail-closed: requirements are only evaluated in consensus mode. A rule that
  // declares requirements but leaves mode at its latest-proposal default would
  // silently drop the intended quorum/multi-reviewer gate (codex SP-10).
  if (rule.mode !== "consensus" && rule.requirements.length > 0) {
    throw new ReviewRuleCompileError(
      `review.requirements is set but review.mode is "${rule.mode}"; requirements ` +
        `are only evaluated in consensus mode — set mode: consensus explicitly ` +
        `(a missing mode defaults to latest-proposal and would drop the gate)`,
    );
  }
  if (rule.mode !== "consensus" && rule.refute !== undefined) {
    throw new ReviewRuleCompileError(
      `review.refute is set but review.mode is "${rule.mode}"; refute votes ` +
        `are only evaluated in consensus mode — set mode: consensus explicitly`,
    );
  }

  // fail-closed (SP-12 fail-open fix): a consensus rule must NOT mix frozen
  // requirements (declared `reviewerIds`) with non-frozen ones (group-membership,
  // no `reviewerIds`). The promote gate filters active proposals by the *union*
  // of every frozen `reviewerIds` (`frozenReviewerIdsForRule`); with a mix, a
  // blocking proposal from a non-frozen requirement's group member — who is not
  // in that union — is silently dropped by the global filter, so the frozen
  // approvals alone can reach `approved`. Frozen-only and non-frozen-only rules
  // are each internally coherent (one global filter for the whole rule, or no
  // filter at all); a mix has no coherent dispatch/eval model. Reject it on both
  // boundaries — compile (authoring) and snapshot read-back (persisted) — since
  // a tampered/legacy snapshot in this shape is just as unsafe.
  if (rule.mode === "consensus" && rule.requirements.length > 0) {
    const frozenCount = rule.requirements.filter(
      (req) => req.reviewerIds !== undefined && req.reviewerIds.length > 0,
    ).length;
    if (frozenCount > 0 && frozenCount < rule.requirements.length) {
      throw new ReviewRuleCompileError(
        `review.requirements mixes frozen and non-frozen requirements; all ` +
          `requirements must declare reviewer_ids (frozen) or none must — a mix ` +
          `would drop a non-frozen requirement's blocking verdict at the consensus ` +
          `gate (the gate filters proposals by the union of frozen reviewer_ids)`,
      );
    }
  }

  rule.requirements.forEach((req, index) => {
    const path = `review.requirements.${index}`;
    const reviewerIds = req.reviewerIds;
    const minApprovals = req.minApprovals;
    const quorumMinParticipants = req.quorum?.minParticipants;
    const effectiveMaxReviewers = req.maxReviewers ?? rule.maxReviewers;

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
    // Authoring policy only: a non-frozen group-membership quorum (reviewerIds
    // omitted) is valid at runtime, so the snapshot boundary skips this gate.
    if (
      requireFrozenReviewerSet &&
      rule.mode === "consensus" &&
      multiReviewerRequired
    ) {
      if (reviewerIds === undefined) {
        throw new ReviewRuleCompileError(
          `${path}.reviewer_ids is required when min_approvals or quorum.min_participants requires multiple reviewers`,
        );
      }
      if (req.lensAxes === undefined) {
        throw new ReviewRuleCompileError(
          `${path}.lens_axes is required when min_approvals or quorum.min_participants requires multiple reviewers`,
        );
      }
    }
    // Whenever a frozen set IS declared, it must be large enough to satisfy the
    // gate — applies to both boundaries (an explicit set this small can never
    // reach quorum/approvals).
    if (reviewerIds !== undefined && reviewerIds.length < requiredParticipants) {
      throw new ReviewRuleCompileError(
        `${path}.reviewer_ids has ${reviewerIds.length} distinct entries, but ${requiredParticipants} reviewer(s) are required`,
      );
    }
  });

  if (rule.refute !== undefined) {
    const refute = rule.refute;
    const path = "review.refute";
    const effectiveMaxReviewers = refute.maxReviewers ?? rule.maxReviewers;
    if (
      effectiveMaxReviewers !== undefined &&
      refute.reviewerIds.length > effectiveMaxReviewers
    ) {
      throw new ReviewRuleCompileError(
        `${path}.reviewer_ids has ${refute.reviewerIds.length} entries, exceeding max_reviewers=${effectiveMaxReviewers}`,
      );
    }
    if (
      refute.minParticipants !== undefined &&
      refute.reviewerIds.length < refute.minParticipants
    ) {
      throw new ReviewRuleCompileError(
        `${path}.reviewer_ids has ${refute.reviewerIds.length} distinct entries, but min_participants=${refute.minParticipants}`,
      );
    }
  }
}
