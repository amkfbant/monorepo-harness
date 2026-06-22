import type Database from "better-sqlite3";
import {
  AttemptRepository,
  type CompleteHitchAttemptInput,
  type CreateHitchAttemptInput,
} from "./repositories/attempt-repository.js";
import {
  CloseCheckRepository,
  type RecordHitchCloseCheckInput,
} from "./repositories/close-check-repository.js";
import {
  ConvergenceDecisionRepository,
  type RecordHitchConvergenceDecisionInput,
} from "./repositories/convergence-decision-repository.js";
import {
  ReviewCycleRepository,
  type CompleteHitchReviewCycleInput,
  type StartHitchReviewCycleInput,
} from "./repositories/review-cycle-repository.js";
import {
  SessionRepository,
  type AdoptHitchPrInput,
  type CreateHitchSessionInput,
  type HitchSessionFilter,
  type ReopenHitchSessionOptions,
  type UpdateHitchSessionConfigInput,
  type UpdateHitchStatusOptions,
} from "./repositories/session-repository.js";
import {
  MetricsRepository,
  type LinkedPhaseSpecApprovalDrift,
} from "./repositories/metrics-repository.js";
import { FindingRepository } from "./repositories/finding-repository.js";
import {
  AUTO_RESOLVE_NOTE_PREFIX,
  OPEN_FINDING_LIFECYCLES,
  UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
  type ClassifyAndDeferHitchFindingInput,
  type ClassifyAndDeferHitchFindingResult,
  type ClassifyHitchFindingInput,
  type DeferHitchFindingInput,
  type HitchFindingFilter,
  type HitchFindingSummaryCounts,
  type MarkHitchFindingFixedInput,
  type ResolveSupersededReviewFindingsInput,
  type UpsertHitchFindingInput,
  type UpsertHitchFindingResult,
} from "./repositories/finding-helpers.js";
import { getHitchSession, requireHitchSession } from "./repositories/shared.js";
import {
  type HitchAttempt,
  type HitchCloseCheck,
  type HitchConvergenceDecisionRecord,
  type HitchFinding,
  type HitchHarnessOriginDivergenceMetrics,
  type HitchLifecycleEvent,
  type HitchReviewCycle,
  type HitchSession,
  type HitchStatus,
} from "./types.js";

// #125 Track C: concerns moved to per-concern sub-repos. Re-export their input
// types + finding constants so the public module surface of `repository.ts` (and
// any consumer importing them from here) is unchanged.
// C1 — convergence-decision; C2 — close-check; C3 — attempt; C4 — review-cycle;
// C5 — session; C6 — finding; C7 — metrics.
export type { RecordHitchConvergenceDecisionInput };
export type { RecordHitchCloseCheckInput };
export type { CreateHitchAttemptInput, CompleteHitchAttemptInput };
export type { StartHitchReviewCycleInput, CompleteHitchReviewCycleInput };
export type {
  CreateHitchSessionInput,
  HitchSessionFilter,
  UpdateHitchStatusOptions,
  ReopenHitchSessionOptions,
  AdoptHitchPrInput,
  UpdateHitchSessionConfigInput,
};
export type { LinkedPhaseSpecApprovalDrift };
export type {
  UpsertHitchFindingInput,
  UpsertHitchFindingResult,
  ClassifyHitchFindingInput,
  MarkHitchFindingFixedInput,
  ResolveSupersededReviewFindingsInput,
  DeferHitchFindingInput,
  ClassifyAndDeferHitchFindingInput,
  ClassifyAndDeferHitchFindingResult,
  HitchFindingFilter,
  HitchFindingSummaryCounts,
} from "./repositories/finding-helpers.js";
// #125 Track C C6: finding lifecycle constants live with the finding concern;
// re-exported here so existing consumers (rollup / cli / convergence /
// orchestrator-runners / jury) keep their `from "../repository.js"` imports.
export {
  OPEN_FINDING_LIFECYCLES,
  AUTO_RESOLVE_NOTE_PREFIX,
  UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
};

/** #280 — options for {@link HitchRepository.recoverDivergingSession}. The
 * deterministic open-P0/P1 + close-check gate is supplied by the CLI/caller as
 * `revalidate` and is RE-RUN INSIDE the write transaction (not just before it),
 * so a concurrent `finding add` / close-check transition / cancel-close-escalate
 * between the caller's pre-check and the commit cannot flip a stale hitch to
 * `open` (fail-closed under the shared DB lock).
 *
 * The public callback takes the FACADE (`repo`) so the CLI recomputes from
 * `ConvergenceService.evaluate()` without the repo depending on the convergence
 * layer; the facade binds itself before delegating to the session sub-repo
 * (#125 Track C C5). */
