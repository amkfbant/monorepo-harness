import type { HitchDecisionPacket } from "./jury/types.js";

export const HITCH_STATUSES = [
  "open",
  "in_progress",
  "close_ready",
  "closed",
  "diverging",
  "budget_exhausted",
  "escalated",
  "cancelled",
] as const;

export type HitchStatus = (typeof HITCH_STATUSES)[number];

export const HITCH_CREATED_SOURCES = [
  "cli",
  "mcp",
  "dashboard",
  "worker",
  "import",
] as const;

export type HitchCreatedSource = (typeof HITCH_CREATED_SOURCES)[number];

export const HITCH_ATTEMPT_TYPES = [
  "plan",
  "implement",
  "fix-review",
  "rerun",
  "validate",
  "close-check",
  "classify-findings",
  "defer-followups",
] as const;

export type HitchAttemptType = (typeof HITCH_ATTEMPT_TYPES)[number];

export const HITCH_ATTEMPT_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type HitchAttemptStatus = (typeof HITCH_ATTEMPT_STATUSES)[number];

export const HITCH_REVIEW_MODES = [
  "initial",
  "delta",
  "close",
  "regression",
  "manual",
] as const;

export type HitchReviewMode = (typeof HITCH_REVIEW_MODES)[number];

export const HITCH_FINDING_SOURCES = [
  "review",
  "test",
  "doctor",
  "human",
  "mcp",
  "codex",
  "other",
] as const;

export type HitchFindingSource = (typeof HITCH_FINDING_SOURCES)[number];

export const OPERATOR_ORIGIN_FINDING_SOURCES = [
  "human",
  "mcp",
] as const satisfies readonly HitchFindingSource[];

export const HARNESS_ORIGIN_FINDING_SOURCES = [
  "review",
  "test",
  "doctor",
  "codex",
  "other",
] as const satisfies readonly HitchFindingSource[];

export const HARNESS_ORIGIN_FINDING_SOURCE_SET = new Set<HitchFindingSource>(
  HARNESS_ORIGIN_FINDING_SOURCES,
);

// Non-actionable advisory review categories (assigned deterministically by the
// harness in review-integration.ts, never self-reported by an LLM). These rows
// are RECORDED as findings (operator-visible, classified out_of_scope) but MUST
// NOT inflate the harness-origin divergence churn counter (#283): an
// approval/positive advisory comment materialized as a `review-non-blocking-
// comment` (or `review-out-of-scope-suggestion`) row could otherwise push
// `harnessOriginNewFindingsByCycle` to a non-decreasing sequence and trip a
// FALSE `diverging` on reopen. The blocking categories `review-required-change`
// and `review-negative-decision` are deliberately EXCLUDED from this set so real
// blockers still drive divergence (and still block close) — fail-closed.
export const ADVISORY_REVIEW_FINDING_CATEGORIES = [
  "review-non-blocking-comment",
  "review-out-of-scope-suggestion",
] as const;

export const ADVISORY_REVIEW_FINDING_CATEGORY_SET = new Set<string>(
  ADVISORY_REVIEW_FINDING_CATEGORIES,
);

// Review-BLOCKING finding categories the harness emits deterministically FROM A
// REVIEW PROPOSAL (review-integration.ts). These are the only categories a later
// APPROVING review cycle deterministically retires as superseded (#278): when the
// canonical review decision is `approved`, prior OPEN in-scope review-origin rows
// in these categories from EARLIER cycles are auto-resolved to `fixed`. The set is
// shared by the emission site and the auto-resolve trigger so the two cannot drift.
// NOTE: this is NOT the simple complement of ADVISORY_REVIEW_FINDING_CATEGORIES
// within source='review'. The externally-ingested `external-review-changes-requested`
// blocker (orchestrator-runners.ts, a third source='review' P1 category) is in
// NEITHER set and is deliberately NOT auto-resolved — an internal review approve
// must never retire an external human reviewer's blocking verdict (fail-closed).
export const REVIEW_BLOCKING_FINDING_CATEGORIES = [
  "review-required-change",
  "review-negative-decision",
] as const;

