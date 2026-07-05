import type {
  HitchCloseCheck,
  HitchCloseCheckStatus,
  HitchCloseCondition,
  HitchEvidence,
  HitchEvidenceKind,
} from "./types.js";
import { HITCH_EVIDENCE_KINDS } from "./types.js";
import {
  evaluateFacetRedCoverage,
  parseFacetRule,
  type FacetRedEvidence,
} from "./facet-coverage.js";
import { evaluateReviewConsensusEvidenceRows } from "./review-consensus-evidence.js";

const HITCH_EVIDENCE_KIND_SET: ReadonlySet<string> = new Set(
  HITCH_EVIDENCE_KINDS,
);

/**
 * How a PENDING facet_red_test condition can be satisfied — drives convergence
 * recovery routing (#308 P2-2). Only ever set on a pending facet_red_test
 * condition; undefined for every other condition kind/status.
 * - `code_recoverable`: at least one pending facet has NO covering test present,
 *   so no evidence row could ever clear it — only a code/test change can
 *   (route to the CODER / needs_fix).
 * - `evidence_recoverable`: every pending facet has a covering test present and
 *   merely lacks a fresh RED evidence row — recording evidence clears it (route
 *   to ask_human / external-evidence, the pre-#308 behaviour).
 */
export type FacetPendingDisposition =
  | "code_recoverable"
  | "evidence_recoverable";

export interface EvaluatedCloseCondition {
  condition: HitchCloseCondition;
  status: HitchCloseCheckStatus;
  check: HitchCloseCheck | null;
  message: string;
  /** Present only on a pending facet_red_test condition (see type doc). */
  facetPendingDisposition?: FacetPendingDisposition;
}

export interface CloseConditionEvaluation {
  conditions: EvaluatedCloseCondition[];
  requiredPassed: number;
  requiredFailed: number;
  requiredPending: number;
  allRequiredPassed: boolean;
}

export interface FindingPolicyCounts {
  openInScopeP0: number;
  openInScopeP1: number;
  openInScopeP2: number;
  openUnknownScope: number;
}

export function latestCloseChecksByCondition(
  checks: HitchCloseCheck[],
): Map<string, HitchCloseCheck> {
  const latest = new Map<string, HitchCloseCheck>();
  for (const check of checks) {
    const previous = latest.get(check.conditionId);
    if (
      previous === undefined ||
      check.checkedAt > previous.checkedAt ||
      (check.checkedAt === previous.checkedAt && check.checkId > previous.checkId)
    ) {
      latest.set(check.conditionId, check);
    }
  }
  return latest;
}

export function evaluateCloseConditions(input: {
  conditions: HitchCloseCondition[];
  checks: HitchCloseCheck[];
  findingCounts: FindingPolicyCounts;
  freshAfter?: string | null;
  allowEmptyCloseConditions?: boolean;
  /**
   * Deterministic facet_red_test inputs (opt-in). When absent, a facet_red_test
   * condition evaluates fail-closed (pending/failed, never passed). Existing
   * hitches that never declare facet_red_test are unaffected by these params.
   */
  changedPaths?: readonly string[];
  latestCodingRunId?: string | null;
  /**
   * Deterministic evidence_attached input (#91 Stage B, opt-in). When absent, an
   * `evidence_attached` condition evaluates fail-closed (pending, never passed).
   * Existing hitches that never declare `evidence_attached` are unaffected — the
   * field is purely additive and can only make close stricter for opt-in hitches.
   */
  evidenceRows?: readonly HitchEvidence[];
}): CloseConditionEvaluation {
  if (
    input.conditions.length === 0 &&
    input.allowEmptyCloseConditions !== true
  ) {
    return {
      conditions: [],
      requiredPassed: 0,
      requiredFailed: 0,
      requiredPending: 1,
      allRequiredPassed: false,
    };
  }
  const latest = latestCloseChecksByCondition(input.checks);
  const conditions = input.conditions.map((condition) => {
    if (condition.kind === "finding_policy") {
      return evaluateFindingPolicy(condition, input.findingCounts);
    }
    if (condition.kind === "facet_red_test") {
      return evaluateFacetRedTest(
        condition,
        latest.get(condition.id) ?? null,
        input.freshAfter ?? null,
        input.changedPaths ?? [],
        input.latestCodingRunId ?? null,
      );
    }
    if (condition.kind === "evidence_attached") {
      return evaluateEvidenceAttached(
        condition,
        input.evidenceRows ?? [],
        input.freshAfter ?? null,
      );
    }
    if (condition.kind === "review_consensus") {
      return evaluateReviewConsensus(
        condition,
        latest.get(condition.id) ?? null,
        input.freshAfter ?? null,
        input.evidenceRows ?? [],
      );
    }
    return evaluateRecordedCheck(
      condition,
      latest.get(condition.id) ?? null,
      input.freshAfter ?? null,
    );
  });
  let requiredPassed = 0;
  let requiredFailed = 0;
  let requiredPending = 0;
  for (const evaluated of conditions) {
    if (!evaluated.condition.required) continue;
    if (evaluated.status === "passed") requiredPassed += 1;
    else if (evaluated.status === "failed") requiredFailed += 1;
    else requiredPending += 1;
  }
  return {
    conditions,
    requiredPassed,
    requiredFailed,
    requiredPending,
    allRequiredPassed: requiredFailed === 0 && requiredPending === 0,
  };
}

