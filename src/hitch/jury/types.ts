import type { CodexExecRunner } from "../../codex/codex-exec-runner.js";
import type { GlobalPolicy, RepoPolicy } from "../../policy/schema.js";
import type {
  HitchFindingSeverity,
  HitchNextAction,
  HitchScopeStatus,
} from "../types.js";

/**
 * #230 deliberation jury — pure type definitions (Layer 1).
 *
 * These types model the "independent proposal -> deterministic evidence check
 * -> mutual critique -> adversarial refutation -> monotonic fail-closed gate"
 * pipeline (design §5.1/§5.2/§0.1). The module is type-only: it declares no
 * runtime values except the `JURY_LENSES` tuple.
 *
 * Safety boundary (design §0.1 R1): evidence is split into two brand-like
 * tiers. The LLM/proposer can only produce `RawJuryEvidence` (citation/kind/
 * claim). Only `verifyEvidence` produces `VerifiedJuryEvidence` (adds a
 * deterministically recomputed `verified` flag). The deliberation gate
 * (`aggregateDeliberation`) consumes `VerifiedJuryEvidence` exclusively, so an
 * unverified `RawJuryEvidence` value cannot reach the gate by type.
 */

/** The three deliberation lenses (multi-angle, intentionally not MECE). */
export type JuryLens = "correctness" | "scope_fit" | "spec_adherence";

/** Fixed-order tuple of the deliberation lenses (drives gate iteration). */
export const JURY_LENSES = [
  "correctness",
  "scope_fit",
  "spec_adherence",
] as const satisfies readonly JuryLens[];

/**
 * Evidence as emitted by the LLM proposer / parsed by the proposer schema.
 * Carries NO `verified` field — the parse schema rejects/drops `verified` and
 * `resolvedRef` (design §0.1 R1) so the model cannot self-assert verification.
 */
export interface RawJuryEvidence {
  citation: string;
  kind: "file" | "spec" | "policy";
  claim: string;
}

/**
 * Evidence after `verifyEvidence` has deterministically recomputed `verified`
 * (and optionally `resolvedRef`). Only `verifyEvidence` produces this type;
 * the gate only accepts `VerifiedJuryEvidence`.
 */
export type VerifiedJuryEvidence = RawJuryEvidence & {
  verified: boolean;
  resolvedRef?: string;
};

/** Whether a lens produced a usable proposal, or why it could not (frozen CC5). */
export type JuryProposalStatus =
  | "complete"
  | "timeout"
  | "parse_error"
  | "inconclusive";

/** Scope a lens proposes for a finding (subset of HitchScopeStatus, frozen CC5). */
export type JuryProposedScope = "in_scope" | "out_of_scope" | "unknown";

/**
 * One lens's classification proposal for a finding. `evidence` is already
 * verified (post-`verifyEvidence`). `round` distinguishes the independent
 * round 1 proposal from the post-critique round 2 re-vote.
 */
export interface JuryClassificationProposal {
  findingId: string;
  lens: JuryLens;
  proposedScope: JuryProposedScope;
  proposalStatus: JuryProposalStatus;
  evidence: VerifiedJuryEvidence[];
  refutationCondition?: string;
  uncertainty?: string;
  reasoning?: string;
  /** Advisory only — never drives the deterministic gate. */
  confidence?: number;
  /** Severity vote carried alongside scope (severity audit; saves a call). */
  proposedSeverity?: HitchFindingSeverity;
  round: 1 | 2;
  /** Round 2 only: whether this lens changed its vote from round 1. */
  voteChanged?: boolean;
  /** Round 2 only: this lens's objection raised against the other lenses. */
  critique?: string;
}

/**
 * The adversarial refuter's verdict on a unanimous proposal set (design §4.2).
 * `uphold` does NOT create an auto_confirm by itself — the gate still requires
 * unanimity + verified+proximate evidence.
 */
export interface RefuterVerdict {
  refuteVerdict: "uphold" | "refute" | "inconclusive";
  reasoning: string;
  /** Advisory (packet record only); never gate-driving. */
  counterEvidence?: VerifiedJuryEvidence[];
}