export const REVIEW_BLOCKING_FINDING_CATEGORY_SET = new Set<string>(
  REVIEW_BLOCKING_FINDING_CATEGORIES,
);

// Compile-time guard: every HitchFindingSource MUST be classified as either
// operator-origin or harness-origin. An unclassified source would silently
// drop out of divergence accounting (fail-open of the safety circuit-breaker,
// #196), so adding a source without classifying it must fail typecheck.
type UnclassifiedFindingSource = Exclude<
  HitchFindingSource,
  | (typeof OPERATOR_ORIGIN_FINDING_SOURCES)[number]
  | (typeof HARNESS_ORIGIN_FINDING_SOURCES)[number]
>;
const _assertAllFindingSourcesClassified: UnclassifiedFindingSource extends never
  ? true
  : never = true;
void _assertAllFindingSourcesClassified;

export const HITCH_FINDING_SEVERITIES = [
  "P0",
  "P1",
  "P2",
  "P3",
  "info",
] as const;

export type HitchFindingSeverity = (typeof HITCH_FINDING_SEVERITIES)[number];

export const HITCH_SCOPE_STATUSES = [
  "in_scope",
  "out_of_scope",
  "unknown",
  "duplicate",
] as const;

export type HitchScopeStatus = (typeof HITCH_SCOPE_STATUSES)[number];

export const HITCH_LIFECYCLE_STATUSES = [
  "open",
  "fixed",
  "reopened",
  "deferred",
  "duplicate",
  "out_of_scope",
  "escalated",
  "accepted_risk",
] as const;

export type HitchLifecycleStatus = (typeof HITCH_LIFECYCLE_STATUSES)[number];

export const HITCH_CLOSE_CHECK_STATUSES = [
  "pending",
  "passed",
  "failed",
  "skipped",
  "unknown",
] as const;

export type HitchCloseCheckStatus =
  (typeof HITCH_CLOSE_CHECK_STATUSES)[number];

export const HITCH_CONVERGENCE_DECISIONS = [
  "continue",
  "needs_fix",
  "needs_classification",
  "close_ready",
  "closed",
  "diverging",
  "budget_exhausted",
  "escalate",
  "cancel",
] as const;

export type HitchConvergenceDecision =
  (typeof HITCH_CONVERGENCE_DECISIONS)[number];

export const HITCH_LIFECYCLE_EVENTS = [
  "reopened",
  "closed",
  "cancelled",
  "pr_adopted",
  "updated",
  "diverging_recovered",
] as const;

export type HitchLifecycleEventName = (typeof HITCH_LIFECYCLE_EVENTS)[number];

export const HITCH_NEXT_ACTION_KINDS = [
  "fix_findings",
  "classify_findings",
  "run_review",
  "run_close_check",
  "defer_followups",
  "close_hitch",
  "ask_human",
] as const;

export type HitchNextActionKind = (typeof HITCH_NEXT_ACTION_KINDS)[number];

export interface HitchScope {
  targetFiles?: string[];
  targetOperations?: string[];
  allowedFindingCategories?: string[];
  excludedCategories?: string[];
  notes?: string;
  targetSummary?: string;
}

export const HITCH_CLOSE_CONDITION_KINDS = [
  "command",
  "finding_policy",
  "manual",
  "operation_status",
  "db_doctor",
  "review_consensus",
  "artifact_exists",
  "facet_red_test",
  "evidence_attached",
] as const;

export type HitchCloseConditionKind =
  (typeof HITCH_CLOSE_CONDITION_KINDS)[number];

export interface HitchCloseCondition {
  id: string;
  kind: HitchCloseConditionKind;
  required: boolean;
  description?: string;
  command?: string;
  rule?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type HitchValidationIssueSeverity = "hard" | "advisory";

export interface HitchValidationIssue {
  severity: HitchValidationIssueSeverity;
  code: string;
  message: string;
  path: string;
  conditionId?: string;
  conditionIndex?: number;
  kind?: HitchCloseConditionKind;
  category?: "auto-verify" | "external-evidence";
}

export class HitchValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly HitchValidationIssue[],
  ) {
    super(message);
    this.name = "HitchValidationError";
  }
}