function evaluateRecordedCheck(
  condition: HitchCloseCondition,
  check: HitchCloseCheck | null,
  freshAfter: string | null,
): EvaluatedCloseCondition {
  if (check === null) {
    return {
      condition,
      status: "pending",
      check,
      message: "no close-check evidence recorded",
    };
  }
  if (freshAfter !== null && check.checkedAt < freshAfter) {
    return {
      condition,
      status: "pending",
      check,
      message:
        "close-check evidence is stale; record fresh evidence after latest mutation",
    };
  }
  return {
    condition,
    status: check.status,
    check,
    message: check.message ?? check.status,
  };
}

function evaluateReviewConsensus(
  condition: HitchCloseCondition,
  check: HitchCloseCheck | null,
  freshAfter: string | null,
  evidenceRows: readonly HitchEvidence[],
): EvaluatedCloseCondition {
  const checkIsFresh =
    check !== null && (freshAfter === null || check.checkedAt >= freshAfter);
  if (checkIsFresh) return evaluateRecordedCheck(condition, check, freshAfter);

  const evidence = evaluateReviewConsensusEvidenceRows(
    condition.id,
    freshAfter,
    evidenceRows,
  );
  if (evidence.status === "passed") {
    return {
      condition,
      status: "passed",
      check: null,
      message: `attached Codex review evidence accepted (${evidence.evidenceId})`,
    };
  }
  if (evidence.status === "blocked") {
    return {
      condition,
      status: "pending",
      check: null,
      message: `attached Codex review evidence rejected (${evidence.evidenceId}): ${evidence.reason}`,
    };
  }
  if (check !== null && !checkIsFresh) {
    return {
      condition,
      status: "pending",
      check,
      message:
        "review consensus close-check is stale; attach fresh Codex no-finding evidence or rerun review",
    };
  }
  return {
    condition,
    status: "pending",
    check: null,
    message:
      "no review consensus evidence recorded; attach Codex no-finding evidence or run review",
  };
}

/**
 * Deterministic facet_red_test gate (#279). Evaluated ONLY from the run's
 * changed paths (run_changed_files) and operator/runner-recorded RED evidence —
 * NEVER from any LLM/reviewer verdict. Fail-closed at every junction:
 * - unresolvable runId (null) / changedPaths empty input from a caller that
 *   could not resolve them => never passed;
 * - no recorded evidence row => pending;
 * - stale recorded evidence (older than freshAfter) => pending;
 * - malformed rule.facets => failed (a malformed contract must not pass);
 * - a facet whose production surface changed but has no covering test => failed
 *   (the fail-open shape the reviewer-depth gap let through).
 */
