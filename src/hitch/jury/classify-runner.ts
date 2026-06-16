import { join } from "node:path";
import { openManagedDb, withManagedDb } from "../../db/managed-connection.js";
import { harnessPaths } from "../../config/paths.js";
import { HitchRepository, OPEN_FINDING_LIFECYCLES } from "../repository.js";
import { classifyFindingForHitch } from "../classification.js";
import {
  HARNESS_ORIGIN_FINDING_SOURCE_SET,
  type HitchFinding,
  type HitchNextAction,
  type HitchScopeStatus,
  type HitchSession,
} from "../types.js";
import { deliberate, type DeliberationOutcome } from "./deliberate.js";
import { verifyEvidence } from "./evidence.js";
import {
  buildBundledSeverityAuditPacket,
  type SeverityAuditPacketInput,
} from "./decision-packet.js";
import { persistAuditRows } from "./classify-persistence.js";
import {
  buildBundledPacket,
  finalRoundProposals,
  toPacketSeverityAudit,
  toSplitDeliberation,
  type EscalateBundle,
} from "./classify-packet.js";
import type {
  ClassifyRunnerResult,
  CompiledPolicyView,
  EvidenceCheckContext,
  JuryProposerDeps,
  JuryLens,
  JuryStage,
} from "./types.js";

/**
 * #230 Task D1 — the 3-phase classify runner orchestration (design §7.1).
 *
 * SAFETY BOUNDARY (this is where LLM output meets REAL state transitions):
 * - State transitions are harness-only. `repo.classifyFinding` runs ONLY on a
 *   Stage5 `auto_confirm` from the deterministic gate (never from LLM output),
 *   or on the deterministic scope heuristic (never the jury).
 * - The DB is OPEN only in Phase 1 (READ-ONLY snapshot) and Phase 3
 *   (persist + classify). It is CLOSED for the whole of Phase 2 (the LLM
 *   deliberation), mirroring the reviewer path (design §3 invariant 4).
 * - Fail-closed: any ambiguity / freshness drift / error routes the finding to
 *   escalate; it never silently auto_confirms.
 * - #132 (round-2 FIX 1): Phase 1 is FULLY READ-ONLY — it mutates NO state. ALL
 *   state mutations (heuristic writes AND jury classifications AND escalate-packet
 *   persistence) happen in Phase 3, BEHIND the pre-Phase-3 abort guard. So a
 *   lease lost ANY time before Phase 3 leaves the entire classify step
 *   state-free (a non-authoritative drive mutates NOTHING).
 *
 * Phase 1 (DB open, READ-ONLY sync): partition the open+unknown findings by
 *   ORIGIN. operator-origin (human/mcp) are NOT machine-classified (R5) —
 *   snapshotted for an operator-origin escalate packet. harness-origin: apply the
 *   existing scope heuristic IN MEMORY — resolved -> snapshot the decision (NOT
 *   written yet); still-unknown -> snapshot as a jury candidate. NO writes. Close
 *   the DB.
 * Phase 2 (DB closed, LLM): for up to `juryBatchLimit` candidates, run
 *   `deliberate()` in memory (Stage 1-5, the gate is pure). Collect outcomes.
 *   The jury run-context (worktree + compiled policy + run id) is resolved here
 *   ONLY when Phase 1 produced jury candidates (heuristic + operator-origin do
 *   not need it).
 * Phase 3 (DB re-open): apply the snapshotted HEURISTIC writes, persist all
 *   generated jury audit rows (P2k), re-verify each candidate is still
 *   unknown+open, re-stat file citations for freshness (codex#252-P2), then
 *   classifyFinding on auto_confirm+fresh, else bundle for escalate. Then close
 *   the DB.
 */

/**
 * The lazily-resolved jury run context (worktree + compiled policy + run id).
 * #132 (round-2 FIX 2): resolved ONLY when Phase 1 produced jury candidates — a
 * session may have no repoId/domain, so a hitch whose unknown findings are ONLY
 * operator-origin or heuristic-classifiable must NOT trigger run-context
 * resolution (which would throw and route through the orchestrator's generic
 * escalation instead of the intended manual-classification / heuristic path).
 */
