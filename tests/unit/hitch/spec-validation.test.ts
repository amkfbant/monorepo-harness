import { describe, expect, it } from "vitest";
import {
  closeConditionKindClassification,
  validateCloseConditions,
} from "../../../src/hitch/spec-validation.js";
import { HitchCloseConditionsSchema } from "../../../src/hitch/schemas.js";
import {
  HITCH_CLOSE_CONDITION_KINDS,
  type HitchCloseCondition,
} from "../../../src/hitch/types.js";

function condition(
  overrides: Partial<HitchCloseCondition>,
): HitchCloseCondition {
  return {
    id: "typecheck",
    kind: "command",
    required: true,
    ...overrides,
  };
}

function errorCodes(result: ReturnType<typeof validateCloseConditions>): string[] {
  return result.errors.map((issue) => issue.code);
}

function warningCodes(
  result: ReturnType<typeof validateCloseConditions>,
): string[] {
  return result.warnings.map((issue) => issue.code);
}

describe("close condition schema and validation", () => {
  it.each(HITCH_CLOSE_CONDITION_KINDS)(
    "schema accepts close condition kind %s",
    (kind) => {
      expect(() =>
        HitchCloseConditionsSchema.parse([
          { id: `${kind}-gate`, kind, required: true },
        ]),
      ).not.toThrow();
    },
  );

  it("schema rejects top-level count but lets rule.count reach the validator", () => {
    expect(() =>
      HitchCloseConditionsSchema.parse([
        { id: "bad", kind: "finding_policy", required: true, count: 0 },
      ]),
    ).toThrow();
    expect(() =>
      HitchCloseConditionsSchema.parse([
        {
          id: "bad-rule",
          kind: "finding_policy",
          required: true,
          rule: { count: 0 },
        },
      ]),
    ).not.toThrow();
  });

  it("keeps command bare-id validation form-only when no command context exists", () => {
    const result = validateCloseConditions([
      condition({ id: "typecheck", command: undefined }),
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("keeps command validation form-only and defers allowlist resolution to the runner", () => {
    // A bare-id command (or an unresolvable command string) is valid FORM at the
    // choke-point validator — allowlist resolution + ambiguity detection are the
    // close-check runner's job (design-231 §3.3 HARD #2 phase b), not the
    // form-only validator.
    expect(
      validateCloseConditions([
        condition({ id: "missing", command: undefined }),
      ]).valid,
    ).toBe(true);
    expect(
      validateCloseConditions([
        condition({ id: "ambiguous", command: "npm test" }),
      ]).valid,
    ).toBe(true);
  });

  it("hard-fails invalid finding_policy rules and duplicate ids", () => {
    const result = validateCloseConditions([
      condition({
        id: "findings",
        kind: "finding_policy",
        rule: { maxOpenInScopeP0: 0, count: 0, maxOpenInScopeP1: -1 },
      }),
      condition({ id: "findings", kind: "manual" }),
    ]);
    expect(errorCodes(result)).toEqual(
      expect.arrayContaining([
        "finding_policy_unknown_rule",
        "finding_policy_invalid_threshold",
        "duplicate_condition_id",
      ]),
    );
    expect(result.valid).toBe(false);
  });

  it("distinguishes hard errors from advisory external-evidence warnings", () => {
    const result = validateCloseConditions([
      condition({ id: "manual", kind: "manual", description: "" }),
      condition({ id: "artifact", kind: "artifact_exists", metadata: {} }),
      condition({ id: "op", kind: "operation_status", metadata: {} }),
      condition({ id: "doctor", kind: "db_doctor", required: true }),
    ]);
    expect(errorCodes(result)).toEqual(
      expect.arrayContaining([
        "operation_status_missing_operation_id",
        "db_doctor_required_without_runner",
      ]),
    );
    expect(warningCodes(result)).toEqual(
      expect.arrayContaining([
        "external_evidence_missing_description",
        "artifact_exists_missing_path",
      ]),
    );
  });

  it("treats auto-gate intent mismatch as advisory only", () => {
    const result = validateCloseConditions([
      condition({
        id: "manual-test",
        kind: "manual",
        description: "npm test passes",
      }),
    ]);
    expect(result.valid).toBe(true);
    expect(warningCodes(result)).toContain("auto_intent_external_kind");
  });

  it("hard-fails a close condition whose kind is outside the seven", () => {
    const result = validateCloseConditions([
      { id: "bogus", kind: "totally-made-up" as never, required: true },
    ]);
    expect(result.valid).toBe(false);
    expect(errorCodes(result)).toContain("unknown_kind");
  });

  it("flags an ambiguous review_consensus description as advisory only", () => {
    const result = validateCloseConditions([
      condition({
        id: "rc",
        kind: "review_consensus",
        description: "looks fine to me",
      }),
    ]);
    expect(result.valid).toBe(true);
    expect(warningCodes(result)).toContain(
      "review_consensus_ambiguous_description",
    );
  });

  it("flags external-evidence majority as advisory", () => {
    const result = validateCloseConditions([
      condition({ id: "m1", kind: "manual", description: "operator verifies a" }),
      condition({ id: "m2", kind: "manual", description: "operator verifies b" }),
      condition({ id: "cmd", kind: "command", command: "typecheck" }),
    ]);
    expect(result.valid).toBe(true);
    expect(warningCodes(result)).toContain("external_evidence_majority");
  });

  it("exports the kind classification table for all seven kinds", () => {
    expect(
      HITCH_CLOSE_CONDITION_KINDS.map((kind) => [
        kind,
        closeConditionKindClassification(kind).category,
      ]),
    ).toEqual([
      ["command", "auto-verify"],
      ["finding_policy", "auto-verify"],
      ["manual", "external-evidence"],
      ["operation_status", "external-evidence"],
      ["db_doctor", "external-evidence"],
      ["review_consensus", "auto-verify"],
      ["artifact_exists", "external-evidence"],
    ]);
  });
});
