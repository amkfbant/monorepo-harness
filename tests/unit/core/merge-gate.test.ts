import { describe, it, expect } from "vitest";
import {
  evaluateMergeGate,
  quorumSatisfiedFromRequirements,
  type MergeGateInput,
} from "../../../src/core/merge-gate.js";

function base(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    autoMergeEnabled: true,
    closeReady: true,
    consensus: { status: "approved", quorumSatisfied: true },
    humanApproved: false,
    ciGreen: true,
    tierEligible: true,
    ...overrides,
  };
}

describe("evaluateMergeGate (Phase 3-1)", () => {
  it("all conditions satisfied → canMerge", () => {
    const r = evaluateMergeGate(base());
    expect(r.canMerge).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.hardBlocked).toBe(false);
  });

  it("auto-merge disabled → not merged (not hard-blocked)", () => {
    const r = evaluateMergeGate(base({ autoMergeEnabled: false }));
    expect(r.canMerge).toBe(false);
    expect(r.blockers).toContain("auto_merge_disabled");
    expect(r.hardBlocked).toBe(false);
  });

  it("not close-ready → hard block", () => {
    const r = evaluateMergeGate(base({ closeReady: false }));
    expect(r.canMerge).toBe(false);
    expect(r.blockers).toContain("not_close_ready");
    expect(r.hardBlocked).toBe(true);
  });

  it("consensus not approved → hard block", () => {
    const r = evaluateMergeGate(
      base({ consensus: { status: "changes_requested", quorumSatisfied: true } }),
    );
    expect(r.canMerge).toBe(false);
    expect(r.blockers).toContain("consensus_not_approved");
    expect(r.hardBlocked).toBe(true);
  });

  it("consensus approved but quorum not satisfied → hard block", () => {
    const r = evaluateMergeGate(
      base({ consensus: { status: "approved", quorumSatisfied: false } }),
    );
    expect(r.canMerge).toBe(false);
    expect(r.blockers).toContain("quorum_not_satisfied");
    expect(r.hardBlocked).toBe(true);
  });

  it("no consensus and no human approval → hard block (fail-closed)", () => {
    const r = evaluateMergeGate(base({ consensus: null }));
    expect(r.canMerge).toBe(false);
    expect(r.blockers).toContain("consensus_not_approved");
    expect(r.hardBlocked).toBe(true);
  });

  it("human approval substitutes for consensus", () => {
    const r = evaluateMergeGate(base({ consensus: null, humanApproved: true }));
    expect(r.canMerge).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("human approval overrides a non-approved consensus", () => {
    const r = evaluateMergeGate(
      base({ consensus: { status: "rejected", quorumSatisfied: false }, humanApproved: true }),
    );
    expect(r.canMerge).toBe(true);
  });

  it("CI not green → transient block (not hard)", () => {
    const r = evaluateMergeGate(base({ ciGreen: false }));
    expect(r.canMerge).toBe(false);
    expect(r.blockers).toEqual(["ci_not_green"]);
    expect(r.hardBlocked).toBe(false);
  });

  it("tier not auto-eligible → transient block (not hard)", () => {
    const r = evaluateMergeGate(base({ tierEligible: false }));
    expect(r.canMerge).toBe(false);
    expect(r.blockers).toEqual(["tier_not_auto_eligible"]);
    expect(r.hardBlocked).toBe(false);
  });

  it("a hard block plus ci_not_green is still hard-blocked", () => {
    const r = evaluateMergeGate(base({ closeReady: false, ciGreen: false }));
    expect(r.canMerge).toBe(false);
    expect(r.hardBlocked).toBe(true);
    expect(r.blockers).toContain("not_close_ready");
    expect(r.blockers).toContain("ci_not_green");
  });

  it("external review ledger observations are not merge-gate inputs", () => {
    const withExternalLedger = {
      ...base(),
      externalReviewEvents: [{ state: "changes_requested" }],
    } as MergeGateInput & { externalReviewEvents: unknown };

    expect(evaluateMergeGate(withExternalLedger)).toEqual({
      canMerge: true,
      blockers: [],
      hardBlocked: false,
    });
    expect(Object.keys(base()).sort()).toEqual([
      "autoMergeEnabled",
      "ciGreen",
      "closeReady",
      "consensus",
      "humanApproved",
      "tierEligible",
    ]);
  });
});

describe("quorumSatisfiedFromRequirements (Phase 3)", () => {
  it("a valid empty array (latest-proposal) → satisfied", () => {
    expect(quorumSatisfiedFromRequirements([])).toBe(true);
  });

  it("all quorumMet strictly true → satisfied", () => {
    expect(
      quorumSatisfiedFromRequirements([{ quorumMet: true }, { quorumMet: true }]),
    ).toBe(true);
  });

  it("any quorumMet false → not satisfied", () => {
    expect(
      quorumSatisfiedFromRequirements([{ quorumMet: true }, { quorumMet: false }]),
    ).toBe(false);
  });

  it.each([
    ["non-array", { quorumMet: true } as unknown],
    ["null", null as unknown],
    ["truthy non-boolean quorumMet", [{ quorumMet: "yes" }]],
    ["missing quorumMet", [{}]],
    ["null entry", [null]],
  ])("fail-closed on malformed requirements: %s", (_label, requirements) => {
    expect(quorumSatisfiedFromRequirements(requirements)).toBe(false);
  });
});