export interface JuryRunContext {
  /** Worktree path the file-kind citations resolve against (the run worktree). */
  worktreePath: string;
  /** Compiled policy for policy-kind citation resolution. */
  compiledPolicy: CompiledPolicyView;
  /** Latest coding run id (for audit provenance), or null. */
  runId: string | null;
}

/** Dependencies the classify runner needs from the orchestrator (Layer 3). */
export interface ClassifyDeliberationDeps {
  dbPath: string;
  harnessRoot: string;
  /** Per-finding jury codex calls (the orchestrator's reviewer runner). */
  reviewerRunner: JuryProposerDeps["reviewerRunner"];
  /**
   * Resolve the jury run context (worktree + policy + run id). #132 (round-2
   * FIX 2): the runner invokes this ONLY when the READ-ONLY Phase 1 snapshot
   * found actual jury candidates. Heuristic-classifiable + operator-origin
   * unknowns never call it (they need no worktree/policy), so a session without
   * repoId/domain still classifies heuristically / escalates a manual packet
   * instead of throwing a generic context-resolution error.
   */
  resolveJuryContext: () => Promise<JuryRunContext>;
  /** Optional spec-docs globs override for spec citation resolution. */
  specDocsGlobs?: readonly string[];
  /** Per-finding jury budget cap (codex#252-P2 / P2-i). */
  juryBatchLimit: number;
  /** Codex per-call timeout (ms). */
  timeoutMs: number;
  /**
   * Lease-loss abort signal (#132). Threaded from the orchestrator drive into
   * every jury codex call (Phase 2) AND checked before Phase 3: a
   * non-authoritative (lease-lost) drive persists/classifies/escalates NOTHING
   * (Phase 1 is read-only, so it has mutated nothing either) and returns the
   * benign no-op `{ resolved: true }`. The orchestrator's next-iteration /
   * post-loop `driveAborted` check then converts that into `lease_lost`.
   */
  signal?: AbortSignal;
}

const OPEN_FINDING_LIFECYCLE_LIST = OPEN_FINDING_LIFECYCLES;

/**
 * Whether the lease signal has fired (#132). A function call (not an inline
 * `signal?.aborted` check) so TS does not narrow `aborted` to `false` after the
 * first check — Phase 2's awaited LLM step can flip it to true between the
 * pre-Phase-1 guard and the pre-Phase-3 guard (mirrors orchestrator.driveAborted).
 */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** A jury candidate snapshotted in Phase 1 (DB closed for Phase 2). */
interface JuryCandidate {
  findingId: string;
  hitchId: string;
  summary: string;
  detail?: string;
  filePath?: string;
  category?: string;
  severity: HitchFinding["severity"];
}

/**
 * A heuristic-resolvable finding snapshotted in the READ-ONLY Phase 1. The scope
 * decision is computed here but NOT written — the actual `repo.classifyFinding`
 * write happens in Phase 3 (behind the abort guard) so a lease-lost drive leaves
 * the heuristic finding un-mutated (round-2 FIX 1).
 */
interface HeuristicResolved {
  findingId: string;
  scopeStatus: Exclude<HitchScopeStatus, "unknown">;
  reason: string;
}

/** A Phase-2 deliberation outcome bound to its candidate. */
interface DeliberatedCandidate {
  candidate: JuryCandidate;
  outcome: DeliberationOutcome;
}

/** Project a finding snapshot into the candidate the deliberation needs. */
function toCandidate(f: HitchFinding): JuryCandidate {
  return {
    findingId: f.findingId,
    hitchId: f.hitchId,
    summary: f.summary,
    ...(f.detail !== null ? { detail: f.detail } : {}),
    ...(f.filePath !== null ? { filePath: f.filePath } : {}),
    ...(f.category !== "" ? { category: f.category } : {}),
    severity: f.severity,
  };
}

function isOperatorOrigin(f: HitchFinding): boolean {
  return !HARNESS_ORIGIN_FINDING_SOURCE_SET.has(f.source);
}

