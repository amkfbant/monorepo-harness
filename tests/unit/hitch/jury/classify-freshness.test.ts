import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCitationsStillFresh } from "../../../../src/hitch/jury/classify-runner.js";
import type { DeliberationOutcome } from "../../../../src/hitch/jury/deliberate.js";
import type {
  EvidenceCheckContext,
  JuryClassificationProposal,
  JuryLens,
  VerifiedJuryEvidence,
} from "../../../../src/hitch/jury/types.js";
import type { GlobalPolicy, RepoPolicy } from "../../../../src/policy/schema.js";

/**
 * #230 Task D1 — freshness re-stat is FINAL-ROUND ONLY (codex#252-P2 / §P2a).
 *
 * `outcome.proposals` carries BOTH round 1 and round 2 (deliberate.ts:
 * `[...r1Proposals, ...r2Proposals]`). The Phase-3 freshness re-stat must
 * re-check ONLY the FINAL-round proposals (the round the gate consumed) — a
 * stale round-1 citation that did NOT drive the auto_confirm must not withdraw
 * it. These tests pin that contract at the function boundary because the
 * production critique path reuses round-1 evidence in round-2 (so the divergent
 * R1-only-stale case cannot be staged through the routed end-to-end path).
 */

function makeWorktree(line5Present: boolean): EvidenceCheckContext {
  const root = mkdtempSync(join(tmpdir(), "jury-freshness-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // line5Present=true -> a.ts has 10 lines (line 5 valid). false -> 1 line
  // (line 5 out of range -> a stale `src/a.ts:5` citation).
  const lines = line5Present ? 10 : 1;
  writeFileSync(
    join(root, "src", "a.ts"),
    Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    "utf8",
  );
  const global: GlobalPolicy = { always_deny_write: [], ignore_untracked: [] };
  const repo: RepoPolicy = { repo_id: "t", read: [], domains: {} };
  return { worktreePath: root, compiledPolicy: { global, repo } };
}

function fileEvidence(citation: string): VerifiedJuryEvidence {
  return { citation, kind: "file", claim: "touches this line", verified: true };
}

function proposal(
  lens: JuryLens,
  round: 1 | 2,
  citation: string,
): JuryClassificationProposal {
  return {
    findingId: "f1",
    lens,
    proposedScope: "in_scope",
    proposalStatus: "complete",
    evidence: [fileEvidence(citation)],
    round,
  };
}

/**
 * Build an outcome where the FINAL round is round 2 (critique ran). The round-1
 * proposals cite the (now-stale) `src/a.ts:5`; the round-2 (final) proposals
 * cite the still-valid `src/a.ts:1`. Iterating ALL rounds would flag the stale
 * R1 citation; iterating final-round-only must NOT.
 */
function outcomeWithStaleR1FreshR2(): DeliberationOutcome {
  const lenses: JuryLens[] = ["correctness", "scope_fit", "spec_adherence"];
  const r1 = lenses.map((l) => proposal(l, 1, "src/a.ts:5"));
  const r2 = lenses.map((l) => proposal(l, 2, "src/a.ts:1"));
  return {
    deliberationId: "d".repeat(64),
    proposals: [...r1, ...r2],
    refutation: null,
    severityAudit: {
      harnessSeverity: "P1",
      status: "aligned",
      escalate: false,
      reasoning: "n/a",
    },
    result: {
      decision: "auto_confirm",
      scope: "in_scope",
      reason: "auto_confirm in_scope (deliberation upheld)",
      gateTrace: {
        scopeUnanimous: true,
        lensDistinct: true,
        noInconclusive: true,
        allHaveVerifiedEvidence: true,
        proximityOk: true,
        refuterUpheld: true,
      },
    },
    critiqueRan: true,
  };
}

describe("fileCitationsStillFresh — final-round-only (#230 D1)", () => {
  it("a stale round-1 citation absent from the final round does NOT withdraw freshness", () => {
    // Worktree has only 1 line: `src/a.ts:5` (round-1) is stale, `src/a.ts:1`
    // (round-2 / final) is fresh. Final-round-only re-stat must return true.
    const ctx = makeWorktree(false);
    expect(fileCitationsStillFresh(outcomeWithStaleR1FreshR2(), ctx)).toBe(true);
  });

  it("a stale citation IN the final round DOES withdraw freshness (fail-closed)", () => {
    const lenses: JuryLens[] = ["correctness", "scope_fit", "spec_adherence"];
    const r1 = lenses.map((l) => proposal(l, 1, "src/a.ts:1"));
    const r2 = lenses.map((l) => proposal(l, 2, "src/a.ts:5"));
    const outcome: DeliberationOutcome = {
      ...outcomeWithStaleR1FreshR2(),
      proposals: [...r1, ...r2],
    };
    // Worktree has only 1 line: the FINAL-round citation `src/a.ts:5` is stale.
    const ctx = makeWorktree(false);
    expect(fileCitationsStillFresh(outcome, ctx)).toBe(false);
  });

  it("no-critique outcome re-stats round 1 (round 1 IS final)", () => {
    const lenses: JuryLens[] = ["correctness", "scope_fit", "spec_adherence"];
    const r1 = lenses.map((l) => proposal(l, 1, "src/a.ts:5"));
    const outcome: DeliberationOutcome = {
      ...outcomeWithStaleR1FreshR2(),
      proposals: r1,
      critiqueRan: false,
    };
    // Worktree has 10 lines: `src/a.ts:5` (round 1 = final here) is fresh.
    expect(fileCitationsStillFresh(outcome, makeWorktree(true))).toBe(true);
    // Worktree has 1 line: `src/a.ts:5` is now stale -> final round 1 withdraws.
    expect(fileCitationsStillFresh(outcome, makeWorktree(false))).toBe(false);
  });
});
