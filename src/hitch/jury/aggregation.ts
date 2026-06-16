import { posix } from "node:path";
import {
  JURY_LENSES,
  type JuryClassificationProposal,
  type VerifiedJuryEvidence,
  type DeliberationInput,
  type DeliberationResult,
} from "./types.js";

/**
 * #230 deliberation jury — deterministic scope aggregation (Layer 1, pure).
 *
 * Frozen contract: see `docs/design/proposals/design-gate-specs.md` §1/§2.
 * This is a verbatim port of the frozen `aggregateJuryVotes` logic. It is a
 * pure function: same input -> deep-equal output, no IO, no state transition.
 *
 * Safety boundary (design-gate-specs §5):
 * - `confidence` NEVER drives the decision (no float gate).
 * - Majority is never auto-confirmed: only a full 3-lens-distinct unanimous
 *   set with zero inconclusive votes yields `unanimous`; everything else is
 *   `split` (fail-closed).
 * - No state transition happens here — the caller acts on the result.
 */

/** Result of the deterministic scope aggregation (frozen contract §2.1). */
export interface JuryAggregate {
  decision: "unanimous" | "split";
  /** Present only when `decision === 'unanimous'`. */
  scope?: "in_scope" | "out_of_scope";
  /** Fixed-format reason string (§2.4) — deterministic, character-for-character. */
  reason: string;
}

/**
 * Deterministic "inconclusive" predicate (frozen §1, CC5).
 *
 * A proposal is inconclusive when it did not complete OR its proposed scope is
 * `unknown`. Inconclusive votes can never participate in a unanimous verdict.
 */
function isInconclusive(p: JuryClassificationProposal): boolean {
  return p.proposalStatus !== "complete" || p.proposedScope === "unknown";
}

/**
 * Whether the lens set is exactly {correctness, scope_fit, spec_adherence}
 * with each lens present exactly once (frozen §2.2 CC13 — distinct required).
 */
function lensSetIsDistinctAndComplete(
  proposals: readonly JuryClassificationProposal[],
): boolean {
  const lenses = new Set(proposals.map((p) => p.lens));
  return lenses.size === JURY_LENSES.length && JURY_LENSES.every((l) => lenses.has(l));
}

/**
 * Build the fixed-order split reason string (frozen §2.4).
 *
 * Counts (fixed order in_scope -> out_of_scope -> unknown -> incomplete):
 * - N1 = scope === 'in_scope'      && status === 'complete'
 * - N2 = scope === 'out_of_scope'  && status === 'complete'
 * - N3 = scope === 'unknown'       (status-independent)
 * - N4 = status !== 'complete'     (scope-independent)
 *
 * N3 and N4 are independent dimensions and may overlap by design (a vote that
 * is both `unknown` and `timeout` contributes to both N3 and N4).
 */
function splitReason(proposals: readonly JuryClassificationProposal[]): string {
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  let n4 = 0;
  for (const p of proposals) {
    if (p.proposedScope === "in_scope" && p.proposalStatus === "complete") n1 += 1;
    if (p.proposedScope === "out_of_scope" && p.proposalStatus === "complete") n2 += 1;
    if (p.proposedScope === "unknown") n3 += 1;
    if (p.proposalStatus !== "complete") n4 += 1;
  }
  return `split votes: in_scope(${n1}), out_of_scope(${n2}), unknown(${n3}), incomplete(${n4})`;
}

/**
 * Deterministically aggregate the per-lens classification proposals into a
 * `unanimous` (auto-confirmable scope) or `split` (fail-closed -> escalate)
 * verdict.
 *
 * `unanimous` IFF (frozen §2.2):
 * - `proposals.length === 3`
 * - lens set is exactly {correctness, scope_fit, spec_adherence}, distinct
 * - no proposal `isInconclusive`
 * - all 3 `proposedScope` are identical (`in_scope` or `out_of_scope`)
 *
 * Everything else is `split` (fail-closed).
 */
export function aggregateJuryVotes(
  proposals: readonly JuryClassificationProposal[],
): JuryAggregate {
  const first = proposals[0];
  const isUnanimous =
    first !== undefined &&
    proposals.length === JURY_LENSES.length &&
    lensSetIsDistinctAndComplete(proposals) &&
    proposals.every((p) => !isInconclusive(p)) &&
    proposals.every((p) => p.proposedScope === first.proposedScope);

  if (isUnanimous) {
    // After the guards above, the shared scope is necessarily in_scope or
    // out_of_scope (unknown is excluded by !isInconclusive).
    const scope = first.proposedScope as "in_scope" | "out_of_scope";
    return {
      decision: "unanimous",
      scope,
      reason: `unanimous ${scope} (3/3 lenses agreed)`,
    };
  }

  return {
    decision: "split",
    reason: splitReason(proposals),
  };
}

