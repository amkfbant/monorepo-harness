import {
  aggregateJuryVotes,
  aggregateDeliberation,
  selectFinalRound,
} from "./aggregation.js";
import { auditSeverity, type SeverityAuditResult } from "./severity-audit.js";
import {
  generateJuryProposals,
  type JuryProposerFinding,
} from "./proposer.js";
import { runCritiqueRound } from "./critique.js";
import {
  runClassificationRefuter,
  type RefuterInput,
  type RefuterRefutationCondition,
  type RefuterVoteChange,
} from "./refuter.js";
import { computeDeliberationId, gateInputSha256 } from "./ids.js";
import {
  type DeliberationInput,
  type DeliberationResult,
  type JuryClassificationProposal,
  type JuryProposedScope,
  type JuryProposerDeps,
  type RefuterVerdict,
  type VerifiedJuryEvidence,
} from "./types.js";
import type { HitchFindingSeverity } from "../types.js";

/**
 * #230 Task C4 — Stage1-5 deliberation orchestration (in-memory). Layer 2.
 *
 * `deliberate` runs the full pipeline for ONE harness-origin `unknown` finding,
 * entirely in memory (the DB stays CLOSED — opening/closing the DB and writing
 * the audit rows is the Layer 3 classify runner's job, design §3 invariant 4):
 *
 *   Stage1  generateJuryProposals (round=1, evidence already verifyEvidence-d)
 *   Stage3  runCritiqueRound      (conditional: split OR unanimous+weak evidence)
 *   ----    selectFinalRound      (round=2 if critique ran, else round=1)
 *   Stage4  runClassificationRefuter (only when final round is unanimous AND
 *           every proposal carries verified evidence; P2-j voteChanged only when
 *           critique ran)
 *   Stage5  aggregateDeliberation (the deterministic, monotonic fail-closed gate)
 *
 * Safety boundary (design §3 / §0.1 R1): Stage5 is the SOLE arbiter of
 * auto_confirm vs escalate. Deliberation can only ADD safety — a split never
 * becomes auto_confirm, a missing/refuting refuter vetoes. Before the gate runs,
 * an invariant guard asserts every final-round proposal's evidence is
 * `VerifiedJuryEvidence` (a programming-error guard, fail-closed by throw — the
 * proposer/critique always produce verified evidence, so a violation is a code
 * bug, not an LLM behavior).
 */

/** The finding metadata `deliberate` needs (prompt context + severity audit). */
export interface DeliberateFinding {
  findingId: string;
  summary: string;
  detail?: string;
  filePath?: string;
  category?: string;
  /** Immutable harness-assigned severity (advisory audit baseline). */
  harnessSeverity: HitchFindingSeverity;
}

/**
 * The refuter verdict bundled with the single unanimous verdict it attacked
 * (design §6.2 note: `target_scope` is the Stage4 trigger value). `null` target
 * is impossible when a verdict exists, but the field documents the linkage the
 * Layer 3 persistence (`jury_classification_refutations.target_scope`) needs.
 */
export interface DeliberationRefutation {
  verdict: RefuterVerdict;
  targetScope: Exclude<JuryProposedScope, "unknown">;
}

/**
 * Everything Layer 3 needs to persist + decide. `proposals` carries BOTH the
 * round-1 and (when critique ran) round-2 proposals for audit persistence; the
 * gate consumed only the selected final round. `refutation` is `null` when the
 * refuter never ran. `severityAudit` is advisory-only.
 */
export interface DeliberationOutcome {
  deliberationId: string;
  /** ALL proposals (round 1 AND round 2) for append-only audit persistence. */
  proposals: JuryClassificationProposal[];
  /** The Stage4 refutation + its target scope, or null when the refuter skipped. */
  refutation: DeliberationRefutation | null;
  /** Advisory-only severity audit (design §4.3 / §3 invariant 6). */
  severityAudit: SeverityAuditResult;
  /** The deterministic gate result — the only thing that drives state. */
  result: DeliberationResult;
  /** Whether the conditional critique round ran (P2-j / packet linkage). */
  critiqueRan: boolean;
}