/** Build the per-finding jury log-path factory (audit artifacts on disk). */
function makeLogPaths(
  harnessRoot: string,
  hitchId: string,
): JuryProposerDeps["logPaths"] {
  const auditDir = join(harnessPaths(harnessRoot).runsDir, "jury", hitchId);
  return (findingId: string, lens: JuryLens, stage: JuryStage) => ({
    stdout: join(auditDir, findingId, `${stage}-${lens}-stdout.log`),
    stderr: join(auditDir, findingId, `${stage}-${lens}-stderr.log`),
    events: join(auditDir, findingId, `${stage}-${lens}-events.log`),
  });
}

/**
 * Phase 1 result (READ-ONLY): heuristic-resolved decisions are snapshotted (NOT
 * written); the unresolved remainder is split into jury candidates
 * (harness-origin) and operator-origin findings.
 */
interface Phase1Result {
  /** Heuristic-resolvable decisions (applied in Phase 3, not Phase 1). */
  heuristicResolved: HeuristicResolved[];
  candidates: JuryCandidate[];
  operatorOrigin: HitchFinding[];
  /** True when more harness-origin candidates remained beyond the batch cap. */
  moreCandidatesPending: boolean;
}

/**
 * Phase 1 (DB OPEN, READ-ONLY synchronous): read every open+unknown finding ONCE
 * and partition by origin. harness-origin findings the scope heuristic resolves
 * are snapshotted as `heuristicResolved` (decision computed, NOT written);
 * still-unknown harness-origin findings become jury candidates; operator-origin
 * findings are snapshotted for the manual-classification escalate packet (R5).
 * NO writes occur here (round-2 FIX 1): the heuristic itself is a pure function
 * of each finding, so a single read pass is sufficient and the actual writes are
 * deferred to Phase 3.
 */
function runPhase1(
  repo: HitchRepository,
  session: HitchSession,
  hitchId: string,
  juryBatchLimit: number,
): Phase1Result {
  const filter = {
    hitchId,
    scopeStatus: "unknown" as const,
    lifecycleStatusIn: OPEN_FINDING_LIFECYCLE_LIST,
  };
  const heuristicResolved: HeuristicResolved[] = [];
  const candidates: JuryCandidate[] = [];
  const operatorOrigin: HitchFinding[] = [];

  // A single read pass over ALL open+unknown findings (paged). No writes occur,
  // so the unknown set does not shrink mid-pass — `offset`-based paging walks the
  // whole set deterministically.
  const PAGE = 200;
  for (let offset = 0; ; offset += PAGE) {
    const batch = repo.listFindings({ ...filter, limit: PAGE, offset });
    if (batch.length === 0) break;
    for (const finding of batch) {
      if (isOperatorOrigin(finding)) {
        // R5: operator-origin unknowns are never machine-classified.
        operatorOrigin.push(finding);
        continue;
      }
      const classification = classifyFindingForHitch(session, finding);
      if (classification.scopeStatus !== "unknown") {
        // Heuristic resolves -> snapshot the decision (Phase 3 writes it).
        heuristicResolved.push({
          findingId: finding.findingId,
          scopeStatus: classification.scopeStatus,
          reason: classification.reason,
        });
        continue;
      }
      // Still unknown -> jury candidate (snapshot for the DB-closed Phase 2).
      candidates.push(toCandidate(finding));
    }
    if (batch.length < PAGE) break;
  }

  // Cap the jury candidates to the per-invocation budget (codex#252-P2 / P2-i).
  const capped = candidates.slice(0, juryBatchLimit);
  const moreCandidatesPending = candidates.length > juryBatchLimit;
  return {
    heuristicResolved,
    candidates: capped,
    operatorOrigin,
    moreCandidatesPending,
  };
}

/** Build the per-candidate JuryProposerDeps (Phase 2, DB-closed). */
function buildProposerDeps(
  deps: ClassifyDeliberationDeps,
  juryContext: JuryRunContext,
  hitchId: string,
): JuryProposerDeps {
  const evidenceCtx: EvidenceCheckContext = {
    worktreePath: juryContext.worktreePath,
    compiledPolicy: juryContext.compiledPolicy,
    ...(deps.specDocsGlobs !== undefined
      ? { specDocsGlobs: deps.specDocsGlobs }
      : {}),
  };
  return {
    reviewerRunner: deps.reviewerRunner,
    harnessRoot: deps.harnessRoot,
    worktreePath: juryContext.worktreePath,
    logPaths: makeLogPaths(deps.harnessRoot, hitchId),
    timeoutMs: deps.timeoutMs,
    parseSchema: undefined,
    auditDir: join(harnessPaths(deps.harnessRoot).runsDir, "jury", hitchId),
    evidenceCtx,
    // #132: thread the lease signal into every per-call jury codex invocation.
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };
}