function evaluateFacetRedTest(
  condition: HitchCloseCondition,
  check: HitchCloseCheck | null,
  freshAfter: string | null,
  changedPaths: readonly string[],
  latestCodingRunId: string | null,
): EvaluatedCloseCondition {
  const parsed = parseFacetRule(condition.rule);
  if (parsed.errors.length > 0) {
    return {
      condition,
      status: "failed",
      check,
      message: `malformed facet_red_test contract: ${parsed.errors.join("; ")}`,
    };
  }
  if (latestCodingRunId === null || latestCodingRunId === "") {
    return {
      condition,
      status: "pending",
      check,
      message: "facet_red_test: no resolvable run to evaluate coverage against",
    };
  }
  // Stale recorded evidence is treated as ABSENT (fail-closed): a facet cannot
  // be satisfied by RED evidence older than the latest invalidating mutation.
  // The fail-open shape (production touched, no covering test) is still detected
  // deterministically from changedPaths even with no/stale evidence — that is
  // the depth gap #279 closes, and it does not depend on a recorded row.
  const evidenceIsFresh =
    check !== null &&
    (freshAfter === null || check.checkedAt >= freshAfter);
  const evidence = evidenceIsFresh
    ? parseFacetEvidence(check?.evidence ?? {})
    : [];
  const result = evaluateFacetRedCoverage({
    facets: parsed.facets,
    changedPaths,
    evidence,
    runId: latestCodingRunId,
  });
  // When NO fresh evidence row exists, a facet that merely lacks a RED
  // demonstration is RECOVERABLE (record evidence) → pending, not a hard fail.
  // A fail-open shape (production touched, no covering test) stays FAILED — it
  // needs a new run, not just evidence. A stale row also withholds the message
  // so the operator records fresh evidence.
  const status: HitchCloseCheckStatus = evidenceIsFresh
    ? result.status
    : downgradeMissingEvidenceToPending(result);
  // P2-2 (#308): expose, for a PENDING facet condition, whether it is
  // code-recoverable (a facet with no covering test → evidence alone can never
  // clear it → coder) or evidence-recoverable (covering test present, only the
  // RED evidence row is missing/stale → ask_human). Set only when pending.
  const facetPendingDisposition =
    status === "pending"
      ? facetPendingDispositionFor(result)
      : undefined;
  // P2-1 (#308): a fail-open-shape FAILURE and a code-recoverable PENDING facet
  // can both be cleared ONLY by adding a covering test — never by recording
  // evidence. So even when the only recorded row is STALE, preserve the
  // actionable "no covering test" message (`result.message`). The
  // stale/record-evidence message is reserved for the EVIDENCE-recoverable case
  // (covering test present, only the RED evidence row is missing/stale) — the
  // one place recording evidence can actually satisfy the facet. Keying off the
  // disposition keeps `message` always consistent with where the condition
  // routes, so the coder is never misdirected to record evidence that cannot
  // help. (`fail_open_shape` is a FAILED status → no disposition; it is
  // covered by the disposition-absent branch falling through to result.message.)
  const message =
    check !== null &&
    !evidenceIsFresh &&
    facetPendingDisposition === "evidence_recoverable"
      ? "facet_red_test: recorded evidence is stale; record fresh RED evidence after latest mutation"
      : result.message;
  return {
    condition,
    status,
    check,
    message,
    ...(facetPendingDisposition !== undefined ? { facetPendingDisposition } : {}),
  };
}

/**
 * Disposition of a PENDING facet condition (#308 P2-2). Code-recoverable when
 * any still-pending facet has NO covering test (reasonCode `no_change`): no
 * evidence row could ever satisfy it (`matchedTestPaths` is empty), so only a
 * code/test change can. Otherwise evidence-recoverable: every pending facet has
 * a covering test and merely lacks a fresh RED evidence row.
 */
function facetPendingDispositionFor(
  result: ReturnType<typeof evaluateFacetRedCoverage>,
): FacetPendingDisposition {
  const anyCodeRecoverable = result.perFacet.some(
    (f) => f.status !== "passed" && f.reasonCode === "no_change",
  );
  return anyCodeRecoverable ? "code_recoverable" : "evidence_recoverable";
}

/**
 * With no fresh evidence row, only the deterministic fail-open shape is a hard
 * FAIL; a facet that merely lacks a recorded RED demonstration is pending
 * (recoverable by recording evidence). Fail-closed: never upgrades to passed.
 */
function downgradeMissingEvidenceToPending(
  result: ReturnType<typeof evaluateFacetRedCoverage>,
): HitchCloseCheckStatus {
  if (result.perFacet.some((f) => f.reasonCode === "fail_open_shape")) {
    return "failed";
  }
  return result.perFacet.every((f) => f.status === "passed")
    ? "passed"
    : "pending";
}

function parseFacetEvidence(
  evidence: Record<string, unknown>,
): FacetRedEvidence[] {
  const raw = evidence.facets;
  if (!Array.isArray(raw)) return [];
  const parsed: FacetRedEvidence[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.facetId !== "string" || e.facetId === "") continue;
    if (typeof e.redTestPath !== "string" || e.redTestPath === "") continue;
    if (typeof e.runId !== "string" || e.runId === "") continue;
    // A non-boolean redDemonstrated never counts (fail-closed): coerce to a
    // strict boolean so only an explicit `true` can satisfy the facet.
    parsed.push({
      facetId: e.facetId,
      redTestPath: e.redTestPath,
      redDemonstrated: e.redDemonstrated === true,
      runId: e.runId,
      ...(typeof e.evidenceRef === "string"
        ? { evidenceRef: e.evidenceRef }
        : {}),
    });
  }
  return parsed;
}

interface ParsedEvidenceAttachedRule {
  kind?: HitchEvidenceKind;
  requiredMetricKeys?: string[];
  errors: string[];
}

/**
 * Parse the OPTIONAL `evidence_attached` rule. Both `kind` and
 * `requiredMetricKeys` are optional; unknown keys are ignored (forward-compat).
 * A malformed declared shape is a hard error so a broken contract fails closed
 * (never silently passes) — mirrors `parseFacetRule`.
 */
