import { describe, it, expect } from "vitest";
import {
  aggregateDeliberation,
  selectFinalRound,
} from "../../../../src/hitch/jury/aggregation.js";

const FINDING = { filePath: "src/a.ts", category: "core" };
const v = (citation = "src/a.ts:1", kind = "file" as const, resolvedRef?: string) =>
  ({ citation, kind, claim: "c", verified: true, resolvedRef });
const P = (lens: any, scope: any, opts: any = {}) =>
  ({
    findingId: "f",
    lens,
    proposedScope: scope,
    proposalStatus: opts.status ?? "complete",
    evidence: opts.evidence ?? [v()],
    round: opts.round ?? 2,
  });
const unanimous = () => [
  P("correctness", "in_scope"),
  P("scope_fit", "in_scope"),
  P("spec_adherence", "in_scope"),
];
const D = (proposals: any, verdict?: any) =>
  ({
    findingId: "f",
    deliberationId: "d1",
    finding: FINDING,
    proposals,
    ...(verdict
      ? { refuterVerdict: { refuteVerdict: verdict, reasoning: "x" } }
      : {}),
  });

describe("aggregateDeliberation (monotonic fail-closed)", () => {
  it("unanimous + proximate-verified + refuter uphold -> auto_confirm", () => {
    const r = aggregateDeliberation(D(unanimous(), "uphold"));
    expect(r.decision).toBe("auto_confirm");
    expect(r.scope).toBe("in_scope");
    expect(r.gateTrace).toMatchObject({
      scopeUnanimous: true,
      allHaveVerifiedEvidence: true,
      proximityOk: true,
      refuterUpheld: true,
    });
  });
  it("split can NEVER become auto_confirm even if refuter uphold", () => {
    const split = [
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "out_of_scope"),
    ];
    expect(aggregateDeliberation(D(split, "uphold")).decision).toBe("escalate");
  });
  it("refuter refute/inconclusive vetoes unanimous", () => {
    for (const verdict of ["refute", "inconclusive"] as const)
      expect(aggregateDeliberation(D(unanimous(), verdict)).decision).toBe("escalate");
  });
  it("refuter undefined (not run) -> escalate", () => {
    expect(aggregateDeliberation(D(unanimous())).decision).toBe("escalate");
  });
  it("any proposal missing a verified evidence -> escalate (allHaveVerifiedEvidence false)", () => {
    const weak = [
      P("correctness", "in_scope", { evidence: [] }),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "in_scope"),
    ];
    const r = aggregateDeliberation(D(weak, "uphold"));
    expect(r.decision).toBe("escalate");
    expect(r.gateTrace.allHaveVerifiedEvidence).toBe(false);
  });
  it("verified=false (unresolved citation) does not count -> escalate", () => {
    const weak = [
      P("correctness", "in_scope", {
        evidence: [{ citation: "nope", kind: "file", claim: "c", verified: false }],
      }),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "in_scope"),
    ];
    expect(aggregateDeliberation(D(weak, "uphold")).decision).toBe("escalate");
  });
  it("PR1: verified but UNRELATED-domain citation only -> escalate (proximityOk false)", () => {
    const off = [
      P("correctness", "in_scope", { evidence: [v("vendor/x.ts:1")] }),
      P("scope_fit", "in_scope", { evidence: [v("vendor/y.ts:1")] }),
      P("spec_adherence", "in_scope", { evidence: [v("vendor/z.ts:1")] }),
    ];
    const r = aggregateDeliberation(D(off, "uphold"));
    expect(r.decision).toBe("escalate");
    expect(r.gateTrace.proximityOk).toBe(false);
  });
  it("PR1: finding without filePath/category -> proximity fail-closed -> escalate", () => {
    const r = aggregateDeliberation({
      findingId: "f",
      deliberationId: "d1",
      finding: {},
      proposals: unanimous(),
      refuterVerdict: { refuteVerdict: "uphold", reasoning: "x" },
    });
    expect(r.decision).toBe("escalate");
    expect(r.gateTrace.proximityOk).toBe(false);
  });
  it("duplicate lens + refuter uphold -> escalate (gateTrace.lensDistinct false)", () => {
    const dup = [
      P("correctness", "in_scope"),
      P("correctness", "in_scope"),
      P("spec_adherence", "in_scope"),
    ];
    const r = aggregateDeliberation(D(dup, "uphold"));
    expect(r.decision).toBe("escalate");
    expect(r.gateTrace.lensDistinct).toBe(false);
  });
  it("all inconclusive -> escalate (gateTrace.noInconclusive false)", () => {
    const inc = [
      P("correctness", "in_scope", { status: "timeout" }),
      P("scope_fit", "in_scope", { status: "parse_error" }),
      P("spec_adherence", "in_scope", { status: "inconclusive" }),
    ];
    const r = aggregateDeliberation(D(inc, "uphold"));
    expect(r.decision).toBe("escalate");
    expect(r.gateTrace.noInconclusive).toBe(false);
  });
  it("deterministic: same input twice -> equal result", () => {
    const input = D(unanimous(), "uphold");
    expect(aggregateDeliberation(input)).toEqual(aggregateDeliberation(input));
  });
});

describe("selectFinalRound (deterministic, target-round only)", () => {
  it("picks round=2 for every lens when any R2 exists", () => {
    const r1 = [
      P("correctness", "in_scope", { round: 1 }),
      P("scope_fit", "in_scope", { round: 1 }),
      P("spec_adherence", "in_scope", { round: 1 }),
    ];
    const r2 = [
      P("correctness", "out_of_scope", { round: 2 }),
      P("scope_fit", "out_of_scope", { round: 2 }),
      P("spec_adherence", "out_of_scope", { round: 2 }),
    ];
    const sel = selectFinalRound([...r1, ...r2]);
    expect(sel.every((p) => p.round === 2)).toBe(true);
    expect(sel).toHaveLength(3);
  });
  it("picks round=1 when no round=2 exists (critique skipped)", () => {
    const r1 = [
      P("correctness", "in_scope", { round: 1 }),
      P("scope_fit", "in_scope", { round: 1 }),
      P("spec_adherence", "in_scope", { round: 1 }),
    ];
    expect(selectFinalRound(r1).every((p) => p.round === 1)).toBe(true);
  });
  it("codex#252-P1: partial-R2 mix (2 lenses R2, 1 only R1) -> targetRound=2 drops R1 lens -> <3 -> downstream escalate", () => {
    const mix = [
      P("correctness", "in_scope", { round: 2 }),
      P("scope_fit", "in_scope", { round: 2 }),
      P("spec_adherence", "in_scope", { round: 1 }),
    ];
    const sel = selectFinalRound(mix);
    expect(sel).toHaveLength(2);
    expect(aggregateDeliberation(D(sel, "uphold")).decision).toBe("escalate");
  });
  it("duplicate (lens,round) -> length>3 / non-distinct -> downstream escalate", () => {
    const dup = [
      P("correctness", "in_scope", { round: 2 }),
      P("correctness", "in_scope", { round: 2 }),
      P("scope_fit", "in_scope", { round: 2 }),
      P("spec_adherence", "in_scope", { round: 2 }),
    ];
    const sel = selectFinalRound(dup);
    expect(sel.length).toBeGreaterThan(3);
    expect(aggregateDeliberation(D(sel, "uphold")).decision).toBe("escalate");
  });
});