export interface RecoverDivergingSessionOptions {
  reason: string;
  createdBy: string;
  /** Amount added to `max_total_new_findings` so live re-derivation does not
   * immediately re-fire the cumulative trigger. Clamped to a non-negative int. */
  extendDivergenceBudget?: number;
  /** #280 P2#2 — deterministic gate re-validation, executed INSIDE the write
   * transaction against fresh DB state. MUST throw (fail-closed) on any unmet
   * invariant (status drift, open P0/P1/unknown, red/pending close-check,
   * non-recoverable divergence trigger, or a residual re-fire). The repo passes
   * itself so the callback recomputes from `ConvergenceService.evaluate()`
   * without the repo depending on the convergence layer. */
  revalidate?: (repo: HitchRepository) => void;
  now?: string;
}

export class HitchRepository {
  // #125 Track C: per-concern sub-repositories. Each is constructed with this
  // facade's `db` handle (no transaction of its own) so its writes compose
  // inside the facade's single-BEGIN atomic primitive (`runAtomically`). The
  // facade keeps every public method and forwards to the owning sub-repo.
  private readonly decisions: ConvergenceDecisionRepository;
  private readonly closeChecks: CloseCheckRepository;
  private readonly attempts: AttemptRepository;
  private readonly reviewCycles: ReviewCycleRepository;
  private readonly sessions: SessionRepository;
  private readonly metrics: MetricsRepository;
  private readonly findings: FindingRepository;

  constructor(private readonly db: Database.Database) {
    this.decisions = new ConvergenceDecisionRepository(db);
    this.closeChecks = new CloseCheckRepository(db);
    this.attempts = new AttemptRepository(db);
    this.reviewCycles = new ReviewCycleRepository(db);
    this.sessions = new SessionRepository(db);
    this.metrics = new MetricsRepository(db);
    this.findings = new FindingRepository(db);
  }

  // #125 Track C (C5): session concern delegated to SessionRepository (incl.
  // the private insertLifecycleEvent ledger writer and the config/reopen/recover
  // gate helpers). The facade keeps these entry-points and forwards to the
  // sub-repo (shared `db`, behaviour-identical). getSession / requireSession use
  // the shared session readers so the finding concern (near-dup policy gate) and
  // every caller decode sessions identically.
  createSession(input: CreateHitchSessionInput): HitchSession {
    return this.sessions.createSession(input);
  }

  getSession(hitchId: string): HitchSession | null {
    return getHitchSession(this.db, hitchId);
  }

  requireSession(hitchId: string): HitchSession {
    return requireHitchSession(this.db, hitchId);
  }

  listSessions(filter: HitchSessionFilter = {}): HitchSession[] {
    return this.sessions.listSessions(filter);
  }

  updateStatus(
    hitchId: string,
    status: HitchStatus,
    note: string | undefined,
    opts: UpdateHitchStatusOptions,
  ): HitchSession {
    return this.sessions.updateStatus(hitchId, status, note, opts);
  }

  reopenSession(
    hitchId: string,
    opts: ReopenHitchSessionOptions,
  ): HitchSession {
    return this.sessions.reopenSession(hitchId, opts);
  }

  /**
   * #280 — sanctioned recovery for a CUMULATIVELY/stickily `diverging` hitch.
   * Delegates to {@link SessionRepository.recoverDivergingSession}, binding the
   * facade into the public `revalidate(repo)` callback so the CLI's deterministic
   * gate re-derivation runs against this facade INSIDE the sub-repo's write
   * transaction (fail-closed). See `RecoverDivergingSessionOptions`.
   */
  recoverDivergingSession(
    hitchId: string,
    opts: RecoverDivergingSessionOptions,
  ): HitchSession {
    const { revalidate, ...rest } = opts;
    return this.sessions.recoverDivergingSession(hitchId, {
      ...rest,
      ...(revalidate !== undefined
        ? { revalidate: () => revalidate(this) }
        : {}),
    });
  }

  adoptPr(input: AdoptHitchPrInput): HitchSession {
    return this.sessions.adoptPr(input);
  }

  updateSessionConfig(input: UpdateHitchSessionConfigInput): HitchSession {
    return this.sessions.updateSessionConfig(input);
  }

  listLifecycleEvents(hitchId: string): HitchLifecycleEvent[] {
    return this.sessions.listLifecycleEvents(hitchId);
  }

  hasAdoptedPr(hitchId: string): boolean {
    return this.sessions.hasAdoptedPr(hitchId);
  }

