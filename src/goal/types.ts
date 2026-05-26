export const GOAL_STATUSES = [
  "open",
  "in_progress",
  "close_ready",
  "closed",
  "diverging",
  "budget_exhausted",
  "escalated",
  "cancelled",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_CREATED_SOURCES = [
  "cli",
  "mcp",
  "dashboard",
  "worker",
  "import",
] as const;

export type GoalCreatedSource = (typeof GOAL_CREATED_SOURCES)[number];

export const GOAL_ATTEMPT_TYPES = [
  "plan",
  "implement",
  "fix-review",
  "rerun",
  "validate",
  "close-check",
  "classify-findings",
  "defer-followups",
] as const;

export type GoalAttemptType = (typeof GOAL_ATTEMPT_TYPES)[number];

export const GOAL_ATTEMPT_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type GoalAttemptStatus = (typeof GOAL_ATTEMPT_STATUSES)[number];

export const GOAL_REVIEW_MODES = [
  "initial",
  "delta",
  "close",
  "regression",
  "manual",
] as const;

export type GoalReviewMode = (typeof GOAL_REVIEW_MODES)[number];

export const GOAL_FINDING_SOURCES = [
  "review",
  "test",
  "doctor",
  "human",
  "mcp",
  "codex",
  "other",
] as const;

export type GoalFindingSource = (typeof GOAL_FINDING_SOURCES)[number];

export const GOAL_FINDING_SEVERITIES = [
  "P0",
  "P1",
  "P2",
  "P3",
  "info",
] as const;

export type GoalFindingSeverity = (typeof GOAL_FINDING_SEVERITIES)[number];

export const GOAL_SCOPE_STATUSES = [
  "in_scope",
  "out_of_scope",
  "unknown",
  "duplicate",
] as const;

export type GoalScopeStatus = (typeof GOAL_SCOPE_STATUSES)[number];

export const GOAL_LIFECYCLE_STATUSES = [
  "open",
  "fixed",
  "reopened",
  "deferred",
  "duplicate",
  "out_of_scope",
  "escalated",
  "accepted_risk",
] as const;

export type GoalLifecycleStatus = (typeof GOAL_LIFECYCLE_STATUSES)[number];

export const GOAL_CLOSE_CHECK_STATUSES = [
  "pending",
  "passed",
  "failed",
  "skipped",
  "unknown",
] as const;

export type GoalCloseCheckStatus =
  (typeof GOAL_CLOSE_CHECK_STATUSES)[number];

export const GOAL_CONVERGENCE_DECISIONS = [
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

export type GoalConvergenceDecision =
  (typeof GOAL_CONVERGENCE_DECISIONS)[number];

export const GOAL_NEXT_ACTION_KINDS = [
  "fix_findings",
  "classify_findings",
  "run_close_check",
  "defer_followups",
  "close_goal",
  "ask_human",
] as const;

export type GoalNextActionKind = (typeof GOAL_NEXT_ACTION_KINDS)[number];

export interface GoalScope {
  targetFiles?: string[];
  targetOperations?: string[];
  allowedFindingCategories?: string[];
  excludedCategories?: string[];
  notes?: string;
  targetSummary?: string;
}

export type GoalCloseConditionKind =
  | "command"
  | "finding_policy"
  | "manual"
  | "operation_status"
  | "db_doctor"
  | "review_consensus"
  | "artifact_exists";

export interface GoalCloseCondition {
  id: string;
  kind: GoalCloseConditionKind;
  required: boolean;
  description?: string;
  command?: string;
  rule?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface GoalDivergencePolicy {
  maxNewFindingsPerCycle: number;
  maxTotalNewFindings: number;
  requireNewFindingsDecreaseAfterCycle: number;
  maxReopenedPerFinding: number;
}

export interface GoalPolicy {
  autoFixSeverities: GoalFindingSeverity[];
  deferSeverities: GoalFindingSeverity[];
  autoFixOnlyInScope: boolean;
  deferOutOfScope: boolean;
  stopOnUnknownScope: boolean;
  reviewModeSequence: GoalReviewMode[];
  divergence: GoalDivergencePolicy;
  closeRequires: {
    noOpenInScopeP0: boolean;
    noOpenInScopeP1: boolean;
    noUnknownScope: boolean;
    maxOpenInScopeP2?: number;
  };
}

export const DEFAULT_GOAL_POLICY: GoalPolicy = {
  autoFixSeverities: ["P1"],
  deferSeverities: ["P2", "P3"],
  autoFixOnlyInScope: true,
  deferOutOfScope: true,
  stopOnUnknownScope: true,
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

export interface GoalSession {
  goalId: string;
  title: string;
  description: string | null;
  projectId: string | null;
  repoId: string | null;
  domain: string | null;
  backlogItemId: string | null;
  status: GoalStatus;
  scope: GoalScope;
  closeConditions: GoalCloseCondition[];
  policy: GoalPolicy;
  maxIterations: number;
  maxReviewCycles: number;
  maxReruns: number;
  maxTotalNewFindings: number;
  currentIteration: number;
  currentReviewCycle: number;
  createdBy: string;
  createdSource: GoalCreatedSource;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeSummary: string | null;
  escalationReason: string | null;
}

export interface GoalAttempt {
  attemptId: string;
  goalId: string;
  iteration: number;
  attemptType: GoalAttemptType;
  status: GoalAttemptStatus;
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

export interface GoalReviewCycle {
  cycleId: string;
  goalId: string;
  cycleNumber: number;
  reviewMode: GoalReviewMode;
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

export interface GoalFinding {
  findingId: string;
  goalId: string;
  stableKey: string;
  duplicateOf: string | null;
  source: GoalFindingSource;
  sourceRef: string | null;
  sourceAttemptId: string | null;
  sourceCycleId: string | null;
  severity: GoalFindingSeverity;
  category: string;
  scopeStatus: GoalScopeStatus;
  lifecycleStatus: GoalLifecycleStatus;
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

export interface GoalCloseCheck {
  checkId: string;
  goalId: string;
  conditionId: string;
  status: GoalCloseCheckStatus;
  checkedAt: string;
  checkedBy: string;
  evidence: Record<string, unknown>;
  message: string | null;
}

export interface GoalNextAction {
  kind: GoalNextActionKind;
  findingIds?: string[];
  message: string;
}

export interface GoalConvergenceMetrics {
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

export interface GoalConvergenceResult {
  goalId: string;
  decision: GoalConvergenceDecision;
  reason: string;
  metrics: GoalConvergenceMetrics;
  recommendedNextAction: GoalNextAction;
}

export interface GoalConvergenceDecisionRecord {
  decisionId: string;
  goalId: string;
  cycleId: string | null;
  attemptId: string | null;
  decision: GoalConvergenceDecision;
  reason: string;
  metrics: Record<string, unknown>;
  recommendedNextAction: GoalNextAction | null;
  createdAt: string;
  createdBy: string;
}
