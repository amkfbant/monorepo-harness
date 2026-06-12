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
] as const;

export type HitchLifecycleEventName = (typeof HITCH_LIFECYCLE_EVENTS)[number];

export const HITCH_NEXT_ACTION_KINDS = [
  "fix_findings",
  "classify_findings",
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

export type HitchCloseConditionKind =
  | "command"
  | "finding_policy"
  | "manual"
  | "operation_status"
  | "db_doctor"
  | "review_consensus"
  | "artifact_exists";

export interface HitchCloseCondition {
  id: string;
  kind: HitchCloseConditionKind;
  required: boolean;
  description?: string;
  command?: string;
  rule?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface HitchDivergencePolicy {
  maxNewFindingsPerCycle: number;
  maxTotalNewFindings: number;
  requireNewFindingsDecreaseAfterCycle: number;
  maxReopenedPerFinding: number;
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

export interface HitchNextAction {
  kind: HitchNextActionKind;
  /** Advisory context for operators; convergence may truncate this list. */
  findingIds?: string[];
  message: string;
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
