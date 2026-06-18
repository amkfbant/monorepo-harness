import { z } from "zod";
import {
  DEFAULT_HITCH_POLICY,
  HITCH_ATTEMPT_STATUSES,
  HITCH_ATTEMPT_TYPES,
  HITCH_CLOSE_CONDITION_KINDS,
  HITCH_CLOSE_CHECK_STATUSES,
  HITCH_CONVERGENCE_DECISIONS,
  HITCH_CREATED_SOURCES,
  HITCH_FINDING_SEVERITIES,
  HITCH_FINDING_SOURCES,
  HITCH_LIFECYCLE_STATUSES,
  HITCH_REVIEW_MODES,
  HITCH_SCOPE_STATUSES,
  HITCH_STATUSES,
  type HitchCloseCondition,
  type HitchPolicy,
  type HitchScope,
} from "./types.js";

const stringArray = z.array(z.string().min(1));

export const HitchStatusSchema = z.enum(HITCH_STATUSES);
export const HitchCreatedSourceSchema = z.enum(HITCH_CREATED_SOURCES);
export const HitchAttemptTypeSchema = z.enum(HITCH_ATTEMPT_TYPES);
export const HitchAttemptStatusSchema = z.enum(HITCH_ATTEMPT_STATUSES);
export const HitchReviewModeSchema = z.enum(HITCH_REVIEW_MODES);
export const HitchFindingSourceSchema = z.enum(HITCH_FINDING_SOURCES);
export const HitchFindingSeveritySchema = z.enum(HITCH_FINDING_SEVERITIES);
export const HitchScopeStatusSchema = z.enum(HITCH_SCOPE_STATUSES);
export const HitchLifecycleStatusSchema = z.enum(HITCH_LIFECYCLE_STATUSES);
export const HitchCloseCheckStatusSchema = z.enum(HITCH_CLOSE_CHECK_STATUSES);
export const HitchConvergenceDecisionSchema = z.enum(
  HITCH_CONVERGENCE_DECISIONS,
);

export const HitchScopeSchema = z
  .object({
    targetFiles: stringArray.optional(),
    targetOperations: stringArray.optional(),
    allowedFindingCategories: stringArray.optional(),
    excludedCategories: stringArray.optional(),
    notes: z.string().optional(),
    targetSummary: z.string().optional(),
  })
  .strict();

export const HitchCloseConditionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(HITCH_CLOSE_CONDITION_KINDS),
    required: z.boolean().default(true),
    description: z.string().optional(),
    command: z.string().optional(),
    rule: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const HitchCloseConditionsSchema = z.array(HitchCloseConditionSchema);

export const HitchPolicySchema = z
  .object({
    autoFixSeverities: z.array(HitchFindingSeveritySchema).default(
      DEFAULT_HITCH_POLICY.autoFixSeverities,
    ),
    deferSeverities: z.array(HitchFindingSeveritySchema).default(
      DEFAULT_HITCH_POLICY.deferSeverities,
    ),
    autoFixOnlyInScope: z
      .boolean()
      .default(DEFAULT_HITCH_POLICY.autoFixOnlyInScope),
    deferOutOfScope: z.boolean().default(DEFAULT_HITCH_POLICY.deferOutOfScope),
    stopOnUnknownScope: z
      .boolean()
      .default(DEFAULT_HITCH_POLICY.stopOnUnknownScope),
    allowEmptyCloseConditions: z
      .boolean()
      .default(DEFAULT_HITCH_POLICY.allowEmptyCloseConditions),
    reviewModeSequence: z.array(HitchReviewModeSchema).default(
      DEFAULT_HITCH_POLICY.reviewModeSequence,
    ),
    divergence: z
      .object({
        maxNewFindingsPerCycle: z
          .number()
          .int()
          .min(0)
          .default(
            DEFAULT_HITCH_POLICY.divergence.maxNewFindingsPerCycle,
          ),
        maxTotalNewFindings: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_HITCH_POLICY.divergence.maxTotalNewFindings),
        requireNewFindingsDecreaseAfterCycle: z
          .number()
          .int()
          .min(0)
          .default(
            DEFAULT_HITCH_POLICY.divergence
              .requireNewFindingsDecreaseAfterCycle,
          ),
        maxReopenedPerFinding: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_HITCH_POLICY.divergence.maxReopenedPerFinding),
        nearDuplicateDedup: z
          .boolean()
          .default(DEFAULT_HITCH_POLICY.divergence.nearDuplicateDedup),
      })
      .default(DEFAULT_HITCH_POLICY.divergence),
    closeRequires: z
      .object({
        noOpenInScopeP0: z
          .boolean()
          .default(DEFAULT_HITCH_POLICY.closeRequires.noOpenInScopeP0),
        noOpenInScopeP1: z
          .boolean()
          .default(DEFAULT_HITCH_POLICY.closeRequires.noOpenInScopeP1),
        noUnknownScope: z
          .boolean()
          .default(DEFAULT_HITCH_POLICY.closeRequires.noUnknownScope),
        maxOpenInScopeP2: z.number().int().min(0).optional(),
      })
      .default(DEFAULT_HITCH_POLICY.closeRequires),
  })
  .strict();

export function parseHitchScope(value: unknown): HitchScope {
  return HitchScopeSchema.parse(value ?? {}) as HitchScope;
}

export function parseHitchCloseConditions(
  value: unknown,
): HitchCloseCondition[] {
  return HitchCloseConditionsSchema.parse(value ?? []) as HitchCloseCondition[];
}

export function parseHitchPolicy(value: unknown): HitchPolicy {
  return HitchPolicySchema.parse(value ?? {}) as HitchPolicy;
}
