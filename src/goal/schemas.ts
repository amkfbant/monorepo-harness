import { z } from "zod";
import {
  DEFAULT_GOAL_POLICY,
  GOAL_ATTEMPT_STATUSES,
  GOAL_ATTEMPT_TYPES,
  GOAL_CLOSE_CHECK_STATUSES,
  GOAL_CONVERGENCE_DECISIONS,
  GOAL_CREATED_SOURCES,
  GOAL_FINDING_SEVERITIES,
  GOAL_FINDING_SOURCES,
  GOAL_LIFECYCLE_STATUSES,
  GOAL_REVIEW_MODES,
  GOAL_SCOPE_STATUSES,
  GOAL_STATUSES,
  type GoalCloseCondition,
  type GoalPolicy,
  type GoalScope,
} from "./types.js";

const stringArray = z.array(z.string().min(1));

export const GoalStatusSchema = z.enum(GOAL_STATUSES);
export const GoalCreatedSourceSchema = z.enum(GOAL_CREATED_SOURCES);
export const GoalAttemptTypeSchema = z.enum(GOAL_ATTEMPT_TYPES);
export const GoalAttemptStatusSchema = z.enum(GOAL_ATTEMPT_STATUSES);
export const GoalReviewModeSchema = z.enum(GOAL_REVIEW_MODES);
export const GoalFindingSourceSchema = z.enum(GOAL_FINDING_SOURCES);
export const GoalFindingSeveritySchema = z.enum(GOAL_FINDING_SEVERITIES);
export const GoalScopeStatusSchema = z.enum(GOAL_SCOPE_STATUSES);
export const GoalLifecycleStatusSchema = z.enum(GOAL_LIFECYCLE_STATUSES);
export const GoalCloseCheckStatusSchema = z.enum(GOAL_CLOSE_CHECK_STATUSES);
export const GoalConvergenceDecisionSchema = z.enum(
  GOAL_CONVERGENCE_DECISIONS,
);

export const GoalScopeSchema = z
  .object({
    targetFiles: stringArray.optional(),
    targetOperations: stringArray.optional(),
    allowedFindingCategories: stringArray.optional(),
    excludedCategories: stringArray.optional(),
    notes: z.string().optional(),
    targetSummary: z.string().optional(),
  })
  .strict();

export const GoalCloseConditionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "command",
      "finding_policy",
      "manual",
      "operation_status",
      "db_doctor",
      "review_consensus",
      "artifact_exists",
    ]),
    required: z.boolean().default(true),
    description: z.string().optional(),
    command: z.string().optional(),
    rule: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const GoalCloseConditionsSchema = z.array(GoalCloseConditionSchema);

export const GoalPolicySchema = z
  .object({
    autoFixSeverities: z.array(GoalFindingSeveritySchema).default(
      DEFAULT_GOAL_POLICY.autoFixSeverities,
    ),
    deferSeverities: z.array(GoalFindingSeveritySchema).default(
      DEFAULT_GOAL_POLICY.deferSeverities,
    ),
    autoFixOnlyInScope: z
      .boolean()
      .default(DEFAULT_GOAL_POLICY.autoFixOnlyInScope),
    deferOutOfScope: z.boolean().default(DEFAULT_GOAL_POLICY.deferOutOfScope),
    stopOnUnknownScope: z
      .boolean()
      .default(DEFAULT_GOAL_POLICY.stopOnUnknownScope),
    allowEmptyCloseConditions: z
      .boolean()
      .default(DEFAULT_GOAL_POLICY.allowEmptyCloseConditions),
    reviewModeSequence: z.array(GoalReviewModeSchema).default(
      DEFAULT_GOAL_POLICY.reviewModeSequence,
    ),
    divergence: z
      .object({
        maxNewFindingsPerCycle: z
          .number()
          .int()
          .min(0)
          .default(
            DEFAULT_GOAL_POLICY.divergence.maxNewFindingsPerCycle,
          ),
        maxTotalNewFindings: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_GOAL_POLICY.divergence.maxTotalNewFindings),
        requireNewFindingsDecreaseAfterCycle: z
          .number()
          .int()
          .min(0)
          .default(
            DEFAULT_GOAL_POLICY.divergence
              .requireNewFindingsDecreaseAfterCycle,
          ),
        maxReopenedPerFinding: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_GOAL_POLICY.divergence.maxReopenedPerFinding),
      })
      .default(DEFAULT_GOAL_POLICY.divergence),
    closeRequires: z
      .object({
        noOpenInScopeP0: z
          .boolean()
          .default(DEFAULT_GOAL_POLICY.closeRequires.noOpenInScopeP0),
        noOpenInScopeP1: z
          .boolean()
          .default(DEFAULT_GOAL_POLICY.closeRequires.noOpenInScopeP1),
        noUnknownScope: z
          .boolean()
          .default(DEFAULT_GOAL_POLICY.closeRequires.noUnknownScope),
        maxOpenInScopeP2: z.number().int().min(0).optional(),
      })
      .default(DEFAULT_GOAL_POLICY.closeRequires),
  })
  .strict();

export function parseGoalScope(value: unknown): GoalScope {
  return GoalScopeSchema.parse(value ?? {}) as GoalScope;
}

export function parseGoalCloseConditions(
  value: unknown,
): GoalCloseCondition[] {
  return GoalCloseConditionsSchema.parse(value ?? []) as GoalCloseCondition[];
}

export function parseGoalPolicy(value: unknown): GoalPolicy {
  return GoalPolicySchema.parse(value ?? {}) as GoalPolicy;
}
