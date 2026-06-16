import type { CodexExecRunner } from "../../codex/codex-exec-runner.js";
import type { GlobalPolicy, RepoPolicy } from "../../policy/schema.js";
import type {
  HitchFindingSeverity,
  HitchNextAction,
  HitchScopeStatus,
} from "../types.js";
import type { HitchScopeSnapshot } from "./scope-snapshot.js";

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
  /**
   * FIX 1 (codex#254 ROUND-3 P1) — the READ-ONLY frozen hitch scope snapshot
   * (goal / target operations / target files / categories / close conditions).
   * REQUIRED: every jury prompt (proposer / critique / refuter) embeds it so each
   * lens classifies the finding AGAINST the actual change scope, not just the
   * finding text. The classify runner builds it from the session it already loads
   * READ-ONLY in Phase 1; a standalone deliberation must still supply it (a
   * missing scope is a programming error, not a silent auto_confirm path).
   */
  scopeSnapshot: HitchScopeSnapshot;
  /**
   * Lease-loss abort signal (#132). Threaded from the orchestrator drive through
   * the classify runner into every proposer/critique/refuter codex call so a
   * mid-deliberation lease loss aborts the in-flight codex (fail-closed). Each
   * per-call invocation ALSO derives a `timeoutMs` controller and combines it
   * with this lease signal (`AbortSignal.any`); see `runJuryCodex`. Optional: a
   * standalone (non-orchestrated) deliberation may omit it.
   */
  signal?: AbortSignal;
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
   *
   * SENTINEL: for `origin:"operator"` findings NO deliberation ever runs (R5:
   * operator-origin unknowns are never machine-classified), so this is the empty
   * string `""`. The `""` sentinel is NEVER a real `deliberation_id`: no jury
   * audit row (`jury_classification_*`) is ever written for an operator finding,
   * and no reader/doctor treats `""` as a key — the auto_confirm replay check
   * only fires on findings whose `classification_reason` records a jury
   * auto_confirm (operator findings never get one), and the refutation check
   * loads from `jury_classification_refutations`, which operator findings never
   * populate. Treat `""` purely as "no deliberation".
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
  /**
   * Per-finding attribution (codex#254-P2 FIX1). A `review_split` packet may
   * BUNDLE several findings into ONE shared `evaluationAxes` block (each lens
   * axis then carries one vote PER bundled finding), so a vote without its
   * finding id is unattributable — an operator could apply the wrong scope to
   * the wrong finding. Always set from `JuryClassificationProposal.findingId`.
   */
  findingId: string;
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
    /**
     * Per-finding attribution (codex#254-P2 FIX1). A bundled `review_split`
     * packet tallies rejected scopes PER finding — without the finding id the
     * tallies of two bundled findings would be merged finding-blind.
     */
    findingId: string;
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
 * The `OrchestratorRunners.classify` signature returns this union (see
 * `orchestrator-types.ts`): the Layer 3 runner rewrite + signature switch
 * landed together in Task D1, so this is the live classify return shape.
 */
export type ClassifyRunnerResult =
  | {
      resolved: true;
      severityAuditPacket?: HitchDecisionPacket;
      /**
       * Additive (codex#252-P2 / plan P2-i): set when jury candidates beyond
       * `JURY_BATCH_LIMIT` remained UNPROCESSED this invocation. The orchestrator
       * halts the loop cleanly on this flag so per-invocation cost is bounded to
       * one jury batch; the next orchestrate invocation re-fires
       * needs_classification and drains the remainder. A plain `resolved:true`
       * (no flag) means the unknown set is fully drained.
       */
      moreUnknownsPending?: boolean;
    }
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
