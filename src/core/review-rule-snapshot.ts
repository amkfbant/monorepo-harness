import { assertPathSafeReviewerId, InvalidReviewerIdError } from "../db/repositories/reviewers.js";
import { ReviewRuleCompileError, ReviewRuleSnapshotError, assertCompiledReviewRuleInvariants, type ReviewRuleQuorum, type ReviewRuleRequirement, type ReviewRuleRefuteRequirement, type ReviewRuleOverrides, type ReviewRuleStaleProposal, type ReviewRule } from "./review-rule-types.js";

/**
 * 永続化された `review_rules` snapshot JSON の読み戻し fail-closed 境界（#125 A15:
 * review-rule.ts から behaviour-zero 抽出）。parseReviewRuleSnapshot + validateSnapshot*
 * 群。型・assert は ./review-rule-types から import。
 */
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