/**
 * Phase 2 (DB CLOSED, LLM): run `deliberate()` for each jury candidate in
 * memory. The DB handle is NOT held across these awaits (design §3 invariant 4).
 */
async function runPhase2(
  deps: ClassifyDeliberationDeps,
  juryContext: JuryRunContext,
  candidates: readonly JuryCandidate[],
): Promise<DeliberatedCandidate[]> {
  const out: DeliberatedCandidate[] = [];
  for (const candidate of candidates) {
    const proposerDeps = buildProposerDeps(deps, juryContext, candidate.hitchId);
    const outcome = await deliberate(
      {
        findingId: candidate.findingId,
        summary: candidate.summary,
        ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
        ...(candidate.filePath !== undefined
          ? { filePath: candidate.filePath }
          : {}),
        ...(candidate.category !== undefined
          ? { category: candidate.category }
          : {}),
        harnessSeverity: candidate.severity,
      },
      proposerDeps,
      candidate.hitchId,
    );
    out.push({ candidate, outcome });
  }
  return out;
}

/** Whether the finding is STILL unknown + open (Phase 3 re-verification). */
function stillUnknownOpen(finding: HitchFinding | null): finding is HitchFinding {
  if (finding === null) return false;
  if (finding.scopeStatus !== "unknown") return false;
  return (OPEN_FINDING_LIFECYCLE_LIST as readonly string[]).includes(
    finding.lifecycleStatus,
  );
}

/**
 * Freshness re-stat (codex#252-P2 / P2a): re-run the FILE-kind verified
 * citations of the FINAL-round proposals through `verifyEvidence` against the
 * CURRENT worktree. If ANY is now stale (path gone / line out of range) the
 * auto_confirm is withdrawn -> escalate. spec/policy citations are treated as
 * immutable (no recheck).
 *
 * Only the FINAL-round proposals are re-stat'd (the round the gate consumed).
 * `outcome.proposals` also carries the superseded round-1 proposals; a stale
 * round-1 citation that did NOT drive the auto_confirm must NOT withdraw it
 * (design §P2a / codex#252-P2). Exported for the final-round-only unit test.
 */
export function fileCitationsStillFresh(
  outcome: DeliberationOutcome,
  ctx: EvidenceCheckContext,
): boolean {
  for (const p of finalRoundProposals(outcome)) {
    for (const e of p.evidence) {
      if (e.kind !== "file") continue;
      if (e.verified !== true) continue;
      const reverified = verifyEvidence(
        { citation: e.citation, kind: e.kind, claim: e.claim },
        ctx,
      );
      if (reverified.verified !== true) return false;
    }
  }
  return true;
}

/**
 * Apply the snapshotted HEURISTIC writes (round-2 FIX 1: moved here from the
 * read-only Phase 1). Each finding is re-read first (`stillUnknownOpen`): a
 * heuristic snapshot must not overwrite a finding a concurrent path resolved
 * during the long Phase 2. Returns the no-progress escalate reason when there
 * WERE heuristic-resolvable findings but NONE actually advanced (the documented
 * spy/mocked-write case: a write claims resolution but the scope never changes).
 */
function applyHeuristicWrites(
  repo: HitchRepository,
  heuristicResolved: readonly HeuristicResolved[],
  hitchId: string,
): { noProgressEscalate?: string } {
  if (heuristicResolved.length === 0) return {};
  let writes = 0;
  let stillUnknown = 0;
  for (const h of heuristicResolved) {
    const current = repo.getFinding(h.findingId);
    if (!stillUnknownOpen(current)) continue; // resolved by another path mid-run.
    const updated = repo.classifyFinding({
      findingId: h.findingId,
      scopeStatus: h.scopeStatus,
      reason: h.reason,
    });
    if (updated.scopeStatus !== "unknown") writes += 1;
    else stillUnknown += 1;
  }
  // No-progress guard for the HEURISTIC writes (the spy/mocked-write case): a
  // heuristic that claims resolution but the DB scope never changes is stuck.
  if (writes === 0 && stillUnknown > 0) {
    return {
      noProgressEscalate:
        `classification made no progress for hitch ${hitchId}; ` +
        `${stillUnknown} unknown findings remain`,
    };
  }
  return {};
}

