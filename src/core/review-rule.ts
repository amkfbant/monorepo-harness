import { createHash } from "node:crypto";
import type { ProfileReviewRule } from "../project/schema.js";
import {
  assertPathSafeReviewerId,
  InvalidReviewerIdError,
} from "../db/repositories/reviewers.js";

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

/**
 * Parse + structurally validate a persisted `review_rules` snapshot JSON
 * string into a runtime {@link ReviewRule}.
 *
 * This is the single fail-closed boundary for *reading back* a snapshot at
 * runtime — every consumer that loads `review_rules.rule_json` must route
 * through here instead of an unchecked `JSON.parse(...) as ReviewRule`. A
 * tampered/corrupt snapshot (bad JSON, missing/unknown `mode`, a consensus
 * rule with no `requirements`, or any unsafe reviewer id) throws
 * {@link ReviewRuleSnapshotError} so callers can fail the run instead of
 * silently approving with a degraded gate.
 *
 * It shares the structural invariants enforced by
 * {@link compileProfileReviewRule}: known mode enum, non-empty consensus
 * requirements, positive `minApprovals`, supported blocking decisions, and
 * non-empty / non-duplicate / path-safe reviewer ids.
 */
export function parseReviewRuleSnapshot(ruleJson: string): ReviewRule {
  let raw: unknown;
  try {
    raw = JSON.parse(ruleJson);
  } catch (e) {
    throw new ReviewRuleSnapshotError(
      `not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!isPlainObject(raw)) {
    throw new ReviewRuleSnapshotError(
      `top-level value must be an object, got ${describeJsonType(raw)}`,
    );
  }

  const mode = raw.mode;
  if (mode !== "consensus" && mode !== "latest-proposal") {
    throw new ReviewRuleSnapshotError(
      `mode must be "consensus" or "latest-proposal", got ${JSON.stringify(mode)}`,
    );
  }

  if (!Array.isArray(raw.requirements)) {
    throw new ReviewRuleSnapshotError("requirements must be an array");
  }
  const requirements = raw.requirements.map((req, index) =>
    validateSnapshotRequirement(req, `requirements.${index}`),
  );
  const refute = validateSnapshotRefute(raw.refute, "refute");

  const overrides = validateSnapshotOverrides(raw.overrides);
  const staleProposal = validateSnapshotStaleProposal(raw.staleProposal);
  const maxReviewers = validateSnapshotPositiveInt(
    raw.maxReviewers,
    "maxReviewers",
  );

  const rule: ReviewRule = {
    mode,
    ...(maxReviewers !== undefined ? { maxReviewers } : {}),
    ...(refute !== undefined ? { refute } : {}),
    requirements,
    overrides,
    staleProposal,
  };

  // The structurally-valid snapshot must still satisfy the *semantic* fail-open
  // / unsatisfiable invariants that compileProfileReviewRule enforces — the
  // consensus/empty and latest-proposal/requirements shape gates, the
  // over-max_reviewers bound, and the frozen-set-too-small bound. Routing
  // through the shared assertion keeps the read-back boundary from drifting.
  // `requireFrozenReviewerSet: false` because a non-frozen group-membership
  // quorum (no reviewerIds) is a legitimate runtime shape — that authoring-only
  // requirement must not fail-closed reject a valid persisted snapshot.
  // Normalise the compile-side error to the snapshot type so callers fail
  // closed via the snapshot family.
  try {
    assertCompiledReviewRuleInvariants(rule, { requireFrozenReviewerSet: false });
  } catch (e) {
    if (
      e instanceof ReviewRuleCompileError &&
      !(e instanceof ReviewRuleSnapshotError)
    ) {
      throw new ReviewRuleSnapshotError(e.message);
    }
    throw e;
  }
  return rule;
}

function validateSnapshotRequirement(
  req: unknown,
  path: string,
): ReviewRuleRequirement {
  if (!isPlainObject(req)) {
    throw new ReviewRuleSnapshotError(`${path} must be an object`);
  }
  const group = req.group;
  if (typeof group !== "string" || group.trim() === "") {
    throw new ReviewRuleSnapshotError(`${path}.group must be a non-empty string`);
  }
  const minApprovals = validateSnapshotRequiredPositiveInt(
    req.minApprovals,
    `${path}.minApprovals`,
  );
  const blockingDecisions = validateSnapshotBlockingDecisions(
    req.blockingDecisions,
    `${path}.blockingDecisions`,
  );
  const quorum = validateSnapshotQuorum(req.quorum, `${path}.quorum`);
  const reviewerIds =
    req.reviewerIds === undefined
      ? undefined
      : validateSnapshotReviewerIds(req.reviewerIds, `${path}.reviewerIds`);
  const lensAxes =
    req.lensAxes === undefined
      ? undefined
      : validateSnapshotStringList(req.lensAxes, `${path}.lensAxes`);
  const reqMaxReviewers = validateSnapshotPositiveInt(
    req.maxReviewers,
    `${path}.maxReviewers`,
  );
  return {
    group,
    minApprovals,
    blockingDecisions,
    ...(quorum !== undefined ? { quorum } : {}),
    ...(reviewerIds !== undefined ? { reviewerIds } : {}),
    ...(lensAxes !== undefined ? { lensAxes } : {}),
    ...(reqMaxReviewers !== undefined ? { maxReviewers: reqMaxReviewers } : {}),
  };
}

function validateSnapshotRefute(
  value: unknown,
  path: string,
): ReviewRuleRefuteRequirement | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ReviewRuleSnapshotError(`${path} must be an object`);
  }
  const group = value.group;
  if (typeof group !== "string" || group.trim() === "") {
    throw new ReviewRuleSnapshotError(`${path}.group must be a non-empty string`);
  }
  const reviewerIds = validateSnapshotReviewerIds(
    value.reviewerIds,
    `${path}.reviewerIds`,
  );
  const minParticipants = validateSnapshotPositiveInt(
    value.minParticipants,
    `${path}.minParticipants`,
  );
  const maxReviewers = validateSnapshotPositiveInt(
    value.maxReviewers,
    `${path}.maxReviewers`,
  );
  return {
    group,
    reviewerIds,
    ...(minParticipants !== undefined ? { minParticipants } : {}),
    ...(maxReviewers !== undefined ? { maxReviewers } : {}),
  };
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

function validateSnapshotQuorum(
  value: unknown,
  path: string,
): ReviewRuleQuorum | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ReviewRuleSnapshotError(`${path} must be an object`);
  }
  const minParticipants = validateSnapshotPositiveInt(
    value.minParticipants,
    `${path}.minParticipants`,
  );
  const groupSize = validateSnapshotPositiveInt(
    value.groupSize,
    `${path}.groupSize`,
  );
  const minParticipationRate = value.minParticipationRate;
  if (
    minParticipationRate !== undefined &&
    (typeof minParticipationRate !== "number" ||
      !Number.isFinite(minParticipationRate) ||
      minParticipationRate < 0 ||
      minParticipationRate > 1)
  ) {
    throw new ReviewRuleSnapshotError(
      `${path}.minParticipationRate must be a number in [0, 1]`,
    );
  }
  return {
    ...(minParticipants !== undefined ? { minParticipants } : {}),
    ...(minParticipationRate !== undefined ? { minParticipationRate } : {}),
    ...(groupSize !== undefined ? { groupSize } : {}),
  };
}

function validateSnapshotOverrides(value: unknown): ReviewRuleOverrides {
  if (!isPlainObject(value)) {
    throw new ReviewRuleSnapshotError("overrides must be an object");
  }
  const allowedReviewers = validateSnapshotReviewerIdArrayMaybeEmpty(
    value.allowedReviewers,
    "overrides.allowedReviewers",
  );
  if (typeof value.requireReason !== "boolean") {
    throw new ReviewRuleSnapshotError(
      "overrides.requireReason must be a boolean",
    );
  }
  return { allowedReviewers, requireReason: value.requireReason };
}

function validateSnapshotStaleProposal(
  value: unknown,
): ReviewRuleStaleProposal {
  if (!isPlainObject(value)) {
    throw new ReviewRuleSnapshotError("staleProposal must be an object");
  }
  if (typeof value.rejectSuperseded !== "boolean") {
    throw new ReviewRuleSnapshotError(
      "staleProposal.rejectSuperseded must be a boolean",
    );
  }
  // maxAgeHours mirrors the compile schema (`z.number().positive()`), which
  // permits a positive *float* (e.g. 0.5h). A positive-INTEGER check here was
  // stricter than compile and would fail-closed reject a legitimate compiled
  // snapshot — accept any positive finite number instead.
  const maxAgeHours = validateSnapshotPositiveNumber(
    value.maxAgeHours,
    "staleProposal.maxAgeHours",
  );
  return {
    rejectSuperseded: value.rejectSuperseded,
    ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
  };
}

/** Mirrors compile's `z.number().positive()` — any positive finite number. */
function validateSnapshotPositiveNumber(
  value: unknown,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ReviewRuleSnapshotError(`${path} must be a positive number`);
  }
  return value;
}

function validateSnapshotReviewerIds(value: unknown, path: string): string[] {
  const ids = validateSnapshotStringList(value, path);
  assertPathSafeReviewerIds(ids, path);
  return ids;
}

/** allowedReviewers may legitimately be empty, but every entry stays path-safe. */
function validateSnapshotReviewerIdArrayMaybeEmpty(
  value: unknown,
  path: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new ReviewRuleSnapshotError(`${path} must be an array`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ReviewRuleSnapshotError(`${path} must contain non-empty strings`);
    }
    if (seen.has(entry)) {
      throw new ReviewRuleSnapshotError(`${path} contains duplicate entry: ${entry}`);
    }
    seen.add(entry);
  }
  assertPathSafeReviewerIds(value as string[], path);
  return value as string[];
}

function assertPathSafeReviewerIds(ids: readonly string[], path: string): void {
  for (const id of ids) {
    try {
      assertPathSafeReviewerId(id);
    } catch (e) {
      if (e instanceof InvalidReviewerIdError) {
        throw new ReviewRuleSnapshotError(
          `${path} contains a non-path-safe reviewer id: ${JSON.stringify(id)}`,
        );
      }
      throw e;
    }
  }
}

function validateSnapshotStringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewRuleSnapshotError(`${path} must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ReviewRuleSnapshotError(`${path} must contain non-empty strings`);
    }
    if (seen.has(entry)) {
      throw new ReviewRuleSnapshotError(`${path} contains duplicate entry: ${entry}`);
    }
    seen.add(entry);
  }
  return value as string[];
}

function validateSnapshotBlockingDecisions(
  value: unknown,
  path: string,
): Array<"changes_requested" | "rejected"> {
  if (!Array.isArray(value)) {
    throw new ReviewRuleSnapshotError(`${path} must be an array`);
  }
  for (const entry of value) {
    if (entry !== "changes_requested" && entry !== "rejected") {
      throw new ReviewRuleSnapshotError(
        `${path} contains unsupported decision: ${JSON.stringify(entry)}`,
      );
    }
  }
  return value as Array<"changes_requested" | "rejected">;
}

function validateSnapshotRequiredPositiveInt(
  value: unknown,
  path: string,
): number {
  const parsed = validateSnapshotPositiveInt(value, path);
  if (parsed === undefined) {
    throw new ReviewRuleSnapshotError(`${path} must be a positive integer`);
  }
  return parsed;
}

function validateSnapshotPositiveInt(
  value: unknown,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ReviewRuleSnapshotError(`${path} must be a positive integer`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
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