export interface HitchDivergencePolicy {
  maxNewFindingsPerCycle: number;
  maxTotalNewFindings: number;
  requireNewFindingsDecreaseAfterCycle: number;
  maxReopenedPerFinding: number;
  nearDuplicateDedup: boolean;
}

export interface HitchPolicy {
  autoFixSeverities: HitchFindingSeverity[];
  deferSeverities: HitchFindingSeverity[];
  autoFixOnlyInScope: boolean;
  deferOutOfScope: boolean;
  stopOnUnknownScope: boolean;
  allowEmptyCloseConditions: boolean;
  reviewModeSequence: HitchReviewMode[];
  divergence: HitchDivergencePolicy;
  closeRequires: {
    noOpenInScopeP0: boolean;
    noOpenInScopeP1: boolean;
    noUnknownScope: boolean;
    maxOpenInScopeP2?: number;
  };
}

export const DEFAULT_HITCH_POLICY: HitchPolicy = {
  autoFixSeverities: ["P1"],
  deferSeverities: ["P2", "P3"],
  autoFixOnlyInScope: true,
  deferOutOfScope: true,
  stopOnUnknownScope: true,
  allowEmptyCloseConditions: false,
  reviewModeSequence: ["initial", "delta", "close"],
  divergence: {
    maxNewFindingsPerCycle: 5,
    maxTotalNewFindings: 12,
    requireNewFindingsDecreaseAfterCycle: 2,
    maxReopenedPerFinding: 2,
    nearDuplicateDedup: true,
  },
  closeRequires: {
    noOpenInScopeP0: true,
    noOpenInScopeP1: true,
    noUnknownScope: true,
  },
};

export interface HitchSession {
  hitchId: string;
  title: string;
  description: string | null;
  projectId: string | null;
  repoId: string | null;
  domain: string | null;
  backlogItemId: string | null;
  status: HitchStatus;
  scope: HitchScope;
  closeConditions: HitchCloseCondition[];
  policy: HitchPolicy;
  maxIterations: number;
  maxReviewCycles: number;
  maxReruns: number;
  maxTotalNewFindings: number;
  currentIteration: number;
  currentReviewCycle: number;
  createdBy: string;
  createdSource: HitchCreatedSource;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeSummary: string | null;
  escalationReason: string | null;
}