/**
 * Phase 3 (DB RE-OPEN): apply heuristic writes, persist all jury audit rows,
 * re-verify + freshness-check, then classifyFinding on auto_confirm+fresh else
 * bundle for escalate. Returns the ClassifyRunnerResult for the whole
 * invocation. `juryContext` is undefined ONLY when Phase 1 produced no jury
 * candidates (heuristic-only / operator-only), in which case `deliberated` is
 * empty and the freshness re-stat never runs.
 */
function runPhase3(
  deps: ClassifyDeliberationDeps,
  hitchId: string,
  juryContext: JuryRunContext | undefined,
  phase1: Phase1Result,
  deliberated: readonly DeliberatedCandidate[],
): ClassifyRunnerResult {
  const evidenceCtx: EvidenceCheckContext | undefined =
    juryContext !== undefined
      ? {
          worktreePath: juryContext.worktreePath,
          compiledPolicy: juryContext.compiledPolicy,
          ...(deps.specDocsGlobs !== undefined
            ? { specDocsGlobs: deps.specDocsGlobs }
            : {}),
        }
      : undefined;
  return withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);

    // (1) apply the snapshotted heuristic writes (round-2 FIX 1). A no-progress
    // drain escalates immediately (mirrors the old Phase-1 guard, now in Phase 3).
    const heuristic = applyHeuristicWrites(
      repo,
      phase1.heuristicResolved,
      hitchId,
    );
    if (heuristic.noProgressEscalate !== undefined) {
      const unknownFindingIds = [
        ...phase1.candidates.map((c) => c.findingId),
        ...phase1.operatorOrigin.map((f) => f.findingId),
        ...phase1.heuristicResolved.map((h) => h.findingId),
      ];
      return {
        resolved: false,
        decision: "escalate",
        escalateReason: heuristic.noProgressEscalate,
        recommendedNextAction: {
          kind: "classify_findings",
          findingIds: unknownFindingIds,
          message: heuristic.noProgressEscalate,
        },
      };
    }

    // FIX 4 (codex P2): operator-origin unknowns are snapshotted in Phase 1, but
    // a human/process may classify one during the long Phase 2. Mirror the jury
    // candidates' `stillUnknownOpen` re-check: re-read each operator finding's
    // CURRENT state and DROP any that is no longer unknown+open before bundling
    // it into the escalate packet. A stale snapshot must not escalate a finding
    // that has since been resolved (no spurious escalate, fail-closed-safe).
    const freshOperatorOrigin = phase1.operatorOrigin.filter((f) =>
      stillUnknownOpen(repo.getFinding(f.findingId)),
    );
    const bundle: EscalateBundle = {
      splits: [],
      operatorFindings: [...freshOperatorOrigin],
      operatorDeliberationIds: {},
      reasons: [],
    };
    for (const f of freshOperatorOrigin) {
      bundle.operatorDeliberationIds[f.findingId] = "";
    }
    if (freshOperatorOrigin.length > 0) {
      bundle.reasons.push(
        `${freshOperatorOrigin.length} operator-origin unknown finding(s) require manual classification`,
      );
    }

    // Accumulate EVERY severity-divergent auto_confirm in the batch (codex P2):
    // a single bundled advisory packet must cover ALL of them (R14), not just the
    // first. Each entry carries the per-finding deliberationId + audit.
    const severityDivergent: SeverityAuditPacketInput[] = [];

    for (const dc of deliberated) {
      const { candidate, outcome } = dc;
      // (a) persist all generated audit rows regardless of skip (P2k).
      persistAuditRows(
        db,
        {
          findingId: candidate.findingId,
          hitchId: candidate.hitchId,
          harnessSeverity: candidate.severity,
        },
        outcome,
        juryContext?.runId ?? null,
      );

      // (b) re-verify the finding is STILL unknown+open; another path may have
      // classified it mid-run. If so, SKIP classifyFinding (rows above stay).
      const current = repo.getFinding(candidate.findingId);
      if (!stillUnknownOpen(current)) continue;

      const autoConfirmScope =
        outcome.result.decision === "auto_confirm"
          ? outcome.result.scope
          : undefined;

      if (autoConfirmScope !== undefined) {
        // (c) freshness re-stat: file citations must still resolve NOW.
        // evidenceCtx is always defined here (a deliberated candidate implies a
        // resolved juryContext); the guard keeps the type narrow.
        if (
          evidenceCtx === undefined ||
          !fileCitationsStillFresh(outcome, evidenceCtx)
        ) {
          bundle.splits.push(toSplitDeliberation(current, outcome));
          bundle.reasons.push(
            `finding ${candidate.findingId} auto_confirm withdrawn: a verified file citation is now stale`,
          );
          continue;
        }
        // (d) auto_confirm + fresh -> classifyFinding with deliberation_id in reason.
        const classified = repo.classifyFinding({
          findingId: candidate.findingId,
          scopeStatus: autoConfirmScope,
          reason: `jury auto_confirm (deliberation_id=${outcome.deliberationId})`,
        });
        // (e) severity diverged -> accumulate for the bundled non-escalating
        // severity packet (D2b). EVERY divergence is collected, not just the
        // first, so the bundled packet covers them all (codex P2). round-2 FIX 5:
        // build the packet entry from the JUST-CLASSIFIED finding so its
        // `scopeStatus` reflects the applied in_scope/out_of_scope (not the
        // pre-classify `unknown` snapshot read above).
        if (outcome.severityAudit.escalate) {
          severityDivergent.push({
            finding: classified,
            deliberationId: outcome.deliberationId,
            audit: toPacketSeverityAudit(outcome),
          });
        }
        continue;
      }

      // (f) escalate (split / refuter veto / weak evidence) -> bundle it.
      bundle.splits.push(toSplitDeliberation(current, outcome));
      bundle.reasons.push(
        `finding ${candidate.findingId} jury did not reach auto_confirm (${outcome.result.reason})`,
      );
    }

    const hasEscalation =
      bundle.splits.length > 0 || bundle.operatorFindings.length > 0;
    if (hasEscalation) {
      const packet = buildBundledPacket(bundle);
      // round-2 FIX 3: when escalating, MERGE the accumulated severity-divergent
      // audits into the SAME packet so a batch that BOTH escalates (split /
      // operator) AND has an auto_confirmed+severity-diverged finding still
      // surfaces every required action. Otherwise the divergence (only emitted on
      // the resolved path below) would be dropped: the auto_confirmed finding is
      // classified + its audit row persisted, but the operator never sees a
      // severity-review next-action for it.
      const merged = mergeSeverityIntoEscalate(packet, severityDivergent);
      const recommendedNextAction: HitchNextAction = {
        kind: "classify_findings",
        findingIds: merged.findings.map((f) => f.findingId),
        message: bundle.reasons.join("; "),
        decisionPacket: merged,
      };
      return {
        resolved: false,
        decision: "escalate",
        escalateReason: bundle.reasons.join("; "),
        recommendedNextAction,
      };
    }

    return {
      resolved: true,
      ...(severityDivergent.length > 0
        ? {
            severityAuditPacket:
              buildBundledSeverityAuditPacket(severityDivergent),
          }
        : {}),
      ...(phase1.moreCandidatesPending ? { moreUnknownsPending: true } : {}),
    };
  });
}

