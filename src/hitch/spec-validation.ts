import {
  HITCH_CLOSE_CONDITION_KINDS,
  HitchValidationError,
  type HitchCloseCondition,
  type HitchCloseConditionKind,
  type HitchValidationIssue,
} from "./types.js";

export type CloseConditionValidationCategory =
  | "auto-verify"
  | "external-evidence";

export interface CloseConditionKindClassification {
  kind: HitchCloseConditionKind;
  category: CloseConditionValidationCategory;
  evaluator: string;
  guard: string;
}

export interface CloseConditionValidationContext {
  allowRequiredDbDoctor?: boolean;
}

export interface CloseConditionValidationResult {
  valid: boolean;
  errors: HitchValidationIssue[];
  warnings: HitchValidationIssue[];
}

const KIND_SET = new Set<string>(HITCH_CLOSE_CONDITION_KINDS);
const FINDING_POLICY_RULE_KEYS = new Set([
  "maxOpenInScopeP0",
  "maxOpenInScopeP1",
  "maxOpenInScopeP2",
  "maxOpenUnknownScope",
]);

const EXTERNAL_EVIDENCE_KINDS = new Set<HitchCloseConditionKind>([
  "manual",
  "artifact_exists",
  "operation_status",
  "db_doctor",
]);

const KIND_TABLE: Record<
  HitchCloseConditionKind,
  CloseConditionKindClassification
> = {
  command: {
    kind: "command",
    category: "auto-verify",
    evaluator: "close-check runner",
    guard: "command non-empty or id present; allowlist resolution deferred to the close-check runner",
  },
  finding_policy: {
    kind: "finding_policy",
    category: "auto-verify",
    evaluator: "evaluateFindingPolicy",
    guard: "rule keys are maxOpen* thresholds with non-negative numbers",
  },
  manual: {
    kind: "manual",
    category: "external-evidence",
    evaluator: "operator evidence",
    guard: "description recommended",
  },
  operation_status: {
    kind: "operation_status",
    category: "external-evidence",
    evaluator: "operator evidence",
    guard: "metadata.operationId required",
  },
  db_doctor: {
    kind: "db_doctor",
    category: "external-evidence",
    evaluator: "operator evidence until a runner exists",
    guard: "required:true rejected unless explicitly allowed",
  },
  review_consensus: {
    kind: "review_consensus",
    category: "auto-verify",
    evaluator: "review runner",
    guard: "description recommended",
  },
  artifact_exists: {
    kind: "artifact_exists",
    category: "external-evidence",
    evaluator: "operator evidence",
    guard: "metadata.path recommended",
  },
};

export function closeConditionKindClassification(
  kind: HitchCloseConditionKind,
): CloseConditionKindClassification {
  return KIND_TABLE[kind];
}

