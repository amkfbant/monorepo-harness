import { describe, it, expect } from "vitest";
import {
  auditSeverity,
  type SeverityAuditContext,
} from "../../../../src/hitch/jury/severity-audit.js";
import type { HitchFindingSeverity } from "../../../../src/hitch/types.js";

/**
 * #230 deliberation jury — Task B4 RED.
 *
 * Frozen contract: docs/design/proposals/design-gate-specs.md §3.
 * `auditSeverity` is advisory-only, pure, deterministic, and NEVER mutates
 * (auto-downgrades) the harness severity. Strict majority = count > total/2.
 */

function ctx(
  harnessSeverity: HitchFindingSeverity,
  severities: HitchFindingSeverity[],
): SeverityAuditContext {
  return {
    harnessSeverity,
    juryVotes: severities.map((s, i) => ({
      lens: `lens-${i}`,
      juryProposedSeverity: s,
    })),
    finding: { findingId: "f-1", summary: "a finding" },
  };
}

describe("auditSeverity (frozen gate-specs §3)", () => {
  it("severity-audit-aligned: harness P1, jury all P1 -> aligned, no escalate", () => {
    const out = auditSeverity(ctx("P1", ["P1", "P1", "P1"]));
    expect(out.status).toBe("aligned");
    expect(out.escalate).toBe(false);
    expect(out.juryConsensus).toBe("P1");
    expect(out.harnessSeverity).toBe("P1");
  });

  it("severity-audit-diverged: harness P1, jury [P2,P2,P1] (majority P2) -> diverged, escalate, severity unchanged", () => {
    const out = auditSeverity(ctx("P1", ["P2", "P2", "P1"]));
    expect(out.status).toBe("diverged");
    expect(out.escalate).toBe(true);
    expect(out.juryConsensus).toBe("P2");
    // severity returned UNCHANGED (advisory-only; no auto-mutation)
    expect(out.harnessSeverity).toBe("P1");
  });

  it("severity-audit-inconclusive (all different): harness P1, jury [P1,P2,P3] -> inconclusive, escalate, no consensus", () => {
    const out = auditSeverity(ctx("P1", ["P1", "P2", "P3"]));
    expect(out.status).toBe("inconclusive");
    expect(out.escalate).toBe(true);
    expect(out.juryConsensus).toBeUndefined();
    expect(out.harnessSeverity).toBe("P1");
  });

  it("severity-audit-inconclusive (tie): harness P1, jury [P1,P2] (1-1 tie, no strict majority) -> inconclusive", () => {
    const out = auditSeverity(ctx("P1", ["P1", "P2"]));
    expect(out.status).toBe("inconclusive");
    expect(out.escalate).toBe(true);
    expect(out.juryConsensus).toBeUndefined();
    expect(out.harnessSeverity).toBe("P1");
  });

  it("severity-audit-inconclusive (zero votes): harness P1, jury [] -> inconclusive, escalate", () => {
    const out = auditSeverity(ctx("P1", []));
    expect(out.status).toBe("inconclusive");
    expect(out.escalate).toBe(true);
    expect(out.juryConsensus).toBeUndefined();
    expect(out.harnessSeverity).toBe("P1");
  });

  it("strict-majority boundary: count must be > total/2, exactly half is NOT a majority", () => {
    // 4 votes, P2x2 + P1x2 -> P2 has 2 of 4 = exactly half (not > half) -> inconclusive.
    const out = auditSeverity(ctx("P1", ["P2", "P2", "P1", "P1"]));
    expect(out.status).toBe("inconclusive");
    expect(out.escalate).toBe(true);
    expect(out.juryConsensus).toBeUndefined();
  });

  it("strict-majority boundary: 3 of 4 is a strict majority", () => {
    // 4 votes, P2x3 + P1x1 -> P2 has 3 of 4 > half -> diverged, consensus P2.
    const out = auditSeverity(ctx("P1", ["P2", "P2", "P2", "P1"]));
    expect(out.status).toBe("diverged");
    expect(out.escalate).toBe(true);
    expect(out.juryConsensus).toBe("P2");
  });

  it("aligned via strict majority (not unanimous): harness P1, jury [P1,P1,P2] -> aligned", () => {
    const out = auditSeverity(ctx("P1", ["P1", "P1", "P2"]));
    expect(out.status).toBe("aligned");
    expect(out.escalate).toBe(false);
    expect(out.juryConsensus).toBe("P1");
    expect(out.harnessSeverity).toBe("P1");
  });

  it("severity-audit-deterministic: same context twice -> deep-equal result", () => {
    const context = ctx("P0", ["P1", "P1", "P0"]);
    const a = auditSeverity(context);
    const b = auditSeverity(context);
    expect(a).toEqual(b);
  });

  it("severity-audit-no-auto-downgrade: harness P1 returned unchanged even when diverged toward a lower severity (P2)", () => {
    // jury majority P2 (lower than P1) -> must NOT downgrade; harnessSeverity stays P1.
    const out = auditSeverity(ctx("P1", ["P2", "P2", "P2"]));
    expect(out.status).toBe("diverged");
    expect(out.harnessSeverity).toBe("P1");
    expect(out.juryConsensus).toBe("P2");
  });

  it("reasoning is a non-empty deterministic string", () => {
    const a = auditSeverity(ctx("P1", ["P2", "P2", "P1"]));
    const b = auditSeverity(ctx("P1", ["P2", "P2", "P1"]));
    expect(typeof a.reasoning).toBe("string");
    expect(a.reasoning.length).toBeGreaterThan(0);
    expect(a.reasoning).toBe(b.reasoning);
  });
});
