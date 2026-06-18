import { describe, expect, it } from "vitest";
import {
  mapGapMetricToCloseConditionKind,
  type GapRow,
} from "../../../src/hitch/gap-to-kind.js";
import { HITCH_CLOSE_CONDITION_KINDS } from "../../../src/hitch/types.js";

function gap(metric: string): GapRow {
  return { metric, count: 1, gap: 1 };
}

const allowedKinds = HITCH_CLOSE_CONDITION_KINDS;

describe("mapGapMetricToCloseConditionKind", () => {
  it("maps an allowlisted command pass metric to command", () => {
    const result = mapGapMetricToCloseConditionKind(gap("command typecheck passes"), {
      allowedKinds,
      allowedCommands: [{ id: "typecheck" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal).toMatchObject({
        kind: "command",
        command: "typecheck",
      });
    }
  });

  it("emits canonical finding_policy rules including unknown-scope counts", () => {
    const result = mapGapMetricToCloseConditionKind(
      gap("finding count threshold maxOpenUnknownScope <= 0"),
      { allowedKinds },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal).toMatchObject({
        kind: "finding_policy",
        rule: { maxOpenUnknownScope: 0 },
      });
    }
  });

  it.each([
    ["review decision = approved", "review_consensus"],
    ["file docs/specs/roadmap.md exists", "artifact_exists"],
    ["operator verified rollout", "manual"],
    ["external operation status op-123 succeeded", "operation_status"],
    ["DB migration valid", "db_doctor"],
  ] as const)("maps %s to %s", (metric, kind) => {
    const result = mapGapMetricToCloseConditionKind(gap(metric), {
      allowedKinds,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.kind).toBe(kind);
  });

  it("rejects unmapped or disallowed metrics instead of defaulting to manual", () => {
    const unknown = mapGapMetricToCloseConditionKind(gap("quality is better"), {
      allowedKinds,
    });
    expect(unknown).toMatchObject({ ok: false, code: "unmapped_metric" });

    const disallowed = mapGapMetricToCloseConditionKind(
      gap("review decision = approved"),
      { allowedKinds: ["command"] },
    );
    expect(disallowed).toMatchObject({ ok: false, code: "kind_not_allowed" });
  });

  it("does not substring-match a short command id inside a larger word (fail-closed)", () => {
    // "test" is a substring of "latest" but NOT a whitespace-delimited token, so
    // it must not resolve "npm latest passes" to the `test` command (design §3.2
    // fail-closed: an unmappable metric REJECTs, never a spurious command).
    const result = mapGapMetricToCloseConditionKind(gap("npm latest passes"), {
      allowedKinds,
      allowedCommands: [{ id: "test" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unmapped_metric");
  });

  it("rejects ambiguous metrics that match multiple gate kinds", () => {
    const result = mapGapMetricToCloseConditionKind(
      gap("command typecheck passes and review decision = approved"),
      {
        allowedKinds,
        allowedCommands: [{ id: "typecheck" }],
      },
    );
    expect(result).toMatchObject({ ok: false, code: "ambiguous_metric" });
  });
});