/**
 * Input to the deterministic deliberation gate. `finding` carries the metadata
 * the deterministic proximity filter needs (design §0.1 R1 / plan PR1). The
 * `proposals` are the selected final-round, already-verified proposals.
 */
export interface DeliberationInput {
  findingId: string;
  deliberationId: string;
  finding: { filePath?: string; category?: string };
  proposals: JuryClassificationProposal[];
  refuterVerdict?: RefuterVerdict;
}

/**
 * Result of the deterministic deliberation gate. `decision` is the only thing
 * that drives state transitions. `gateTrace` is an audit-only breakdown of the
 * individual conditions (the authoritative pass condition is `aggregateJury
 * Votes`; see plan P2-d).
 */
export interface DeliberationResult {
  decision: "auto_confirm" | "escalate";
  scope?: "in_scope" | "out_of_scope";
  reason: string;
  gateTrace: {
    scopeUnanimous: boolean;
    lensDistinct: boolean;
    noInconclusive: boolean;
    allHaveVerifiedEvidence: boolean;
    proximityOk: boolean;
    /** null when the refuter never ran (escalate); boolean otherwise. */
    refuterUpheld: boolean | null;
  };
}

/** The compiled policy view `verifyEvidence` resolves policy citations against. */
export type CompiledPolicyView = { global: GlobalPolicy; repo: RepoPolicy };

/** Deterministic-IO context for `verifyEvidence` (design §4.4). */
export interface EvidenceCheckContext {
  /** Target repo worktree — `file:line` citations resolve against this. */
  worktreePath: string;
  /** Compiled policy — `policy` citations resolve against this. */
  compiledPolicy: CompiledPolicyView;
  /** `spec` citations resolve against these globs (default docs/specs/**\/*.md). */
  specDocsGlobs?: readonly string[];
}

/** The stage a proposer-side codex invocation belongs to (for log paths). */
export type JuryStage = "propose" | "critique" | "refute";

/** Per-stage log file destinations for a lens's codex invocation. */
export interface JuryStageLogPaths {
  stdout: string;
  stderr: string;
  events: string;
}

/**
 * Dependencies the jury proposer/critique/refuter stages need (design §5.1).
 * `parseSchema` is left as `unknown` here — its concrete zod shape lands with
 * the proposer (Layer 2) to avoid coupling the type-only module to zod.
 */
export interface JuryProposerDeps {
  reviewerRunner: CodexExecRunner;
  harnessRoot: string;
  worktreePath: string;
  logPaths: (
    findingId: string,
    lens: JuryLens,
    stage: JuryStage,
  ) => JuryStageLogPaths;
  timeoutMs: number;
  parseSchema: unknown;
  auditDir: string;
  evidenceCtx: EvidenceCheckContext;
}

/** What kind(s) of decision an escalate packet bundles (R14: plural). */
export type DecisionKind =
  | "classify_scope"
  | "severity_audit"
  | "operator_origin_unknown";

/** Which side raised a finding (R14: per-finding origin in a mixed batch). */
export type FindingOrigin = "harness" | "operator";

/** A finding entry inside a decision packet (design §5.2 / R14 / codex#252-P1). */
export interface DecisionPacketFinding {
  findingId: string;
  summary: string;
  detail?: string;
  filePath?: string;
  severity?: HitchFindingSeverity;
  scopeStatus?: HitchScopeStatus;
  origin?: FindingOrigin;
  /**
   * Per-finding deliberation linkage (REQUIRED). A single packet may bundle
   * several deliberations, so the id lives per finding — there is NO top-level
   * packet.deliberationId. The Layer 0 doctor reads this per-finding id.
   */
  deliberationId: string;
}

/** Rich recommendation action (design §0.1 R7 — the 3-value rich set is canon). */
export type DecisionRecommendationAction =
  | "classify_manually"
  | "review_split"
  | "review_severity";