/**
 * round-2 FIX 3: merge severity-divergent audits into a bundled escalate packet.
 * The escalate packet (split + operator) keeps its findings/axes/actions; the
 * severity-divergent findings + their `review severity` next-actions are appended,
 * and `severity_audit` is added to `decisionKinds` (de-duped). A
 * severity-diverged finding that ALSO appears as a split (it both escalated and
 * diverged — impossible in one deliberation, but defensively de-duped) is not
 * duplicated in `findings`.
 */
function mergeSeverityIntoEscalate(
  packet: ReturnType<typeof buildBundledPacket>,
  severityDivergent: readonly SeverityAuditPacketInput[],
): ReturnType<typeof buildBundledPacket> {
  if (severityDivergent.length === 0) return packet;
  const sevPacket = buildBundledSeverityAuditPacket(severityDivergent);
  const existingIds = new Set(packet.findings.map((f) => f.findingId));
  const newFindings = sevPacket.findings.filter(
    (f) => !existingIds.has(f.findingId),
  );
  return {
    ...packet,
    decisionKinds: [
      ...new Set([...packet.decisionKinds, "severity_audit" as const]),
    ],
    findings: [...packet.findings, ...newFindings],
    nextActions: [...packet.nextActions, ...sevPacket.nextActions],
  };
}