/** Map the deliberate finding to the proposer's finding shape (Stage1/Stage3). */
function toProposerFinding(finding: DeliberateFinding): JuryProposerFinding {
  return {
    findingId: finding.findingId,
    summary: finding.summary,
    ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
    ...(finding.filePath !== undefined ? { filePath: finding.filePath } : {}),
    ...(finding.category !== undefined ? { category: finding.category } : {}),
  };
}

/**
 * Decide whether to run Stage3 critique (design §2 Stage3 / §0.1 R9 / P2-b):
 * trigger IFF round 1 is non-unanimous (`split`). A clean unanimous round-1
 * skips straight to Stage4.
 *
 * FIX 5 (efficacy P2): the former "unanimous AND weak evidence" branch was
 * UNREACHABLE and is removed. A lens is `complete` IFF it carries >=1 verified
 * evidence (proposer `statusForVerified`); a lens with zero verified evidence is
 * therefore `inconclusive`, which makes the round-1 aggregate non-unanimous
 * (`split`). So "unanimous" already implies every lens has >=1 verified evidence
 * — the weak-and-unanimous case cannot arise, and even if it could, critique
 * cannot manufacture verified evidence (the gate would still escalate). The
 * single `split` trigger is exact and honest.
 */
function shouldRunCritique(
  r1Proposals: readonly JuryClassificationProposal[],
): boolean {
  return aggregateJuryVotes(r1Proposals).decision === "split";
}

/**
 * Whether every proposal in the set carries verified evidence (design §0.1 R1
 * `allHaveVerifiedEvidence`): at least one `verified===true` entry, and every
 * entry is `verifyEvidence`-d (`verified !== undefined`). This is the Stage4
 * trigger condition the caller checks alongside scope unanimity.
 */
function everyProposalVerified(
  proposals: readonly JuryClassificationProposal[],
): boolean {
  return (
    proposals.length > 0 &&
    proposals.every(
      (p) =>
        p.evidence.length > 0 &&
        p.evidence.every((e) => e.verified !== undefined) &&
        p.evidence.some((e) => e.verified === true),
    )
  );
}

/**
 * Gate-direct invariant guard (design §0.1 R1): EVERY final-round proposal's
 * evidence must be `VerifiedJuryEvidence` (each `e.verified !== undefined`)
 * before `aggregateDeliberation` runs. The proposer/critique always produce
 * verified evidence, so a violation is a programming error — throw (fail-closed)
 * rather than feed un-recomputed evidence to the gate.
 */
function assertFinalRoundVerified(
  proposals: readonly JuryClassificationProposal[],
): void {
  for (const p of proposals) {
    for (const e of p.evidence) {
      if ((e as VerifiedJuryEvidence).verified === undefined) {
        throw new Error(
          `deliberate: final-round proposal (${p.lens}) carries un-verified evidence "${e.citation}" — gate invariant violated (R1)`,
        );
      }
    }
  }
}

/** Collect the per-lens refutationConditions for the Stage4 refuter prompt. */
function refutationConditions(
  proposals: readonly JuryClassificationProposal[],
): RefuterRefutationCondition[] {
  return proposals
    .filter((p) => p.refutationCondition !== undefined)
    .map((p) => ({
      lens: p.lens,
      condition: p.refutationCondition as string,
    }));
}

/** Flatten the verified evidence across the final-round proposals (advisory). */
function verifiedEvidence(
  proposals: readonly JuryClassificationProposal[],
): VerifiedJuryEvidence[] {
  return proposals.flatMap((p) =>
    p.evidence.filter((e) => e.verified === true),
  );
}

/** Per-lens R1->R2 vote changes (only meaningful when critique ran; P2-j). */
function voteChanges(
  finalRound: readonly JuryClassificationProposal[],
): RefuterVoteChange[] {
  return finalRound.map((p) => ({
    lens: p.lens,
    voteChanged: p.voteChanged ?? false,
  }));
}

