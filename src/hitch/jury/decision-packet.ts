import type { HitchFinding } from "../types.js";
import {
  JURY_LENSES,
  type DecisionPacketEvaluationAxis,
  type DecisionPacketFinding,
  type DecisionPacketLensVote,
  type DecisionPacketSeverityAudit,
  type DeliberationResult,
  type FindingOrigin,
  type HitchDecisionPacket,
  type JuryClassificationProposal,
  type JuryLens,
  type RefuterVerdict,
} from "./types.js";

/**
 * #230 deliberation jury — MCDA decision packet v2 formatters (Layer 1, pure).
 *
 * These are PURE functions: each builds a `packetVersion: 2`
 * `HitchDecisionPacket` from deliberation results with no IO and no state
 * transition (same input -> deep-equal output, JSON round-trippable). They are
 * deliberately separated from the LLM/orchestration layers so the packet shape
 * can never be driven by model output (design §5.2 / §5.3).
 *
 * Safety / contract anchors:
 * - RED-11 (frozen gate-specs §5.4): `findings[]` keep `summary`/`detail`/
 *   `severity`/`scopeStatus` verbatim; `evaluationAxes[].lensVotes[]` keep
 *   `scope` + `proposalStatus` + `reasoning` verbatim.
 * - R14: `decisionKinds` is the PLURAL array; each `findings[]` entry carries
 *   its own `deliberationId` and `origin`; `nextActions[]` lists EVERY finding's
 *   required manual action so a mixed batch never hides one side's action.
 * - R7: `recommendation.action` ∈ {classify_manually, review_split,
 *   review_severity}.
 * - R2: a lens's `proposedSeverity` round-trips into `lensVotes[].severity`.
 * - R1 surfacing: UNVERIFIED evidence (`verified !== true`) is recorded in
 *   `unvalidatedAssumptions[]`, never in `evaluationAxes` evidence.
 */

/** One finding's split deliberation, ready to be formatted into a packet. */
export interface JurySplitDeliberation {
  finding: HitchFinding;
  /** Per-finding deliberation linkage (R14 / codex#252-P1). */
  deliberationId: string;
  /** The selected final-round proposals (already verified, possibly split). */
  proposals: readonly JuryClassificationProposal[];
  /** The adversarial refuter's verdict, if it ran; otherwise null. */
  refuter: RefuterVerdict | null;
  /** Whether the critique round (Stage 3) ran for this deliberation. */
  critiqueRan: boolean;
  /** The deterministic gate trace for this deliberation. */
  gateTrace: DeliberationResult["gateTrace"];
}

/** Input to `buildJurySplitPacket` (a bundle of one or more split findings). */
export interface JurySplitInput {
  splits: readonly JurySplitDeliberation[];
}

/** Input to `buildOperatorOriginPacket` (operator-origin unknowns, R5). */
export interface OperatorOriginInput {
  findings: readonly HitchFinding[];
  /** Per-finding deliberation id keyed by `findingId` (R14). */
  deliberationIds: Readonly<Record<string, string>>;
}

/** Input to `buildSeverityAuditPacket` (a single advisory severity divergence). */
export interface SeverityAuditPacketInput {
  finding: HitchFinding;
  deliberationId: string;
  audit: DecisionPacketSeverityAudit;
}

/** Project a HitchFinding into a packet finding entry (RED-11 anchors verbatim). */
function toPacketFinding(
  finding: HitchFinding,
  deliberationId: string,
  origin: FindingOrigin,
): DecisionPacketFinding {
  return {
    findingId: finding.findingId,
    summary: finding.summary,
    ...(finding.detail !== null ? { detail: finding.detail } : {}),
    ...(finding.filePath !== null ? { filePath: finding.filePath } : {}),
    severity: finding.severity,
    scopeStatus: finding.scopeStatus,
    origin,
    deliberationId,
  };
}

/** Project one lens proposal into a packet lens vote (RED-11 + R2 severity). */
function toLensVote(p: JuryClassificationProposal): DecisionPacketLensVote {
  const verified = p.evidence.filter((e) => e.verified === true);
  return {
    lens: p.lens,
    scope: p.proposedScope,
    proposalStatus: p.proposalStatus,
    ...(p.reasoning !== undefined ? { reasoning: p.reasoning } : {}),
    ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
    // R1: only verified evidence reaches the evaluation axes. Unverified
    // citations are surfaced in unvalidatedAssumptions instead.
    ...(verified.length > 0 ? { evidence: verified } : {}),
    ...(p.refutationCondition !== undefined
      ? { refutationCondition: p.refutationCondition }
      : {}),
    ...(p.uncertainty !== undefined ? { uncertainty: p.uncertainty } : {}),
    ...(p.voteChanged !== undefined ? { voteChanged: p.voteChanged } : {}),
    // R2: proposedSeverity round-trips into the packet's lensVotes[].severity.
    ...(p.proposedSeverity !== undefined
      ? { severity: p.proposedSeverity }
      : {}),
  };
}

