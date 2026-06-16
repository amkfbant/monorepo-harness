import { join } from "node:path";
import { openManagedDb, withManagedDb } from "../../db/managed-connection.js";
import { harnessPaths } from "../../config/paths.js";
import { HitchRepository, OPEN_FINDING_LIFECYCLES } from "../repository.js";
import { classifyFindingForHitch } from "../classification.js";
import {
  HARNESS_ORIGIN_FINDING_SOURCE_SET,
  type HitchFinding,
  type HitchNextAction,
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
 *   Stage5 `auto_confirm` from the deterministic gate (never from LLM output).
 * - The DB is OPEN only in Phase 1 (synchronous snapshot) and Phase 3
 *   (persist + classify). It is CLOSED for the whole of Phase 2 (the LLM
 *   deliberation), mirroring the reviewer path (design §3 invariant 4).
 * - Fail-closed: any ambiguity / freshness drift / error routes the finding to
 *   escalate; it never silently auto_confirms.
 *
 * Phase 1 (DB open, sync): partition the open+unknown findings by ORIGIN.
 *   operator-origin (human/mcp) are NOT machine-classified (R5) — bundled for an
 *   operator-origin escalate packet. harness-origin: apply the existing
 *   heuristic; resolved -> classifyFinding immediately (heuristic bypasses jury);
 *   still-unknown -> snapshot as a jury candidate. Then close the DB.
 * Phase 2 (DB closed, LLM): for up to `juryBatchLimit` candidates, run
 *   `deliberate()` in memory (Stage 1-5, the gate is pure). Collect outcomes.
 * Phase 3 (DB re-open): per outcome, persist all generated audit rows (P2k),
 *   re-verify the finding is still unknown+open, re-stat file citations for
 *   freshness (codex#252-P2), then classifyFinding on auto_confirm+fresh, else
 *   bundle for escalate. Then close the DB.
 */

/** Dependencies the classify runner needs from the orchestrator (Layer 3). */
export interface ClassifyDeliberationDeps {
  dbPath: string;
  harnessRoot: string;
  /** Per-finding jury codex calls (the orchestrator's reviewer runner). */
  reviewerRunner: JuryProposerDeps["reviewerRunner"];
  /** Worktree path the file-kind citations resolve against (the run worktree). */
  worktreePath: string;
  /** Compiled policy for policy-kind citation resolution. */
  compiledPolicy: CompiledPolicyView;
  /** Latest coding run id (for audit provenance), or null. */
  runId: string | null;
  /** Per-finding jury budget cap (codex#252-P2 / P2-i). */
  juryBatchLimit: number;
  /** Optional spec-docs globs override for spec citation resolution. */
  specDocsGlobs?: readonly string[];
  /** Codex per-call timeout (ms). */
  timeoutMs: number;
  /**
   * Lease-loss abort signal (#132). Threaded from the orchestrator drive into
   * every jury codex call (Phase 2) AND checked before each Phase-3 DB mutation:
   * a non-authoritative (lease-lost) drive persists/classifies/escalates NOTHING
   * and returns the benign no-op `{ resolved: true }`. The orchestrator's
   * next-iteration `driveAborted` check then converts that into `lease_lost`.
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
 * Phase 1 result: heuristic-resolved findings are already written; the unresolved
 * remainder is split into jury candidates (harness-origin) and operator-origin
 * findings (snapshotted so Phase 3 can build the operator escalate packet).
 */
interface Phase1Result {
  candidates: JuryCandidate[];
  operatorOrigin: HitchFinding[];
  /** True when more harness-origin candidates remained beyond the batch cap. */
  moreCandidatesPending: boolean;
  /** Set when the heuristic drain failed to make progress (no-progress guard). */
  noProgressEscalate?: string;
}

/**
 * Phase 1 (DB OPEN, synchronous): heuristic-drain harness-origin findings,
 * collect operator-origin + still-unknown jury candidates. Preserves the
 * existing no-progress guard for the heuristic drain (it must NOT mis-fire jury
 * defers as escalation — defers are reported via `moreCandidatesPending`).
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
  const candidates: JuryCandidate[] = [];
  const operatorOrigin: HitchFinding[] = [];
  const seenJury = new Set<string>();
  const seenOperator = new Set<string>();
  let previousRemaining = repo.countFindings(filter);

  // Heuristic drain (existing while-loop semantics): keep classifying
  // heuristic-resolvable findings until none make progress. Findings the
  // heuristic leaves `unknown` are partitioned by origin (jury vs operator).
  for (;;) {
    const batch = repo.listFindings({ ...filter, limit: 200 });
    if (batch.length === 0) break;
    let heuristicWrites = 0;
    for (const finding of batch) {
      if (isOperatorOrigin(finding)) {
        // R5: operator-origin unknowns are never machine-classified.
        if (!seenOperator.has(finding.findingId)) {
          seenOperator.add(finding.findingId);
          operatorOrigin.push(finding);
        }
        continue;
      }
      const classification = classifyFindingForHitch(session, finding);
      if (classification.scopeStatus !== "unknown") {
        // Heuristic confirms -> write immediately (heuristic bypasses jury).
        repo.classifyFinding({
          findingId: finding.findingId,
          scopeStatus: classification.scopeStatus,
          reason: classification.reason,
        });
        heuristicWrites += 1;
        continue;
      }
      // Still unknown -> jury candidate (snapshot for the DB-closed Phase 2).
      if (!seenJury.has(finding.findingId)) {
        seenJury.add(finding.findingId);
        candidates.push(toCandidate(finding));
      }
    }

    const remaining = repo.countFindings(filter);
    // Every still-unknown finding in this batch is either an operator-origin or a
    // jury candidate — both are now accounted for. If the heuristic made no write
    // this pass, there is nothing left to drain heuristically; break to Phase 2.
    if (heuristicWrites === 0) break;
    if (remaining === 0) break;
    // No-progress guard for the HEURISTIC drain only (the spy/mocked-write case):
    // a heuristic that claims resolution but the DB count never drops is stuck.
    if (remaining >= previousRemaining) {
      return {
        candidates,
        operatorOrigin,
        moreCandidatesPending: false,
        noProgressEscalate:
          `classification made no progress for hitch ${hitchId}; ` +
          `${remaining} unknown findings remain`,
      };
    }
    previousRemaining = remaining;
  }

  // Cap the jury candidates to the per-invocation budget (codex#252-P2 / P2-i).
  const capped = candidates.slice(0, juryBatchLimit);
  const moreCandidatesPending = candidates.length > juryBatchLimit;
  return { candidates: capped, operatorOrigin, moreCandidatesPending };
}

/** Build the per-candidate JuryProposerDeps (Phase 2, DB-closed). */
function buildProposerDeps(
  deps: ClassifyDeliberationDeps,
  hitchId: string,
): JuryProposerDeps {
  const evidenceCtx: EvidenceCheckContext = {
    worktreePath: deps.worktreePath,
    compiledPolicy: deps.compiledPolicy,
    ...(deps.specDocsGlobs !== undefined
      ? { specDocsGlobs: deps.specDocsGlobs }
      : {}),
  };
  return {
    reviewerRunner: deps.reviewerRunner,
    harnessRoot: deps.harnessRoot,
    worktreePath: deps.worktreePath,
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
  candidates: readonly JuryCandidate[],
): Promise<DeliberatedCandidate[]> {
  const out: DeliberatedCandidate[] = [];
  for (const candidate of candidates) {
    const proposerDeps = buildProposerDeps(deps, candidate.hitchId);
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
 * Phase 3 (DB RE-OPEN): persist all audit rows, re-verify + freshness-check, then
 * classifyFinding on auto_confirm+fresh else bundle for escalate. Returns the
 * ClassifyRunnerResult for the whole invocation.
 */
function runPhase3(
  deps: ClassifyDeliberationDeps,
  deliberated: readonly DeliberatedCandidate[],
  operatorOrigin: readonly HitchFinding[],
  moreCandidatesPending: boolean,
): ClassifyRunnerResult {
  const evidenceCtx: EvidenceCheckContext = {
    worktreePath: deps.worktreePath,
    compiledPolicy: deps.compiledPolicy,
    ...(deps.specDocsGlobs !== undefined
      ? { specDocsGlobs: deps.specDocsGlobs }
      : {}),
  };
  return withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    // FIX 4 (codex P2): operator-origin unknowns are snapshotted in Phase 1, but
    // a human/process may classify one during the long Phase 2. Mirror the jury
    // candidates' `stillUnknownOpen` re-check: re-read each operator finding's
    // CURRENT state and DROP any that is no longer unknown+open before bundling
    // it into the escalate packet. A stale snapshot must not escalate a finding
    // that has since been resolved (no spurious escalate, fail-closed-safe).
    const freshOperatorOrigin = operatorOrigin.filter((f) =>
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
        deps.runId,
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
        if (!fileCitationsStillFresh(outcome, evidenceCtx)) {
          bundle.splits.push(toSplitDeliberation(current, outcome));
          bundle.reasons.push(
            `finding ${candidate.findingId} auto_confirm withdrawn: a verified file citation is now stale`,
          );
          continue;
        }
        // (d) auto_confirm + fresh -> classifyFinding with deliberation_id in reason.
        repo.classifyFinding({
          findingId: candidate.findingId,
          scopeStatus: autoConfirmScope,
          reason: `jury auto_confirm (deliberation_id=${outcome.deliberationId})`,
        });
        // (e) severity diverged -> accumulate for the bundled non-escalating
        // severity packet (D2b). EVERY divergence is collected, not just the
        // first, so the bundled packet covers them all (codex P2).
        if (outcome.severityAudit.escalate) {
          severityDivergent.push({
            finding: current,
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
      const recommendedNextAction: HitchNextAction = {
        kind: "classify_findings",
        findingIds: packet.findings.map((f) => f.findingId),
        message: bundle.reasons.join("; "),
        decisionPacket: packet,
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
      ...(moreCandidatesPending ? { moreUnknownsPending: true } : {}),
    };
  });
}

/**
 * The 3-phase classify runner entry point. Phase 1 (DB open snapshot) -> Phase 2
 * (DB closed LLM) -> Phase 3 (DB re-open persist + classify). See the file
 * header for the safety boundary this enforces.
 */
export async function runClassifyDeliberation(
  deps: ClassifyDeliberationDeps,
  hitchId: string,
): Promise<ClassifyRunnerResult> {
  // #132 — already lease-lost before we start: a non-authoritative drive must
  // mutate NO state. Short-circuit BEFORE the Phase-1 snapshot with the benign
  // no-op; the orchestrator's next-iteration driveAborted check maps it to
  // lease_lost (never escalate). Returning resolved:true is the correct
  // fail-safe — throwing here would route through the orchestrator try/catch and
  // escalate the hitch.
  if (signalAborted(deps.signal)) {
    return { resolved: true };
  }

  // PHASE 1 — DB OPEN, synchronous snapshot (no await inside the handle).
  const phase1 = openSnapshot(deps, hitchId);
  if (phase1.noProgressEscalate !== undefined) {
    // §7.2 back-compat: kind/message/findingIds are ALWAYS populated on the
    // persisted next-action. The snapshot's still-unknown finding ids (jury
    // candidates + operator-origin) are readily available here, so surface them.
    const unknownFindingIds = [
      ...phase1.candidates.map((c) => c.findingId),
      ...phase1.operatorOrigin.map((f) => f.findingId),
    ];
    return {
      resolved: false,
      decision: "escalate",
      escalateReason: phase1.noProgressEscalate,
      recommendedNextAction: {
        kind: "classify_findings",
        findingIds: unknownFindingIds,
        message: phase1.noProgressEscalate,
      },
    };
  }
  if (
    phase1.candidates.length === 0 &&
    phase1.operatorOrigin.length === 0
  ) {
    return {
      resolved: true,
      ...(phase1.moreCandidatesPending ? { moreUnknownsPending: true } : {}),
    };
  }

  // PHASE 2 — DB CLOSED, LLM deliberation (no DB handle held across awaits).
  const deliberated = await runPhase2(deps, phase1.candidates);

  // #132 — lease lost DURING Phase 2 (the long LLM step). Phase 3 is where the
  // ONLY state mutations happen (persist audit rows / classifyFinding / build the
  // escalate packet). A non-authoritative drive must mutate NOTHING, so abort
  // BEFORE re-opening the DB and return the benign no-op. (Do NOT throw — the
  // orchestrator try/catch would escalate the hitch; resolved:true lets the
  // next-iteration driveAborted check convert it to lease_lost.)
  if (signalAborted(deps.signal)) {
    return { resolved: true };
  }

  // PHASE 3 — DB RE-OPEN, persist + re-verify + classify.
  return runPhase3(
    deps,
    deliberated,
    phase1.operatorOrigin,
    phase1.moreCandidatesPending,
  );
}

/** Open a managed DB for the synchronous Phase 1 snapshot, then close it. */
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