/** Build the advisory severity audit over the 3 proposers' severity votes. */
function buildSeverityAudit(
  finding: DeliberateFinding,
  finalRound: readonly JuryClassificationProposal[],
): SeverityAuditResult {
  return auditSeverity({
    harnessSeverity: finding.harnessSeverity,
    juryVotes: finalRound
      .filter((p) => p.proposedSeverity !== undefined)
      .map((p) => ({
        lens: p.lens,
        juryProposedSeverity: p.proposedSeverity as HitchFindingSeverity,
        ...(p.reasoning !== undefined ? { reasoning: p.reasoning } : {}),
      })),
    finding: { findingId: finding.findingId, summary: finding.summary },
  });
}

/**
 * Orchestrate the full Stage1-5 deliberation for one finding, in memory.
 * Returns a `DeliberationOutcome` carrying everything Layer 3 needs to persist
 * (all proposals, the refutation + target scope, the severity audit) and to
 * decide (the deterministic gate `result`). Performs NO DB IO.
 */
export async function deliberate(
  finding: DeliberateFinding,
  deps: JuryProposerDeps,
  hitchId: string,
): Promise<DeliberationOutcome> {
  const proposerFinding = toProposerFinding(finding);

  // Stage1: 3 independent lens proposals (round 1), evidence already verified.
  const r1Proposals = await generateJuryProposals(deps, proposerFinding);

  // Stage3 (conditional): mutual critique -> round-2 proposals.
  const critiqueRan = shouldRunCritique(r1Proposals);
  const r2Proposals = critiqueRan
    ? await runCritiqueRound(deps, proposerFinding, r1Proposals)
    : [];

  // All proposals (R1 + R2) are carried for audit persistence (design §6.1).
  const allProposals = [...r1Proposals, ...r2Proposals];

  // selectFinalRound: round 2 when critique ran (every lens must supply R2),
  // else round 1 — fail-closed (missing/duplicate -> split at the gate).
  const finalRound = selectFinalRound(allProposals);

  // Stage4 (conditional): the adversarial refuter runs ONLY when the final round
  // is unanimous AND every proposal carries verified evidence (design §2 Stage4).
  const finalAgg = aggregateJuryVotes(finalRound);
  const finalUnanimous = finalAgg.decision === "unanimous";
  const refuterRuns = finalUnanimous && everyProposalVerified(finalRound);

  let refutation: DeliberationRefutation | null = null;
  if (refuterRuns) {
    // finalAgg.scope is necessarily in_scope/out_of_scope when unanimous.
    const targetScope = finalAgg.scope as Exclude<JuryProposedScope, "unknown">;
    const refuterInput: RefuterInput = {
      findingId: finding.findingId,
      ...(finding.filePath !== undefined ? { filePath: finding.filePath } : {}),
      ...(finding.category !== undefined ? { category: finding.category } : {}),
      unanimousScope: targetScope,
      refutationConditions: refutationConditions(finalRound),
      verifiedEvidence: verifiedEvidence(finalRound),
      // P2-j: pass voteChanged ONLY when critique ran (skip -> omit).
      ...(critiqueRan ? { voteChanges: voteChanges(finalRound) } : {}),
    };
    const verdict = await runClassificationRefuter(deps, refuterInput);
    refutation = { verdict, targetScope };
  }

  // Gate-direct invariant (R1): final-round evidence must all be verified.
  assertFinalRoundVerified(finalRound);

  // Stage5: deterministic gate. Compute the deliberation id from the gate input.
  const gateInput = {
    proposals: finalRound,
    refuterVerdict: refutation?.verdict ?? null,
  };
  const deliberationId = computeDeliberationId(
    hitchId,
    finding.findingId,
    gateInputSha256(gateInput),
  );

  const deliberationInput: DeliberationInput = {
    findingId: finding.findingId,
    deliberationId,
    finding: {
      ...(finding.filePath !== undefined ? { filePath: finding.filePath } : {}),
      ...(finding.category !== undefined ? { category: finding.category } : {}),
    },
    proposals: finalRound,
    ...(refutation !== null ? { refuterVerdict: refutation.verdict } : {}),
  };
  const result = aggregateDeliberation(deliberationInput);

  // Advisory severity audit over the final-round severity votes.
  const severityAudit = buildSeverityAudit(finding, finalRound);

  return {
    deliberationId,
    proposals: allProposals,
    refutation,
    severityAudit,
    result,
    critiqueRan,
  };
}