  // #125 Track C (C3): attempt concern delegated to AttemptRepository (incl.
  // the private nextIteration counter). The facade keeps these entry-points and
  // forwards to the sub-repo (shared `db`, behaviour-identical). The facade's
  // own latestCodingRunId / newestCodingAttemptRunId call this.listAttempts(),
  // which forwards here.
  createAttempt(input: CreateHitchAttemptInput): HitchAttempt {
    return this.attempts.createAttempt(input);
  }

  completeAttempt(input: CompleteHitchAttemptInput): HitchAttempt {
    return this.attempts.completeAttempt(input);
  }

  discardAttempt(attemptId: string, now = new Date().toISOString()): void {
    this.attempts.discardAttempt(attemptId, now);
  }

  getAttempt(attemptId: string): HitchAttempt | null {
    return this.attempts.getAttempt(attemptId);
  }

  requireAttempt(attemptId: string): HitchAttempt {
    return this.attempts.requireAttempt(attemptId);
  }

  listAttempts(hitchId: string): HitchAttempt[] {
    return this.attempts.listAttempts(hitchId);
  }

  // #125 Track C (C4): review-cycle concern delegated to ReviewCycleRepository
  // (incl. the private nextReviewCycleNumber counter). The facade keeps these
  // entry-points and forwards to the sub-repo (shared `db`, behaviour-identical).
  // startReviewCycle / completeReviewCycle remain the "plain writers" that
  // runAtomically calls directly inside its single BEGIN (no inner transaction).
  startReviewCycle(input: StartHitchReviewCycleInput): HitchReviewCycle {
    return this.reviewCycles.startReviewCycle(input);
  }

  completeReviewCycle(input: CompleteHitchReviewCycleInput): HitchReviewCycle {
    return this.reviewCycles.completeReviewCycle(input);
  }

  /**
   * #306: run a write closure inside a SINGLE transaction so a set of
   * constituent writes commit together or not at all (all-or-nothing). The
   * closure MUST use the non-transactional `*Core` variants for any write that
   * otherwise opens its own transaction ({@link upsertFindingCore},
   * {@link resolveSupersededReviewFindingsCore}) to preserve the single-BEGIN
   * guarantee: better-sqlite3 would otherwise degrade a nested `.transaction()`
   * to a SAVEPOINT (it does NOT throw on a nested BEGIN), which still rolls back
   * to the savepoint on a throw but adds an inner boundary; using the cores keeps
   * a single BEGIN/COMMIT. Plain writers
   * that never open a transaction ({@link startReviewCycle},
   * {@link completeReviewCycle}, {@link recordCloseCheck}) may be called directly.
   * The transaction takes an immediate write lock at BEGIN (consistent with the
   * other mutating repository transactions). On any throw the whole closure rolls
   * back — no half-applied state.
   *
   * This is the atomicity primitive behind {@link importReviewProposalToHitch}:
   * its finding-import + supersede-resolve + cycle-completion (the #278
   * resolve-before-complete ordering) + review_consensus close-check evidence all
   * run inside one call here, closing the documented crash-partial windows where
   * prior review blockers could be left `fixed` while the approving cycle stayed
   * incomplete, or the cycle completed without its required close-check evidence.
   */
  runAtomically<T>(write: () => T): T {
    return this.db.transaction(write).immediate();
  }

  getReviewCycle(cycleId: string): HitchReviewCycle | null {
    return this.reviewCycles.getReviewCycle(cycleId);
  }

  requireReviewCycle(cycleId: string): HitchReviewCycle {
    return this.reviewCycles.requireReviewCycle(cycleId);
  }

  listReviewCycles(hitchId: string): HitchReviewCycle[] {
    return this.reviewCycles.listReviewCycles(hitchId);
  }

  // #125 Track C (C6): finding concern delegated to FindingRepository. The
  // facade keeps every public finding entry-point and forwards to this.findings.*
  // (shared `db`, behaviour-identical). ATOMIC SEAM (#306 — do NOT change): the
  // single-BEGIN primitive `runAtomically` stays HERE on the facade; the facade's
  // `upsertFindingCore` / `resolveSupersededReviewFindingsCore` forward to the
  // sub-repo's NON-transactional cores so they compose inside the facade's outer
  // BEGIN on the shared db handle (review-integration.ts calls them inside
  // `runAtomically`). `upsertFinding`'s throw-before-BEGIN prelude is preserved
  // inside the sub-repo's public wrapper.
  upsertFinding(input: UpsertHitchFindingInput): UpsertHitchFindingResult {
    return this.findings.upsertFinding(input);
  }

  upsertFindingCore(input: UpsertHitchFindingInput): UpsertHitchFindingResult {
    return this.findings.upsertFindingCore(input);
  }

  classifyFinding(input: ClassifyHitchFindingInput): HitchFinding {
    return this.findings.classifyFinding(input);
  }

