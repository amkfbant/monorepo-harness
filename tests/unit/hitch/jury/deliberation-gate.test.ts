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
  it("FIX 1 (codex P1): a '../'-traversal citation cannot spoof the first path segment for proximity -> escalate (proximityOk false)", () => {
    // The RAW first two segments of "src/a.ts/../../vendor/x.ts" are
    // ["src","a.ts"], which would naively match finding.filePath "src/a.ts".
    // Proximity must be computed on the NORMALIZED relative path
    // (vendor/x.ts), so the spoof fails and the gate escalates.
    const spoof = [
      P("correctness", "in_scope", {
        evidence: [v("src/a.ts/../../vendor/x.ts:1")],
      }),
      P("scope_fit", "in_scope", {
        evidence: [v("src/a.ts/../../vendor/y.ts:1")],
      }),
      P("spec_adherence", "in_scope", {
        evidence: [v("src/a.ts/../../vendor/z.ts:1")],
      }),
    ];
    const r = aggregateDeliberation(D(spoof, "uphold"));
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

  it("FINDING 1: non-string citation (file kind) -> fail-closed escalate, never throws (proximityOk false)", () => {
    // The gate is the SOLE arbiter of auto_confirm vs escalate. A malformed
    // citation (cast via `as any` to bypass the brand) must FAIL CLOSED, not
    // crash the orchestrator with a TypeError out of seg()'s `.split`.
    const malformed = [
      P("correctness", "in_scope", {
        evidence: [{ citation: 123 as any, kind: "file", claim: "c", verified: true }],
      }),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "in_scope"),
    ];
    const input = D(malformed, "uphold");
    let r: ReturnType<typeof aggregateDeliberation> | undefined;
    expect(() => {
      r = aggregateDeliberation(input);
    }).not.toThrow();
    expect(r?.decision).toBe("escalate");
    expect(r?.gateTrace.proximityOk).toBe(false);
  });

  it("FINDING 2 (P2-c): scope SPLIT but all-complete + distinct lenses -> gateTrace independence (scopeUnanimous false, noInconclusive true, lensDistinct true) -> escalate", () => {
    // Pins that noInconclusive / lensDistinct are computed INDEPENDENTLY of
    // scopeUnanimous (not a tautology). The P2b doctor re-verification relies
    // on these audit fields being individually trustworthy.
    const split = [
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "out_of_scope"),
    ];
    const r = aggregateDeliberation(D(split, "uphold"));
    expect(r.decision).toBe("escalate");
    expect(r.gateTrace).toMatchObject({
      scopeUnanimous: false,
      noInconclusive: true,
      lensDistinct: true,
    });
  });

  it("FINDING 3 (spec kind, exact token): unanimous + spec citation whose token-set INCLUDES finding.category + uphold -> auto_confirm (proximityOk true)", () => {
    // spec/policy proximity branch: resolvedRef??citation token-split must
    // contain finding.category as an EXACT token. Here category 'core' is a
    // whole token of the citation, so proximity passes.
    const specEv = (citation: string, resolvedRef?: string) =>
      ({ citation, kind: "spec" as const, claim: "c", verified: true, resolvedRef });
    const proposals = [
      P("correctness", "in_scope", { evidence: [specEv("docs/specs/core.md#x")] }),
      P("scope_fit", "in_scope", { evidence: [specEv("docs/specs/core.md#y")] }),
      P("spec_adherence", "in_scope", { evidence: [specEv("docs/specs/core.md#z")] }),
    ];
    const r = aggregateDeliberation(D(proposals, "uphold"));
    expect(r.decision).toBe("auto_confirm");
    expect(r.scope).toBe("in_scope");
    expect(r.gateTrace.proximityOk).toBe(true);
  });

  it("FINDING 3 (spec kind, substring is NOT enough): finding.category is only a SUBSTRING of a token -> proximityOk false -> escalate", () => {
    // codex#252-P1 anti-substring fix: category 'api' must NOT match the token
    // 'rapid-api' (the token-split keeps 'rapid-api' whole, so includes('api')
    // on the token array is false).
    const substringFinding = { filePath: "src/a.ts", category: "api" };
    const specEv = (citation: string) =>
      ({ citation, kind: "spec" as const, claim: "c", verified: true });
    const proposals = [
      P("correctness", "in_scope", { evidence: [specEv("docs/specs/rapid-api.md#x")] }),
      P("scope_fit", "in_scope", { evidence: [specEv("docs/specs/rapid-api.md#y")] }),
      P("spec_adherence", "in_scope", { evidence: [specEv("docs/specs/rapid-api.md#z")] }),
    ];
    const r = aggregateDeliberation({
      findingId: "f",
      deliberationId: "d1",
      finding: substringFinding,
      proposals,
      refuterVerdict: { refuteVerdict: "uphold", reasoning: "x" },
    });
    expect(r.decision).toBe("escalate");
    expect(r.gateTrace.proximityOk).toBe(false);
  });

  it("FINDING 5: deterministic reason string + out_of_scope auto_confirm", () => {
    // auto_confirm reason format: `auto_confirm <scope> (deliberation upheld)`;
    // out_of_scope unanimous + proximate (filePath proximity) + uphold passes.
    const oos = [
      P("correctness", "out_of_scope"),
      P("scope_fit", "out_of_scope"),
      P("spec_adherence", "out_of_scope"),
    ];
    const ok = aggregateDeliberation(D(oos, "uphold"));
    expect(ok.decision).toBe("auto_confirm");
    expect(ok.scope).toBe("out_of_scope");
    expect(ok.reason).toBe("auto_confirm out_of_scope (deliberation upheld)");

    // escalate reason format: `escalate: <agg.reason>` (here a split aggregate).
    const split = [
      P("correctness", "in_scope"),
      P("scope_fit", "in_scope"),
      P("spec_adherence", "out_of_scope"),
    ];
    const esc = aggregateDeliberation(D(split, "uphold"));
    expect(esc.decision).toBe("escalate");
    expect(esc.reason).toBe(
      "escalate: split votes: in_scope(2), out_of_scope(1), unknown(0), incomplete(0)",
    );
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