/**
 * The 3-phase classify runner entry point. Phase 1 (DB open READ-ONLY snapshot)
 * -> Phase 2 (DB closed LLM) -> Phase 3 (DB re-open persist + classify). See the
 * file header for the safety boundary this enforces.
 */
export async function runClassifyDeliberation(
  deps: ClassifyDeliberationDeps,
  hitchId: string,
): Promise<ClassifyRunnerResult> {
  // #132 — already lease-lost before we start: a non-authoritative drive must
  // mutate NO state. Short-circuit BEFORE the Phase-1 snapshot with the benign
  // no-op; the orchestrator's next-iteration/post-loop driveAborted check maps it
  // to lease_lost (never escalate). Returning resolved:true is the correct
  // fail-safe — throwing here would route through the orchestrator try/catch and
  // escalate the hitch.
  if (signalAborted(deps.signal)) {
    return { resolved: true };
  }

  // PHASE 1 — DB OPEN, READ-ONLY synchronous snapshot (no await, NO writes).
  const phase1 = openSnapshot(deps, hitchId);

  // Nothing to do: no heuristic write, no jury candidate, no operator-origin.
  if (
    phase1.heuristicResolved.length === 0 &&
    phase1.candidates.length === 0 &&
    phase1.operatorOrigin.length === 0
  ) {
    return {
      resolved: true,
      ...(phase1.moreCandidatesPending ? { moreUnknownsPending: true } : {}),
    };
  }

  // #132 (round-2 FIX 2) — resolve the jury run-context (worktree + policy + run
  // id) ONLY when Phase 1 produced jury candidates. Heuristic-only / operator-
  // only batches never resolve it (the session may have no repoId/domain, which
  // would throw and route to a generic escalation instead of the intended
  // heuristic write / manual-classification packet).
  let juryContext: JuryRunContext | undefined;
  let deliberated: DeliberatedCandidate[] = [];
  if (phase1.candidates.length > 0) {
    juryContext = await deps.resolveJuryContext();
    // PHASE 2 — DB CLOSED, LLM deliberation (no DB handle held across awaits).
    deliberated = await runPhase2(deps, juryContext, phase1.candidates);
  }

  // #132 — lease lost DURING Phase 2 (the long LLM step). Phase 3 is where the
  // ONLY state mutations happen (heuristic writes / persist audit rows /
  // classifyFinding / build the escalate packet). A non-authoritative drive must
  // mutate NOTHING, so abort BEFORE re-opening the DB and return the benign
  // no-op. (Do NOT throw — the orchestrator try/catch would escalate the hitch;
  // resolved:true lets the next-iteration/post-loop driveAborted check convert it
  // to lease_lost.)
  if (signalAborted(deps.signal)) {
    return { resolved: true };
  }

  // PHASE 3 — DB RE-OPEN, apply heuristic writes + persist + re-verify + classify.
  return runPhase3(deps, hitchId, juryContext, phase1, deliberated);
}

/** Open a managed DB for the synchronous READ-ONLY Phase 1 snapshot, then close it. */
function openSnapshot(
  deps: ClassifyDeliberationDeps,
  hitchId: string,
): Phase1Result {
  const { db, close } = openManagedDb({ dbPath: deps.dbPath });
  try {
    const repo = new HitchRepository(db);
    const session = repo.requireSession(hitchId);
    return runPhase1(repo, session, hitchId, deps.juryBatchLimit);
  } finally {
    close();
  }
}