/**
 * Select the single target-round proposal set to hand to `aggregateJuryVotes`
 * (design §0.1 R8 / plan PR2 / codex#252-P1). The deliberation gate is the only
 * arbiter of state transitions, so this selection is **fail-closed**:
 *
 * - If ANY round-2 proposal exists, the target round is 2 and EVERY lens must
 *   supply a round-2 proposal — a stale round-1 vote can never sneak into a
 *   "unanimous" set.
 * - Otherwise (critique skipped) the target round is 1.
 *
 * Missing lenses, duplicate (lens, round) rows, and partial-R2 mixes are NOT
 * silently repaired here (no `r2 ?? r1`, no non-null assertion, no dedup): the
 * resulting set simply has `length !== 3` or a non-distinct lens set, which
 * `aggregateJuryVotes` deterministically classifies as `split` -> escalate.
 */
export function selectFinalRound(
  proposals: readonly JuryClassificationProposal[],
): JuryClassificationProposal[] {
  const targetRound: 1 | 2 = proposals.some((p) => p.round === 2) ? 2 : 1;
  const out: JuryClassificationProposal[] = [];
  for (const lens of JURY_LENSES) {
    out.push(...proposals.filter((p) => p.lens === lens && p.round === targetRound));
  }
  return out; // length!==3 / lens 非distinct は aggregateJuryVotes が split->escalate
}

/**
 * Deterministic "weak evidence" predicate — the Stage3 critique trigger
 * (plan P2-b/P2-c / design §0.1 R9 / §2 Stage3). Pure: same input -> same
 * output, no IO, no state.
 *
 * EXACT RULE (pinned): the evidence is *weak* (-> trigger critique) IFF ANY
 * lens has FEWER THAN ONE verified evidence — i.e. some proposal has no
 * `evidence` entry with `verified === true`. A lens that did not produce a
 * usable proposal (no verified evidence) is by definition weak. The threshold
 * is exactly `< 1` per lens; do NOT loosen it to a batch-wide count.
 *
 * The Stage3 caller fires critique when R1 is `split` OR (R1 unanimous AND
 * `isWeakEvidence`). Convergence after critique never auto-confirms — that is
 * the gate's job (Stage5).
 *
 * IMPORTANT (single source of truth): the future doctor `auto_confirm`
 * re-verification (plan A3 / P2-b — which recomputes `critiqueRan` to audit a
 * jury-confirmed finding) MUST import THIS SAME function so the deterministic
 * critique-trigger decision is reproduced identically. Changing the rule here
 * changes both the live trigger and the audit; keep them coupled.
 */
export function isWeakEvidence(
  proposals: readonly JuryClassificationProposal[],
): boolean {
  return proposals.some(
    (p) => !p.evidence.some((e) => e.verified === true),
  );
}

/**
 * Deterministic proximity filter (plan PR1 / design §0.1 R1 / codex#252-P1).
 *
 * `verifyEvidence` only proves a citation EXISTS; it cannot prove the citation
 * is RELATED to the finding. This predicate AND-gates auto_confirm on the
 * citation's path/domain matching the finding's metadata, so a verified but
 * unrelated-domain citation yields `false` -> escalate (strictly safer):
 *
 * - `file` kind: requires `finding.filePath` AND the first two path segments
 *   of the NORMALIZED citation (after stripping any `:line` suffix and
 *   collapsing `.`/`..`) equal those of the normalized `finding.filePath`.
 *   Normalizing first (codex P1) means a `..`-traversal citation like
 *   `src/a.ts/../../vendor/x.ts` is compared as `vendor/x.ts` and CANNOT spoof
 *   the `src/a.ts` first segment. Missing `finding.filePath` -> `false`
 *   (fail-closed).
 * - `spec`/`policy` kind: requires `finding.category` AND the citation's
 *   token-split (`resolvedRef ?? citation` on `/[/#:.\s]+/`) to INCLUDE
 *   `finding.category` as an exact token (NOT substring, so `api` does not
 *   match `rapid-api`). Missing `finding.category` -> `false` (fail-closed).
 */