export interface HitchAttempt {
  attemptId: string;
  hitchId: string;
  iteration: number;
  attemptType: HitchAttemptType;
  status: HitchAttemptStatus;
  operationId: string | null;
  runId: string | null;
  parentAttemptId: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface HitchReviewCycle {
  cycleId: string;
  hitchId: string;
  cycleNumber: number;
  reviewMode: HitchReviewMode;
  triggerAttemptId: string | null;
  sourceReviewId: string | null;
  sourceRunId: string | null;
  findingsSeen: number;
  findingsNew: number;
  findingsReopened: number;
  findingsFixed: number;
  findingsDeferred: number;
  findingsInScopeOpen: number;
  createdAt: string;
  completedAt: string | null;
  summary: string | null;
}

export interface HitchFinding {
  findingId: string;
  hitchId: string;
  stableKey: string;
  duplicateOf: string | null;
  source: HitchFindingSource;
  sourceRef: string | null;
  sourceAttemptId: string | null;
  sourceCycleId: string | null;
  severity: HitchFindingSeverity;
  category: string;
  scopeStatus: HitchScopeStatus;
  lifecycleStatus: HitchLifecycleStatus;
  summary: string;
  detail: string | null;
  filePath: string | null;
  symbol: string | null;
  suggestedFix: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  fixedAt: string | null;
  deferredAt: string | null;
  escalatedAt: string | null;
  reopenCount: number;
  deferredBacklogItemId: string | null;
  deferredIssueUrl: string | null;
  classificationReason: string | null;
  resolutionNote: string | null;
}

export interface HitchCloseCheck {
  checkId: string;
  hitchId: string;
  conditionId: string;
  status: HitchCloseCheckStatus;
  checkedAt: string;
  checkedBy: string;
  evidence: Record<string, unknown>;
  message: string | null;
}

// #91 Stage A — evidence attached to a hitch (#91).
export const HITCH_EVIDENCE_KINDS = [
  "command",
  "metrics",
  "before_after",
  "transcript",
  "note",
] as const;

export type HitchEvidenceKind = (typeof HITCH_EVIDENCE_KINDS)[number];

// Stage A (#91): operator-attested evidence ONLY. The single writer
// (`attachHitchEvidence`) hardcode-stamps `'operator'`; there is no agent /
// harness writer yet, so BOTH this type and the DB CHECK are operator-only —
// fail-closed defense-in-depth so the Stage B close-gate cannot be satisfied by
// a non-operator-attested row. A future stage with a genuine hardcode-stamped
// non-operator writer widens both this list and the CHECK via a new migration.
export const EVIDENCE_ATTESTERS = ["operator"] as const;

export type EvidenceAttester = (typeof EVIDENCE_ATTESTERS)[number];

export interface HitchEvidence {
  evidenceId: string;
  hitchId: string;
  runId: string | null;
  conditionId: string | null;
  kind: HitchEvidenceKind;
  attester: EvidenceAttester;
  label: string;
  command: string | null;
  exitCode: number | null;
  /** Parsed from `summary_metrics_json` column (stored as JSON string). */
  summaryMetrics: Record<string, unknown>;
  metricsSchema: number;
  outputExcerpt: string | null;
  /** Stored as INTEGER 0/1 in DB; boolean on this interface. */
  secretSuspect: boolean;
  /** Stored as INTEGER 0/1 in DB; boolean on this interface. */
  redacted: boolean;
  createdAt: string;
}

export interface HitchNextAction {
  kind: HitchNextActionKind;
  /** Advisory context for operators; convergence may truncate this list. */
  findingIds?: string[];
  message: string;
  /**
   * Optional consultant-grade MCDA decision packet (#230, design §5.2 v2).
   * Additive: present only on jury escalate / non-escalating severity records.
   * Typed via `import type` to avoid a runtime circular import between
   * hitch/types.ts and hitch/jury/types.ts.
   */
  decisionPacket?: HitchDecisionPacket;
}

export interface HitchConvergenceMetrics {
  openInScopeP0: number;
  openInScopeP1: number;
  openInScopeP2: number;
  openUnknownScope: number;
  openOutOfScope: number;
  totalNewFindings: number;
  newFindingsThisCycle: number;
  reviewCyclesUsed: number;
  iterationsUsed: number;
  rerunsUsed: number;
  closeConditionsPassed: number;
  closeConditionsFailed: number;
  closeConditionsPending: number;
  maxReopenCount: number;
  harnessOriginNewFindings: number;
  harnessOriginNewFindingsThisCycle: number;
  harnessOriginMaxReopenCount: number;
  harnessOriginNewFindingsByCycle: HitchConvergenceCycleFindingCount[];
}

export interface HitchConvergenceCycleFindingCount {
  cycleId: string;
  cycleNumber: number;
  findingsNew: number;
}

export interface HitchHarnessOriginDivergenceMetrics {
  harnessOriginNewFindings: number;
  harnessOriginMaxReopenCount: number;
  harnessOriginNewFindingsByCycle: HitchConvergenceCycleFindingCount[];
}

export interface HitchConvergenceResult {
  hitchId: string;
  decision: HitchConvergenceDecision;
  reason: string;
  metrics: HitchConvergenceMetrics;
  recommendedNextAction: HitchNextAction;
}

export interface HitchConvergenceDecisionRecord {
  decisionId: string;
  hitchId: string;
  cycleId: string | null;
  attemptId: string | null;
  decision: HitchConvergenceDecision;
  reason: string;
  metrics: Record<string, unknown>;
  recommendedNextAction: HitchNextAction | null;
  createdAt: string;
  createdBy: string;
}

export interface HitchLifecycleEvent {
  eventId: string;
  hitchId: string;
  event: HitchLifecycleEventName;
  reason: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
  createdBy: string;
}