/** Build the per-lens evaluation axes from a deliberation's proposals. */
function toEvaluationAxes(
  proposals: readonly JuryClassificationProposal[],
): DecisionPacketEvaluationAxis[] {
  return JURY_LENSES.map((lens: JuryLens) => {
    const forLens = proposals.filter((p) => p.lens === lens);
    const lensVotes = forLens.map(toLensVote);
    const scopes = new Set(forLens.map((p) => p.proposedScope));
    // `aligned` only when this lens has exactly one vote with a single scope;
    // anything else (missing / duplicate / multi-scope) is `split` (fail-closed).
    const consensus: "aligned" | "split" =
      forLens.length === 1 && scopes.size === 1 ? "aligned" : "split";
    return { axis: lens, lensVotes, consensus };
  });
}

/**
 * Collect UNVERIFIED evidence across a deliberation's proposals into
 * `unvalidatedAssumptions[]` (R1: it never appears in evaluation axes). The
 * citation text is embedded so an operator can locate the unverifiable claim.
 */
function toUnvalidatedAssumptions(
  splits: readonly JurySplitDeliberation[],
): HitchDecisionPacket["unvalidatedAssumptions"] {
  const out: HitchDecisionPacket["unvalidatedAssumptions"] = [];
  for (const split of splits) {
    for (const p of split.proposals) {
      for (const e of p.evidence) {
        if (e.verified === true) continue;
        out.push({
          assumption: `unverified ${e.kind} citation "${e.citation}": ${e.claim}`,
          source: `finding ${p.findingId} lens ${p.lens}`,
          verification: "operator confirms the citation exists and supports the claim",
        });
      }
    }
  }
  return out;
}

/** Compute the minority view (the non-majority scopes) for a split set. */
function toMinorityView(
  proposals: readonly JuryClassificationProposal[],
): HitchDecisionPacket["minorityView"] {
  const counts = new Map<JuryClassificationProposal["proposedScope"], number>();
  for (const p of proposals) {
    counts.set(p.proposedScope, (counts.get(p.proposedScope) ?? 0) + 1);
  }
  if (counts.size <= 1) return null;
  const maxCount = Math.max(...counts.values());
  const minorityScopes = [...counts.entries()]
    .filter(([, c]) => c < maxCount)
    .map(([scope]) => scope);
  if (minorityScopes.length === 0) return null;
  const count = minorityScopes.reduce(
    (sum, scope) => sum + (counts.get(scope) ?? 0),
    0,
  );
  return {
    count,
    scopes: minorityScopes,
    reasoning: "lens(es) dissenting from the plurality scope",
  };
}

/** Build the `rejectedProposals` summary (one entry per non-empty scope group). */
function toRejectedProposals(
  proposals: readonly JuryClassificationProposal[],
): HitchDecisionPacket["rejectedProposals"] {
  const counts = new Map<JuryClassificationProposal["proposedScope"], number>();
  for (const p of proposals) {
    counts.set(p.proposedScope, (counts.get(p.proposedScope) ?? 0) + 1);
  }
  return [...counts.entries()].map(([scope, lensCount]) => ({
    scope,
    lensCount,
    reason: `${lensCount} lens(es) proposed ${scope}`,
  }));
}

/**
 * Build a `review_split` packet for one or more harness-origin findings whose
 * jury deliberation did NOT reach auto_confirm. `decisionKinds` is plural and
 * carries `classify_scope`; every finding gets its own `nextAction` so a
 * bundled batch never hides a required manual action (R14).
 */