function evidenceProximityOk(
  e: VerifiedJuryEvidence,
  finding: DeliberationInput["finding"],
): boolean {
  // Fail-closed against malformed (non-string) inputs: the gate is the sole
  // arbiter of auto_confirm vs escalate, so a non-string citation/ref must
  // return false (-> escalate), NEVER throw (a throw could crash the
  // orchestrator instead of safely escalating). seg() returns "" for any
  // non-string, which can never equal a real path segment.
  //
  // The path is NORMALIZED (posix.normalize) BEFORE taking the first two
  // segments so a `..`-traversal cannot keep a misleading in-tree prefix.
  // posix.normalize on an absolute or escaping path keeps a leading "/" or
  // "../" segment, which can never equal a real worktree-relative segment.
  const seg = (p: unknown): string => {
    if (typeof p !== "string") return "";
    const withoutLine = p.split(":")[0] ?? p;
    return posix.normalize(withoutLine).split("/").slice(0, 2).join("/");
  };
  if (e.kind === "file") {
    if (finding?.filePath === undefined || typeof e.citation !== "string") return false;
    return seg(e.citation) === seg(finding.filePath);
  }
  // spec/policy: codex#252-P1 — token-split, exact match (substring not allowed).
  if (finding?.category === undefined) return false;
  const ref = e.resolvedRef ?? e.citation;
  if (typeof ref !== "string") return false;
  const tokens = ref.split(/[/#:.\s]+/).filter(Boolean);
  return tokens.includes(finding.category);
}

/**
 * The monotonic, fail-closed deliberation gate (design §4.2 / §0.1 R1/R8).
 *
 * This is the ONLY arbiter of jury-driven state transitions and the heart of
 * the safety boundary. It calls `aggregateJuryVotes` — which is the authority
 * (a unanimous verdict already subsumes lens-distinct + zero-inconclusive) —
 * and AND-gates auto_confirm on verified+proximate evidence and an upheld
 * refuter. A split can NEVER become auto_confirm regardless of the refuter; a
 * refute / inconclusive / undefined (never-run) refuter vetoes. Deterministic:
 * same input -> deep-equal output, no IO, no state mutation.
 *
 * `gateTrace.lensDistinct` / `noInconclusive` / `proximityOk` are computed
 * INDEPENDENTLY for audit display only (plan P2-c/P2-d). The authoritative pass
 * condition delegates to `aggregateJuryVotes` (`scopeUnanimous`) to avoid a
 * double judgment.
 */
export function aggregateDeliberation(
  input: DeliberationInput,
): DeliberationResult {
  const agg = aggregateJuryVotes(input.proposals);
  // aggregateJuryVotes is THE authority (subsumes lensDistinct + noInconclusive).
  const scopeUnanimous = agg.decision === "unanimous";
  // gateTrace fields below are audit-only (P2-c): they are computed
  // independently for display, but the pass logic delegates to scopeUnanimous.
  const lensDistinct =
    new Set(input.proposals.map((p) => p.lens)).size === 3 &&
    input.proposals.length === 3;
  const noInconclusive =
    input.proposals.length > 0 &&
    input.proposals.every(
      (p) => p.proposalStatus === "complete" && p.proposedScope !== "unknown",
    );
  const allHaveVerifiedEvidence =
    input.proposals.length > 0 &&
    input.proposals.every(
      (p) =>
        p.evidence.length > 0 &&
        p.evidence.every((e) => e.verified !== undefined) &&
        p.evidence.some((e) => e.verified === true),
    );
  const proximityOk =
    input.proposals.length > 0 &&
    input.proposals.every((p) =>
      p.evidence.some(
        (e) => e.verified === true && evidenceProximityOk(e, input.finding),
      ),
    );
  const refuterUpheld =
    input.refuterVerdict === undefined
      ? null
      : input.refuterVerdict.refuteVerdict === "uphold";
  const gateTrace = {
    scopeUnanimous,
    lensDistinct,
    noInconclusive,
    allHaveVerifiedEvidence,
    proximityOk,
    refuterUpheld,
  };

  // PR1/PR2/P2-d: auto_confirm IFF scopeUnanimous (aggregateJuryVotes authority)
  // AND verified AND proximate AND refuter uphold. Otherwise escalate.
  // `scopeUnanimous` (from aggregateJuryVotes) guarantees `agg.scope` is
  // defined; the explicit `scope !== undefined` check makes that invariant
  // type-visible (no non-null assertion) and keeps the gate fail-closed.
  const scope = agg.scope;
  if (
    scopeUnanimous &&
    scope !== undefined &&
    allHaveVerifiedEvidence &&
    proximityOk &&
    refuterUpheld === true
  )
    return {
      decision: "auto_confirm",
      scope,
      reason: `auto_confirm ${scope} (deliberation upheld)`,
      gateTrace,
    };
  return { decision: "escalate", reason: `escalate: ${agg.reason}`, gateTrace };
}