  classifyAndDeferFinding(
    input: ClassifyAndDeferHitchFindingInput,
  ): ClassifyAndDeferHitchFindingResult {
    return this.findings.classifyAndDeferFinding(input);
  }

  markFindingFixed(input: MarkHitchFindingFixedInput): HitchFinding {
    return this.findings.markFindingFixed(input);
  }

  resolveSupersededReviewFindings(
    input: ResolveSupersededReviewFindingsInput,
  ): HitchFinding[] {
    return this.findings.resolveSupersededReviewFindings(input);
  }

  resolveSupersededReviewFindingsCore(
    input: ResolveSupersededReviewFindingsInput,
  ): HitchFinding[] {
    return this.findings.resolveSupersededReviewFindingsCore(input);
  }

  deferFinding(input: DeferHitchFindingInput): HitchFinding {
    return this.findings.deferFinding(input);
  }

  linkFindingIssue(findingId: string, issueUrl: string): HitchFinding {
    return this.findings.linkFindingIssue(findingId, issueUrl);
  }

  getFinding(findingId: string): HitchFinding | null {
    return this.findings.getFinding(findingId);
  }

  requireFinding(findingId: string): HitchFinding {
    return this.findings.requireFinding(findingId);
  }

  listFindings(filter: HitchFindingFilter = {}): HitchFinding[] {
    return this.findings.listFindings(filter);
  }

  countFindings(filter: HitchFindingFilter = {}): number {
    return this.findings.countFindings(filter);
  }

  countFindingSummary(hitchId: string): HitchFindingSummaryCounts {
    return this.findings.countFindingSummary(hitchId);
  }

  // #125 Track C (C7): metrics/read concern delegated to MetricsRepository.
  // The facade keeps these read entry-points and forwards to the sub-repo
  // (shared `db`, behaviour-identical). maxFindingReopenCount /
  // latestFindingMutationAt stay with the FINDING concern (they read finding
  // mutation columns, not the divergence/run-lineage derivations).
  harnessOriginDivergenceMetrics(
    hitchId: string,
  ): HitchHarnessOriginDivergenceMetrics {
    return this.metrics.harnessOriginDivergenceMetrics(hitchId);
  }

  maxFindingReopenCount(hitchId: string): number {
    return this.findings.maxFindingReopenCount(hitchId);
  }

  latestFindingMutationAt(hitchId: string): string | null {
    return this.findings.latestFindingMutationAt(hitchId);
  }

  linkedPhaseSpecApprovalDrifts(
    hitchId: string,
  ): LinkedPhaseSpecApprovalDrift[] {
    return this.metrics.linkedPhaseSpecApprovalDrifts(hitchId);
  }

  // #125 Track C (C2): close-check concern delegated to CloseCheckRepository.
  // The facade keeps these entry-points and forwards to the sub-repo (shared
  // `db`, behaviour-identical).
  recordCloseCheck(input: RecordHitchCloseCheckInput): HitchCloseCheck {
    return this.closeChecks.recordCloseCheck(input);
  }

  getCloseCheck(checkId: string): HitchCloseCheck | null {
    return this.closeChecks.getCloseCheck(checkId);
  }

  requireCloseCheck(checkId: string): HitchCloseCheck {
    return this.closeChecks.requireCloseCheck(checkId);
  }

  listCloseChecks(hitchId: string): HitchCloseCheck[] {
    return this.closeChecks.listCloseChecks(hitchId);
  }

  // #125 Track C (C1): convergence-decision concern delegated to
  // ConvergenceDecisionRepository. The facade keeps these entry-points and
  // forwards to the sub-repo (shared `db`, behaviour-identical).
  recordConvergenceDecision(
    input: RecordHitchConvergenceDecisionInput,
  ): HitchConvergenceDecisionRecord {
    return this.decisions.recordConvergenceDecision(input);
  }

  getDecision(decisionId: string): HitchConvergenceDecisionRecord | null {
    return this.decisions.getDecision(decisionId);
  }

  requireDecision(decisionId: string): HitchConvergenceDecisionRecord {
    return this.decisions.requireDecision(decisionId);
  }

  listDecisions(hitchId: string): HitchConvergenceDecisionRecord[] {
    return this.decisions.listDecisions(hitchId);
  }

  // #125 Track C (C7): the latest coding run id + its allowed changed paths
  // (facet_red_test close gate input, #279) is delegated to MetricsRepository
  // (incl. the STRICT newest-coding-attempt resolution + run_changed_files /
  // reviewed.meta_json fallback). Behaviour-identical (fail-closed).
  latestCodingRunChangedPaths(hitchId: string): {
    runId: string | null;
    paths: string[];
  } {
    return this.metrics.latestCodingRunChangedPaths(hitchId);
  }
}