export function validateCloseConditions(
  conditions: readonly HitchCloseCondition[],
  context: CloseConditionValidationContext = {},
): CloseConditionValidationResult {
  const issues: HitchValidationIssue[] = [];
  const ids = new Map<string, number>();
  let externalCount = 0;

  conditions.forEach((condition, index) => {
    const conditionId =
      typeof condition.id === "string" && condition.id !== ""
        ? condition.id
        : undefined;
    const kind =
      typeof condition.kind === "string" && KIND_SET.has(condition.kind)
        ? (condition.kind as HitchCloseConditionKind)
        : undefined;
    const category =
      kind === undefined ? undefined : KIND_TABLE[kind].category;
    const path = (field: string) => `[${index}].${field}`;
    const push = (
      severity: HitchValidationIssue["severity"],
      code: string,
      message: string,
      issuePath: string,
    ): void => {
      issues.push({
        severity,
        code,
        message,
        path: issuePath,
        ...(conditionId !== undefined ? { conditionId } : {}),
        conditionIndex: index,
        ...(kind !== undefined ? { kind } : {}),
        ...(category !== undefined ? { category } : {}),
      });
    };

    if (conditionId === undefined) {
      push("hard", "missing_condition_id", "condition id is required", path("id"));
    } else {
      const previous = ids.get(conditionId);
      if (previous !== undefined) {
        push(
          "hard",
          "duplicate_condition_id",
          `condition id ${conditionId} duplicates index ${previous}`,
          path("id"),
        );
      } else {
        ids.set(conditionId, index);
      }
    }

    if (kind === undefined) {
      push(
        "hard",
        "unknown_kind",
        `close condition kind is not one of ${HITCH_CLOSE_CONDITION_KINDS.join(", ")}`,
        path("kind"),
      );
      return;
    }

    if (KIND_TABLE[kind].category === "external-evidence") externalCount += 1;

    if (kind === "finding_policy") {
      validateFindingPolicyCondition(condition, index, push);
    } else if (kind === "operation_status") {
      validateOperationStatusCondition(condition, path, push);
    } else if (kind === "db_doctor") {
      validateDbDoctorCondition(condition, context, path, push);
    }

    if (EXTERNAL_EVIDENCE_KINDS.has(kind)) {
      validateExternalEvidenceCondition(condition, kind, path, push);
    }
    if (kind === "review_consensus") {
      validateReviewConsensusCondition(condition, path, push);
    }
  });

  if (conditions.length > 0 && externalCount / conditions.length > 0.5) {
    issues.push({
      severity: "advisory",
      code: "external_evidence_majority",
      message: "more than half of close conditions require external evidence",
      path: "$",
      category: "external-evidence",
    });
  }

  const errors = issues.filter((issue) => issue.severity === "hard");
  const warnings = issues.filter((issue) => issue.severity === "advisory");
  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidCloseConditions(
  conditions: readonly HitchCloseCondition[],
  context: CloseConditionValidationContext = {},
): void {
  const result = validateCloseConditions(conditions, context);
  if (!result.valid) {
    throw new HitchValidationError(
      formatCloseConditionValidationIssues(result.errors),
      result.errors,
    );
  }
}

export function formatCloseConditionValidationIssues(
  issues: readonly HitchValidationIssue[],
): string {
  return issues
    .map((issue) => `${issue.path} ${issue.code}: ${issue.message}`)
    .join("; ");
}

function validateFindingPolicyCondition(
  condition: HitchCloseCondition,
  index: number,
  push: (
    severity: HitchValidationIssue["severity"],
    code: string,
    message: string,
    issuePath: string,
  ) => void,
): void {
  const rule = condition.rule ?? {};
  for (const [key, value] of Object.entries(rule)) {
    if (!FINDING_POLICY_RULE_KEYS.has(key)) {
      push(
        "hard",
        "finding_policy_unknown_rule",
        `finding_policy rule key ${key} is not supported`,
        `[${index}].rule.${key}`,
      );
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      push(
        "hard",
        "finding_policy_invalid_threshold",
        `finding_policy rule ${key} must be a non-negative number`,
        `[${index}].rule.${key}`,
      );
    }
  }
}

function validateOperationStatusCondition(
  condition: HitchCloseCondition,
  path: (field: string) => string,
  push: (
    severity: HitchValidationIssue["severity"],
    code: string,
    message: string,
    issuePath: string,
  ) => void,
): void {
  const operationId = condition.metadata?.operationId;
  if (typeof operationId !== "string" || operationId.trim() === "") {
    push(
      "hard",
      "operation_status_missing_operation_id",
      "operation_status requires metadata.operationId",
      path("metadata.operationId"),
    );
  }
}

function validateDbDoctorCondition(
  condition: HitchCloseCondition,
  context: CloseConditionValidationContext,
  path: (field: string) => string,
  push: (
    severity: HitchValidationIssue["severity"],
    code: string,
    message: string,
    issuePath: string,
  ) => void,
): void {
  if (condition.required && context.allowRequiredDbDoctor !== true) {
    push(
      "hard",
      "db_doctor_required_without_runner",
      "required db_doctor close conditions need explicit external-evidence acknowledgement",
      path("required"),
    );
  }
}

function validateExternalEvidenceCondition(
  condition: HitchCloseCondition,
  kind: HitchCloseConditionKind,
  path: (field: string) => string,
  push: (
    severity: HitchValidationIssue["severity"],
    code: string,
    message: string,
    issuePath: string,
  ) => void,
): void {
  const description = condition.description?.trim() ?? "";
  if (description === "") {
    push(
      "advisory",
      "external_evidence_missing_description",
      `${kind} external-evidence condition should describe the evidence source`,
      path("description"),
    );
  } else if (/\b(npm|pnpm|yarn|test|typecheck|lint|pass|passes|count|threshold|run|execute)\b/i.test(description)) {
    push(
      "advisory",
      "auto_intent_external_kind",
      `${kind} description looks like an auto-verifiable gate`,
      path("description"),
    );
  }

  if (kind === "artifact_exists") {
    const artifactPath = condition.metadata?.path;
    if (typeof artifactPath !== "string" || artifactPath.trim() === "") {
      push(
        "advisory",
        "artifact_exists_missing_path",
        "artifact_exists should include metadata.path",
        path("metadata.path"),
      );
    }
  }
}

function validateReviewConsensusCondition(
  condition: HitchCloseCondition,
  path: (field: string) => string,
  push: (
    severity: HitchValidationIssue["severity"],
    code: string,
    message: string,
    issuePath: string,
  ) => void,
): void {
  const description = condition.description?.trim() ?? "";
  if (description !== "" && !/\b(review|approved|consensus)\b/i.test(description)) {
    push(
      "advisory",
      "review_consensus_ambiguous_description",
      "review_consensus description should identify review approval semantics",
      path("description"),
    );
  }
}