export function parseEvidenceAttachedRule(
  rule: Record<string, unknown> | undefined,
): ParsedEvidenceAttachedRule {
  const errors: string[] = [];
  const parsed: ParsedEvidenceAttachedRule = { errors };
  if (rule === undefined) {
    return parsed;
  }
  if (rule.kind !== undefined) {
    if (typeof rule.kind === "string" && HITCH_EVIDENCE_KIND_SET.has(rule.kind)) {
      parsed.kind = rule.kind as HitchEvidenceKind;
    } else {
      errors.push(`rule.kind is not a known evidence kind: ${String(rule.kind)}`);
    }
  }
  if (rule.requiredMetricKeys !== undefined) {
    const raw = rule.requiredMetricKeys;
    if (
      Array.isArray(raw) &&
      raw.every((key) => typeof key === "string" && key !== "")
    ) {
      parsed.requiredMetricKeys = raw as string[];
    } else {
      errors.push("rule.requiredMetricKeys must be an array of non-empty strings");
    }
  }
  return parsed;
}

/**
 * Deterministic `evidence_attached` attestation gate (#91 Stage B). PASS is
 * derived ONLY from row existence + provenance + freshness + declared-shape
 * match — NEVER from any recorded `check.status`/verdict (no self-report). Like
 * `evaluateFindingPolicy`, `check` is always null: evidence lives in the
 * `hitch_evidence` table, not `hitch_close_checks`. Fail-closed at every
 * junction:
 * - malformed rule => failed (a broken contract must not pass);
 * - no candidate row (operator-attested, condition-scoped, declared-shape match)
 *   => pending;
 * - every candidate stale (older than freshAfter) => pending;
 * - never passed on missing/ambiguous input.
 * Provenance is re-verified in code (`row.attester === "operator"`); the DDL
 * CHECK is not trusted alone (defense-in-depth against a future/forged writer).
 */
function evaluateEvidenceAttached(
  condition: HitchCloseCondition,
  evidenceRows: readonly HitchEvidence[],
  freshAfter: string | null,
): EvaluatedCloseCondition {
  const parsed = parseEvidenceAttachedRule(condition.rule);
  if (parsed.errors.length > 0) {
    return {
      condition,
      status: "failed",
      check: null,
      message: `malformed evidence_attached contract: ${parsed.errors.join("; ")}`,
    };
  }
  const candidates = evidenceRows.filter(
    (row) =>
      row.attester === "operator" &&
      row.conditionId === condition.id &&
      (parsed.kind === undefined || row.kind === parsed.kind) &&
      (parsed.requiredMetricKeys === undefined ||
        parsed.requiredMetricKeys.every((key) =>
          Object.prototype.hasOwnProperty.call(row.summaryMetrics, key),
        )),
  );
  if (candidates.length === 0) {
    return {
      condition,
      status: "pending",
      check: null,
      message: "no operator evidence attached for this condition",
    };
  }
  const hasFresh = candidates.some(
    (row) => freshAfter === null || row.createdAt >= freshAfter,
  );
  if (!hasFresh) {
    return {
      condition,
      status: "pending",
      check: null,
      message:
        "attached evidence is stale; record fresh evidence after latest mutation",
    };
  }
  return {
    condition,
    status: "passed",
    check: null,
    message: "operator evidence attached",
  };
}

function evaluateFindingPolicy(
  condition: HitchCloseCondition,
  counts: FindingPolicyCounts,
): EvaluatedCloseCondition {
  const rule = condition.rule ?? {};

  const checks: Array<[string, number, number]> = [
    [
      "maxOpenInScopeP0",
      numberRule(rule.maxOpenInScopeP0, Number.POSITIVE_INFINITY),
      counts.openInScopeP0,
    ],
    [
      "maxOpenInScopeP1",
      numberRule(rule.maxOpenInScopeP1, Number.POSITIVE_INFINITY),
      counts.openInScopeP1,
    ],
    [
      "maxOpenInScopeP2",
      numberRule(rule.maxOpenInScopeP2, Number.POSITIVE_INFINITY),
      counts.openInScopeP2,
    ],
    [
      "maxOpenUnknownScope",
      numberRule(rule.maxOpenUnknownScope, Number.POSITIVE_INFINITY),
      counts.openUnknownScope,
    ],
  ];
  const failed = checks.filter(([, max, actual]) => actual > max);
  return {
    condition,
    status: failed.length === 0 ? "passed" : "failed",
    check: null,
    message:
      failed.length === 0
        ? "finding policy passed"
        : failed
            .map(([name, max, actual]) => `${name}: ${actual} > ${max}`)
            .join("; "),
  };
}

function numberRule(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}