/** One lens's vote as projected into the packet's evaluation axes. */
export interface DecisionPacketLensVote {
  lens: JuryLens;
  scope?: JuryProposedScope;
  proposalStatus?: JuryProposalStatus;
  reasoning?: string;
  confidence?: number;
  evidence?: VerifiedJuryEvidence[];
  refutationCondition?: string;
  uncertainty?: string;
  voteChanged?: boolean;
  severity?: HitchFindingSeverity;
}

/** One evaluation axis (lens) and its votes/consensus in the packet. */
export interface DecisionPacketEvaluationAxis {
  axis: JuryLens;
  lensVotes: DecisionPacketLensVote[];
  consensus: "aligned" | "split";
}

/** The severity audit summary carried in the packet (advisory; design §4.3). */
export interface DecisionPacketSeverityAudit {
  harnessSeverity: HitchFindingSeverity;
  juryConsensus?: HitchFindingSeverity;
  status: "aligned" | "diverged" | "inconclusive";
  escalate: boolean;
}

/**
 * Consultant-grade MCDA decision packet (design §5.2 + §0.1 R14). `packet
 * Version: 2`. There is NO required top-level `deliberationId` — each
 * `findings[]` entry carries its own (a packet may bundle multiple
 * deliberations). `decisionKinds` is plural so a mixed harness/operator batch
 * never hides one side's required manual action.
 */
export interface HitchDecisionPacket {
  packetVersion: 2;
  decisionKinds: DecisionKind[];
  findings: DecisionPacketFinding[];
  recommendation: {
    action: DecisionRecommendationAction;
    rationale: string;
  };
  evaluationAxes: DecisionPacketEvaluationAxis[];
  deliberation: {
    critiqueRan: boolean;
    refuter: RefuterVerdict | null;
    gateTrace: DeliberationResult["gateTrace"];
  };
  rejectedProposals: Array<{
    scope: JuryProposedScope;
    lensCount: number;
    reason: string;
  }>;
  minorityView: {
    count: number;
    scopes: JuryProposedScope[];
    reasoning: string;
  } | null;
  riskFlags: Array<{ flag: string; impact: string; mitigation: string }>;
  unvalidatedAssumptions: Array<{
    assumption: string;
    source: string;
    verification: string;
  }>;
  nextActions: Array<{
    owner: "operator";
    action: string;
    verificationMethod: string;
  }>;
  severityAudit?: DecisionPacketSeverityAudit;
}

/**
 * Structured return type of the classify runner (design §5.1). On `resolved`
 * the run classified deterministically (an optional non-escalating severity
 * audit packet may accompany a severity divergence). On `!resolved` the runner
 * escalates with a manual next action.
 *
 * NOTE: the orchestrator-types classify signature is NOT switched to this union
 * in Task B1 — the runner rewrite + signature switch land together in Layer 3
 * (Task D1). Exporting the type here keeps B1 typecheck fully green.
 */
export type ClassifyRunnerResult =
  | { resolved: true; severityAuditPacket?: HitchDecisionPacket }
  | {
      resolved: false;
      decision: "escalate";
      escalateReason: string;
      recommendedNextAction: HitchNextAction;
    };

/**
 * Compile-level safety proof (design §0.1 R1 / plan P2-g).
 *
 * The deliberation gate consumes only `VerifiedJuryEvidence`, so unverified
 * `RawJuryEvidence` MUST NOT be assignable to it (the `verified` flag is
 * missing). This assertion lives in `src/` because `tsconfig.json` excludes
 * `tests/` from typecheck — placing it here makes the brand boundary genuinely
 * load-bearing under `npm run typecheck`: if a future edit made
 * `RawJuryEvidence` assignable to `VerifiedJuryEvidence`, `_RawIsNotVerified`
 * would resolve to `false` and this declaration would fail to compile.
 */
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type _RawIsNotVerified = IsAssignable<
  RawJuryEvidence,
  VerifiedJuryEvidence
>;
const _assertRawIsNotVerified: _RawIsNotVerified extends false ? true : never =
  true;
void _assertRawIsNotVerified;