export function buildJurySplitPacket(input: JurySplitInput): HitchDecisionPacket {
  const findings = input.splits.map((s) =>
    toPacketFinding(s.finding, s.deliberationId, "harness"),
  );
  // A bundled split packet over multiple findings keeps the first
  // deliberation's gate trace + refuter as the shared deliberation block; each
  // finding's own deliberationId disambiguates rows downstream.
  const lead = input.splits[0];
  const deliberation: HitchDecisionPacket["deliberation"] = {
    critiqueRan: lead?.critiqueRan ?? false,
    refuter: lead?.refuter ?? null,
    gateTrace: lead?.gateTrace ?? {
      scopeUnanimous: false,
      lensDistinct: false,
      noInconclusive: false,
      allHaveVerifiedEvidence: false,
      proximityOk: false,
      refuterUpheld: null,
    },
  };
  const allProposals = input.splits.flatMap((s) => [...s.proposals]);
  const nextActions: HitchDecisionPacket["nextActions"] = input.splits.map(
    (s) => ({
      owner: "operator" as const,
      action: `classify finding ${s.finding.findingId} manually (jury split on scope)`,
      verificationMethod: `scope decision recorded for finding ${s.finding.findingId}`,
    }),
  );
  return {
    packetVersion: 2,
    decisionKinds: ["classify_scope"],
    findings,
    recommendation: {
      action: "review_split",
      rationale:
        "jury did not reach a unanimous, verified, refuter-upheld scope; operator decides scope",
    },
    evaluationAxes: toEvaluationAxes(allProposals),
    deliberation,
    rejectedProposals: toRejectedProposals(allProposals),
    minorityView: toMinorityView(allProposals),
    riskFlags: [],
    unvalidatedAssumptions: toUnvalidatedAssumptions(input.splits),
    nextActions,
  };
}

/**
 * Build a `classify_manually` packet for operator-origin (human/mcp) findings
 * whose scope is unknown. These are NEVER machine-classified (R5 / fail-closed)
 * — they are escalated for manual classification. `findings[].origin` is
 * `operator` and `decisionKinds` carries `operator_origin_unknown`.
 */
export function buildOperatorOriginPacket(
  input: OperatorOriginInput,
): HitchDecisionPacket {
  const findings = input.findings.map((f) =>
    toPacketFinding(f, input.deliberationIds[f.findingId] ?? "", "operator"),
  );
  const nextActions: HitchDecisionPacket["nextActions"] = input.findings.map(
    (f) => ({
      owner: "operator" as const,
      action: `classify operator-origin finding ${f.findingId} manually (not machine-classified)`,
      verificationMethod: `scope decision recorded for finding ${f.findingId}`,
    }),
  );
  return {
    packetVersion: 2,
    decisionKinds: ["operator_origin_unknown"],
    findings,
    recommendation: {
      action: "classify_manually",
      rationale:
        "operator-origin unknown findings are not machine-classified (fail-closed); operator classifies manually",
    },
    evaluationAxes: [],
    deliberation: {
      critiqueRan: false,
      refuter: null,
      gateTrace: {
        scopeUnanimous: false,
        lensDistinct: false,
        noInconclusive: false,
        allHaveVerifiedEvidence: false,
        proximityOk: false,
        refuterUpheld: null,
      },
    },
    rejectedProposals: [],
    minorityView: null,
    riskFlags: [],
    unvalidatedAssumptions: [],
    nextActions,
  };
}

/**
 * Build a `review_severity` packet recording an advisory severity audit
 * divergence. The harness severity is NEVER changed by the audit; this packet
 * surfaces the divergence for human review (`decisionKinds` =
 * `severity_audit`).
 */
export function buildSeverityAuditPacket(
  input: SeverityAuditPacketInput,
): HitchDecisionPacket {
  return {
    packetVersion: 2,
    decisionKinds: ["severity_audit"],
    findings: [toPacketFinding(input.finding, input.deliberationId, "harness")],
    recommendation: {
      action: "review_severity",
      rationale: `jury severity audit ${input.audit.status}; harness severity ${input.audit.harnessSeverity} unchanged (advisory)`,
    },
    evaluationAxes: [],
    deliberation: {
      critiqueRan: false,
      refuter: null,
      gateTrace: {
        scopeUnanimous: false,
        lensDistinct: false,
        noInconclusive: false,
        allHaveVerifiedEvidence: false,
        proximityOk: false,
        refuterUpheld: null,
      },
    },
    rejectedProposals: [],
    minorityView: null,
    riskFlags: [],
    unvalidatedAssumptions: [],
    nextActions: [
      {
        owner: "operator",
        action: `review severity for finding ${input.finding.findingId} (jury ${input.audit.status})`,
        verificationMethod: `severity decision recorded for finding ${input.finding.findingId}`,
      },
    ],
    severityAudit: input.audit,
  };
}
