// tests/unit/hitch/jury/aggregation.test.ts
//
// Frozen contract port of design-gate-specs §1/§2 (aggregateJuryVotes).
// Covers the full §2.3 edge-case table: unanimous (in_scope / out_of_scope),
// duplicate lens, missing lens, scope split 2-1, length 1, length 4, empty,
// timeout (inconclusive), unknown-scope (inconclusive), confidence-ignored,
// fixed-order reason strings, and determinism (same input -> equal output).
import { describe, it, expect } from "vitest";
import { aggregateJuryVotes } from "../../../../src/hitch/jury/aggregation.js";
import type {
  JuryClassificationProposal,
  JuryLens,
  JuryProposalStatus,
  JuryProposedScope,
} from "../../../../src/hitch/jury/types.js";

const P = (
  lens: JuryLens,
  scope: JuryProposedScope,
  status: JuryProposalStatus = "complete",
  confidence?: number,
): JuryClassificationProposal => ({
  findingId: "f",
  lens,
  proposedScope: scope,
  proposalStatus: status,
  evidence: [],
  round: 2,
  ...(confidence === undefined ? {} : { confidence }),
});

describe("aggregateJuryVotes (frozen contract)", () => {
  it("3 distinct lenses, same in_scope, all complete -> unanimous in_scope", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "in_scope"),
    ]);
    expect(r.decision).toBe("unanimous");
    expect(r.scope).toBe("in_scope");
    expect(r.reason).toBe("unanimous in_scope (3/3 lenses agreed)");
  });

  it("3 distinct lenses, same out_of_scope, all complete -> unanimous out_of_scope", () => {
    const r = aggregateJuryVotes([
      P("correctness", "out_of_scope"),
      P("scope_fit", "out_of_scope"),
      P("spec_adherence", "out_of_scope"),
    ]);
    expect(r.decision).toBe("unanimous");
    expect(r.scope).toBe("out_of_scope");
    expect(r.reason).toBe("unanimous out_of_scope (3/3 lenses agreed)");
  });

  it("duplicate lens (correctness x2) -> split (lens distinct fails, fail-closed)", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("correctness", "in_scope"),
      P("spec_adherence", "in_scope"),
    ]);
    expect(r.decision).toBe("split");
    expect(r.scope).toBeUndefined();
    expect(r.reason).toBe(
      "split votes: in_scope(3), out_of_scope(0), unknown(0), incomplete(0)",
    );
  });

  it("missing lens (length 2) -> split", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
    ]);
    expect(r.decision).toBe("split");
    expect(r.reason).toBe(
      "split votes: in_scope(2), out_of_scope(0), unknown(0), incomplete(0)",
    );
  });

  it("scope split 2-1 -> split with fixed-order reason", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "out_of_scope"),
    ]);
    expect(r.decision).toBe("split");
    expect(r.scope).toBeUndefined();
    expect(r.reason).toBe(
      "split votes: in_scope(2), out_of_scope(1), unknown(0), incomplete(0)",
    );
  });

  it("1-1-1 three-way scope split -> split", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("scope_fit", "out_of_scope"),
      P("spec_adherence", "unknown"),
    ]);
    expect(r.decision).toBe("split");
    expect(r.reason).toBe(
      "split votes: in_scope(1), out_of_scope(1), unknown(1), incomplete(0)",
    );
  });

  it("one timeout -> split (isInconclusive), counted as incomplete", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "in_scope", "timeout"),
    ]);
    expect(r.decision).toBe("split");
    // N1 counts only scope===in_scope && status===complete -> 2;
    // the timeout vote is incomplete -> N4=1 (NOT in_scope count).
    expect(r.reason).toBe(
      "split votes: in_scope(2), out_of_scope(0), unknown(0), incomplete(1)",
    );
  });

  it("unknown scope mixed in -> split (scope unknown is inconclusive)", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "unknown"),
    ]);
    expect(r.decision).toBe("split");
    expect(r.reason).toBe(
      "split votes: in_scope(2), out_of_scope(0), unknown(1), incomplete(0)",
    );
  });

  it("length 1 -> split", () => {
    const r = aggregateJuryVotes([P("correctness", "in_scope")]);
    expect(r.decision).toBe("split");
    expect(r.reason).toBe(
      "split votes: in_scope(1), out_of_scope(0), unknown(0), incomplete(0)",
    );
  });

  it("length 4 -> split", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "in_scope"),
      P("correctness", "in_scope"),
    ]);
    expect(r.decision).toBe("split");
    expect(r.reason).toBe(
      "split votes: in_scope(4), out_of_scope(0), unknown(0), incomplete(0)",
    );
  });

  it("empty array -> split with all-zero counts", () => {
    const r = aggregateJuryVotes([]);
    expect(r.decision).toBe("split");
    expect(r.scope).toBeUndefined();
    expect(r.reason).toBe(
      "split votes: in_scope(0), out_of_scope(0), unknown(0), incomplete(0)",
    );
  });

  it("confidence does not drive decision (unanimous despite skewed confidence)", () => {
    const r = aggregateJuryVotes([
      P("correctness", "in_scope", "complete", 0.9),
      P("scope_fit", "in_scope", "complete", 0.1),
      P("spec_adherence", "in_scope", "complete", 0.5),
    ]);
    expect(r.decision).toBe("unanimous");
    expect(r.scope).toBe("in_scope");
  });

  it("deterministic: same input twice -> deep-equal output", () => {
    const ps = [
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "in_scope"),
    ];
    expect(aggregateJuryVotes(ps)).toEqual(aggregateJuryVotes(ps));
  });

  it("deterministic: input order does not change split reason counts", () => {
    const a = aggregateJuryVotes([
      P("correctness", "in_scope"),
      P("scope_fit", "out_of_scope"),
      P("spec_adherence", "in_scope", "timeout"),
    ]);
    const b = aggregateJuryVotes([
      P("spec_adherence", "in_scope", "timeout"),
      P("correctness", "in_scope"),
      P("scope_fit", "out_of_scope"),
    ]);
    expect(a).toEqual(b);
  });
});
