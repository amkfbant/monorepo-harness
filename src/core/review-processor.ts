import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { RunMeta, RunStatus } from "../logging/run-log.js";
import {
  loadReviewDecision,
  writeReviewDecision,
  serializeReviewDecision,
  parseReviewDecisionYaml,
} from "./review-decision-loader.js";
import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import type { ReviewDecisionValue } from "./review-decision-schema.js";
import { warnLegacyFileLocks } from "../workspace/legacy-file-lock-warning.js";
import { ReviewRulesRepository } from "../db/repositories/review-rules.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import {
  ReviewOverridesRepository,
  OverrideReasonRequiredError,
  UnauthorizedOverrideError,
} from "../db/repositories/review-overrides.js";
import { ReviewerRepository } from "../db/repositories/reviewers.js";
import {
  evaluateConsensus,
  type EnrichedProposal,
} from "./review-consensus.js";
import { activeProposalRows, enrichRows } from "./consensus-enrichment.js";
import {
  DEFAULT_REVIEW_RULE,
  ruleSha256,
  type ReviewRule,
} from "./review-rule.js";

/**
 * Phase 11-5: persist a consensus row for the just-promoted decision.
 * Phase 11 default rule is `latest-proposal`, so consensus mirrors the
 * single processed proposal. The row makes the decision visible to
 * future consensus consumers (dashboard / governance) without changing
 * the existing single-writer review flow.
 */
/**
 * Phase 11-6: human override execution path. Skips the proposal /
 * decision-file lookup, gates on the run's review rule snapshot, and
 * promotes the override decision directly via `applyReviewDecision`.
 */
function processOverridePath(
  db: Database.Database,
  opts: ProcessOpts,
  override: NonNullable<ProcessOpts["override"]>,
): ProcessResult {
  runMigrations(db);
  assertNoLegacyRuntimeRows(db);
  const dbRow = db
    .prepare("SELECT source_mode, status FROM runs WHERE run_id = ?")
    .get(opts.runId) as { source_mode: string; status: string } | undefined;
  if (dbRow === undefined) {
    throw new ReviewGateError(`run ${opts.runId} not found in the DB`);
  }
  if (dbRow.source_mode !== "db-first") {
    throw new SourceModeError(opts.runId, dbRow.source_mode, "db-first");
  }
  // Rule snapshot gate — Phase 11-6 §D2.
  const snapshot = new ReviewRulesRepository(db).findSnapshotByRun(
    opts.runId,
  );
  const rule: ReviewRule =
    snapshot === null
      ? DEFAULT_REVIEW_RULE
      : (JSON.parse(snapshot.ruleJson) as ReviewRule);
  const actor = override.actorReviewerId ?? "system";
  if (!rule.overrides.allowedReviewers.includes(actor)) {
    throw new UnauthorizedOverrideError(actor, rule.overrides.allowedReviewers);
  }
  if (rule.overrides.requireReason && override.reason.trim() === "") {
    throw new OverrideReasonRequiredError();
  }
  // resolve actor reviewer (FK to reviewers table; unknown reviewer is
  // rejected by the FK already, but resolveOrThrow gives a friendlier
  // error message).
  new ReviewerRepository(db).resolveOrThrow(actor);

  const reviewedAt = (opts.now ?? new Date()).toISOString();
  // Build a synthetic normalised review-decision yaml so review_decisions
  // and (when export ON) the sidecar reflect the override.
  const decisionYaml = serializeReviewDecision({
    runId: opts.runId,
    domain: "(override)",
    decision: override.decision,
    required_changes: [],
    non_blocking_comments: [],
    out_of_scope_suggestions: [],
    reviewer: actor,
    reviewed_at: reviewedAt,
  });

  // Phase 11 post-close P1: consensus must reflect the override and
  // review_overrides.consensus_id must be linked. Order:
  //   1. consensus insertActive (with override summary so
  //      decisionPath='override')
  //   2. applyReviewDecision (links consensus_id into review_decisions)
  //   3. review_overrides INSERT with consensus_id
  const overridesRepo = new ReviewOverridesRepository(db);
  const consensusRow = recordConsensusForReviewProcess(db, {
    runId: opts.runId,
    decision: override.decision,
    reviewer: actor,
    reviewedAt,
    override: {
      decision: override.decision,
      actorReviewerId: actor,
      reason: override.reason,
      createdAt: reviewedAt,
    },
  });
  new RunRepository(db).applyReviewDecision({
    runId: opts.runId,
    decision: override.decision,
    reviewer: actor,
    reviewedAt,
    requiredChanges: [],
    decisionYaml,
    ...(consensusRow !== null
      ? {
          consensusId: consensusRow.consensusId,
          proposalsSummaryJson: consensusRow.summaryJson,
        }
      : {}),
  });
  const ovr = overridesRepo.insert({
    runId: opts.runId,
    actorReviewerId: actor,
    decision: override.decision,
    reason: override.reason,
    now: opts.now ?? new Date(),
    ...(consensusRow !== null ? { consensusId: consensusRow.consensusId } : {}),
  });
  warnIfExportFailed(exportRun(db, opts.runId, { runsDir: opts.runsDir }));
  return {
    runId: opts.runId,
    previousStatus: dbRow.status as RunStatus,
    newStatus: override.decision as RunStatus,
    reviewer: actor,
    reviewedAt,
    warnings: [`human override (audit override_id=${ovr.overrideId})`],
  };
}

/**
 * Phase 2 (consensus production wiring): `review process` for a run whose
 * effective rule is `mode: consensus`. Instead of promoting a single
 * proposal, it evaluates consensus over ALL active proposals (enriched with
 * reviewer group / type) and:
 *   - refuses to promote while consensus is `pending` (fail-closed — quorum
 *     not met / requirements pending),
 *   - promotes the decisive consensus status (approved / changes_requested /
 *     rejected), recording the consensus row from the real proposals and
 *     marking every aggregated proposal processed.
 *
 * The default `latest-proposal` mode is unaffected; this path runs only when
 * the run's rule snapshot declares consensus mode.
 */
function processConsensusModePath(
  db: Database.Database,
  opts: ProcessOpts,
  rule: ReviewRule,
  ruleSha: string,
): ProcessResult {
  const row = db
    .prepare("SELECT domain, status FROM runs WHERE run_id = ?")
    .get(opts.runId) as { domain: string; status: string } | undefined;
  if (row === undefined) {
    throw new ReviewGateError(`run ${opts.runId} not found in the DB`);
  }
  if (row.status !== "needs_review") {
    throw new ReviewGateError(
      `run ${opts.runId} status is "${row.status}", only needs_review can be processed`,
    );
  }

  const proposalRepo = new ReviewProposalRepository(db);
  const reviewerRepo = new ReviewerRepository(db);
  const rows = activeProposalRows(proposalRepo, opts.runId);
  if (rows.length === 0) {
    throw new ReviewGateError(
      `no active review proposals to evaluate for ${opts.runId}; run \`review auto\` first`,
    );
  }
  const reviewedAt = (opts.now ?? new Date()).toISOString();
  const result = evaluateConsensus({
    rule,
    ruleSha256: ruleSha,
    proposals: enrichRows(rows, reviewerRepo),
    evaluatedAt: reviewedAt,
  });
  if (result.status === "pending") {
    // fail-closed: consensus is not satisfied yet (quorum/requirements
    // pending). Do NOT promote the run on a partial set of approvals.
    throw new ReviewGateError(
      `consensus not yet satisfied for ${opts.runId} (${result.summary.decisionPath})`,
    );
  }

  const decision = result.status;
  // Required changes feed rerun; aggregate them from the proposals that did
  // not approve (deduplicated, order-stable).
  const requiredChanges = dedupeStrings(
    rows
      .filter((r) => r.decision !== "approved")
      .flatMap((r) => r.requiredChanges),
  );
  const consensusRow = new ReviewConsensusRepository(db).insertActive({
    runId: opts.runId,
    ruleSha256: ruleSha,
    status: decision,
    summary: result.summary,
    evaluatedAt: reviewedAt,
    evaluatedBy: "consensus",
    sourceProposalIds: rows.map((r) => r.proposalId),
  });
  const decisionYaml = serializeReviewDecision({
    runId: opts.runId,
    domain: row.domain,
    decision,
    required_changes: requiredChanges,
    non_blocking_comments: [],
    out_of_scope_suggestions: [],
    reviewer: "consensus",
    reviewed_at: reviewedAt,
  });
  new RunRepository(db).applyReviewDecision({
    runId: opts.runId,
    decision,
    reviewer: "consensus",
    reviewedAt,
    requiredChanges,
    decisionYaml,
    consensusId: consensusRow.consensusId,
    proposalsSummaryJson: consensusRow.summaryJson,
  });
  // Mark every aggregated proposal processed (audit: which proposals the
  // consensus decision was computed from).
  for (const r of rows) {
    proposalRepo.markProcessed(r.proposalId, opts.runId, reviewedAt);
  }
  warnIfExportFailed(exportRun(db, opts.runId, { runsDir: opts.runsDir }));
  return {
    runId: opts.runId,
    previousStatus: "needs_review",
    newStatus: decision as RunStatus,
    reviewer: "consensus",
    reviewedAt,
    warnings: [
      `consensus decision over ${rows.length} proposal(s) ` +
        `(${result.summary.decisionPath})`,
    ],
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function recordConsensusForReviewProcess(
  db: Database.Database,
  input: {
    runId: string;
    decision: "approved" | "changes_requested" | "rejected";
    reviewer: string | null;
    reviewedAt: string;
    proposalId?: number;
    /** Phase 11 post-close P1: override → consensus.summary.override. */
    override?: {
      decision: "approved" | "changes_requested" | "rejected";
      actorReviewerId: string;
      reason: string;
      createdAt: string;
    };
  },
): { consensusId: number; summaryJson: string } | null {
  const snapshot = new ReviewRulesRepository(db).findSnapshotByRun(
    input.runId,
  );
  // If no snapshot row exists (e.g. an older run created before Phase
  // 11-5), fall back to the default rule on the fly.
  const rule: ReviewRule =
    snapshot === null
      ? DEFAULT_REVIEW_RULE
      : (JSON.parse(snapshot.ruleJson) as ReviewRule);
  const ruleSha = snapshot?.sourceSha256 ?? ruleSha256(rule);
  const proposals: EnrichedProposal[] =
    input.proposalId !== undefined
      ? [
          {
            proposalId: input.proposalId,
            reviewerId: input.reviewer,
            reviewerType: "unknown",
            groupId: null,
            decision: input.decision,
            reviewedAt: input.reviewedAt,
          },
        ]
      : []; // file-only / override path: no real proposal row
  const result = evaluateConsensus({
    rule,
    ruleSha256: ruleSha,
    proposals,
    ...(input.override !== undefined ? { override: input.override } : {}),
    evaluatedAt: input.reviewedAt,
  });
  const row = new ReviewConsensusRepository(db).insertActive({
    runId: input.runId,
    ruleSha256: ruleSha,
    status: result.status,
    summary: result.summary,
    evaluatedAt: input.reviewedAt,
    evaluatedBy: input.reviewer ?? "review-process",
    sourceProposalIds:
      input.proposalId !== undefined ? [input.proposalId] : [],
  });
  return { consensusId: row.consensusId, summaryJson: row.summaryJson };
}
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { RunRepository } from "../db/repositories/runs.js";
import { exportRun, warnIfExportFailed } from "../db/export-files.js";
import { SourceModeError } from "../db/errors.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";

/**
 * Thrown when review processing is rejected for a reason the user can fix
 * (pending decision, mismatched runId/domain, status that isn't
 * needs_review, malformed review-decision.yaml, missing run dir).
 *
 * The CLI maps this to exit code 1; unexpected exceptions (e.g. unrelated
 * fs errors, programming bugs) propagate to exit code 2.
 */
export class ReviewGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewGateError";
  }
}

export interface ProcessOpts {
  runsDir: string;
  runId: string;
  /**
   * locksDir is retained for callers that still pass it (e.g. CLI/tests).
   * Phase 10-1: the file domain lock has been retired; review processing
   * relies on the DB state guard (status / processed_at / source_sha256 /
   * superseded_at) to reject stale or concurrent writes. The path is
   * used only for the legacy file-lock warning helper.
   */
  locksDir: string;
  /** harness DB path — a `db-first` run is processed through the DB. */
  dbPath: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /**
   * Phase 11-6 — human override path. When provided, the override
   * decision is used instead of reading review_proposals /
   * review-decision.yaml. The override is gated by the run's review
   * rule snapshot (overrides.allowedReviewers / requireReason) and
   * audited in `review_overrides` + `run_events`.
   */
  override?: {
    decision: "approved" | "changes_requested" | "rejected";
    reason: string;
    /** actor reviewer_id; defaults to 'system'. */
    actorReviewerId?: string;
  };
  /** Optional active proposal id guard for callers that previewed a specific proposal. */
  proposalId?: number;
  /** Optional active proposal source hash guard for stale-preview rejection. */
  sourceSha256?: string;
}

export interface ProcessResult {
  runId: string;
  previousStatus: RunStatus;
  newStatus: RunStatus;
  reviewer: string | null;
  reviewedAt: string;
  warnings: string[];
}

const DECISION_TO_STATUS: Record<
  Exclude<ReviewDecisionValue, "pending">,
  RunStatus
> = {
  approved: "approved",
  changes_requested: "changes_requested",
  rejected: "rejected",
};

// runId must look like a generated id; this also blocks `--run-id ../foo`
// from escaping runsDir. Same shape as the cleanup validator.
const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// User-facing FS error codes. ENOENT etc. on meta.json or
// review-decision.yaml almost always means "user typed wrong --run-id" or
// "forgot to edit the file"; treat as gate error.
function isUserFacingFsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ENOENT" ||
    code === "EISDIR" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM"
  );
}

// Read + parse + shape-validate meta.json. Missing file, permission denied,
// invalid JSON, or wrong shape are all user-fixable → ReviewGateError.
async function readMeta(
  metaPath: string,
  runId: string,
): Promise<RunMeta> {
  let metaRaw: unknown;
  try {
    metaRaw = JSON.parse(await readFile(metaPath, "utf8"));
  } catch (e) {
    if (isUserFacingFsError(e) || e instanceof SyntaxError) {
      throw new ReviewGateError(
        `failed to read meta.json for ${runId}: ${(e as Error).message}`,
      );
    }
    throw e;
  }
  if (!metaRaw || typeof metaRaw !== "object" || Array.isArray(metaRaw)) {
    throw new ReviewGateError(`meta.json for ${runId} is not an object`);
  }
  const meta = metaRaw as RunMeta;
  if (typeof meta.domain !== "string" || meta.domain === "") {
    throw new ReviewGateError(`meta.json for ${runId} has invalid domain`);
  }
  if (typeof meta.status !== "string") {
    throw new ReviewGateError(`meta.json for ${runId} has invalid status`);
  }
  return meta;
}

export async function processReviewDecision(
  opts: ProcessOpts,
): Promise<ProcessResult> {
  // Block --run-id ../escape and other path-traversal attempts BEFORE we
  // touch the filesystem. Same defense as cleanup.
  if (!RUN_ID_RE.test(opts.runId)) {
    throw new ReviewGateError(
      `invalid runId: ${JSON.stringify(opts.runId)}`,
    );
  }
  const runDir = join(opts.runsDir, opts.runId);
  const metaPath = join(runDir, "meta.json");
  const decisionPath = join(runDir, "review-decision.yaml");

  // Phase 9 post-close P0 fix: open through the managed wrapper so the
  // DB-wide shared maintenance lock is held for the lifetime of this
  // command — a concurrent `db restore` must wait. Phase 10-1: the file
  // domain lock is retired; review process is serialized by the expected
  // status / operation_id state guard (a concurrent run keeps the run in
  // `coding`, which the review-decision SQL guard rejects).
  warnLegacyFileLocks(opts.locksDir);
  const dbHandle = openManagedDb({ dbPath: opts.dbPath });
  const db = dbHandle.db;

  // Phase 11-6: human override path bypasses proposal lookup. The
  // override is gated by the run's review rule snapshot
  // (overrides.allowedReviewers / requireReason) and audited in
  // `review_overrides`.
  if (opts.override !== undefined) {
    try {
      return processOverridePath(db, opts, opts.override);
    } finally {
      dbHandle.close();
    }
  }
  try {
    runMigrations(db);
    // Phase 9-11: refuse to operate on a DB that still has legacy-file
    // runtime rows — operators must run `db migrate-legacy` first.
    assertNoLegacyRuntimeRows(db);
    const dbRow = db
      .prepare(
        "SELECT source_mode FROM runs WHERE run_id = ?",
      )
      .get(opts.runId) as { source_mode: string } | undefined;
    // Phase 10-6: runtime review process operates only on db-first runs.
    // legacy-file is dead branch (assertNoLegacyRuntimeRows gates above).
    if (dbRow !== undefined && dbRow.source_mode !== "db-first") {
      throw new SourceModeError(
        opts.runId,
        dbRow.source_mode,
        "db-first",
      );
    }
    const dbFirst = dbRow?.source_mode === "db-first";

    // Phase 2: a db-first run whose effective rule is consensus mode is
    // gated by the full consensus evaluation (fail-closed on pending),
    // not by a single proposal. latest-proposal mode falls through to the
    // existing single-proposal path below.
    if (dbFirst) {
      const snapshot = new ReviewRulesRepository(db).findSnapshotByRun(
        opts.runId,
      );
      const rule: ReviewRule =
        snapshot === null
          ? DEFAULT_REVIEW_RULE
          : (JSON.parse(snapshot.ruleJson) as ReviewRule);
      if (rule.mode === "consensus") {
        const ruleSha = snapshot?.sourceSha256 ?? ruleSha256(rule);
        return processConsensusModePath(db, opts, rule, ruleSha);
      }
    }

    return await processUnderLock(
      opts,
      runDir,
      metaPath,
      decisionPath,
      db,
      dbFirst,
    );
  } finally {
    dbHandle.close();
  }
}

async function processUnderLock(
  opts: ProcessOpts,
  runDir: string,
  metaPath: string,
  decisionPath: string,
  db: Database.Database,
  dbFirst: boolean,
): Promise<ProcessResult> {
  // Phase 9-8: the DB-canonical source for the verdict is
  // `review_proposals` (written by `review auto`). Try it first; fall back
  // to the file `review-decision.yaml` so legacy / hand-edited proposals
  // still work.
  let decision: Awaited<ReturnType<typeof loadReviewDecision>>;
  let proposalId: number | null = null;
  // Phase 10-5 (design §3.E E1) — capture the proposal sha so the
  // applyReviewDecision transaction can guard against a stale rewrite
  // by a concurrent `review auto`.
  let proposalSha256: string | null = null;
  const proposalRepo = new ReviewProposalRepository(db);
  // Phase 9 post-close P1 #1 fix — if a prior `review process` invocation
  // already promoted a proposal for this run but crashed before some
  // observable side effect (the file backfill, the response), surface
  // that idempotent state instead of failing the `status = needs_review`
  // gate. The active proposal lookup below filters out `processed_at IS
  // NOT NULL`, so an unconditional return-once-processed check here would
  // hide nothing the active path uses.
  if (dbFirst) {
    const processed = proposalRepo.getLatestProcessedProposal(opts.runId);
    if (processed !== null) {
      const runRow = db
        .prepare("SELECT status, reviewer, reviewed_at FROM runs WHERE run_id = ?")
        .get(opts.runId) as
        | { status: string; reviewer: string | null; reviewed_at: string | null }
        | undefined;
      const runAlreadyPromoted =
        runRow !== undefined &&
        runRow.status !== "needs_review" &&
        runRow.reviewed_at !== null;
      if (opts.proposalId !== undefined) {
        // A caller-bound proposal must not inherit the legacy idempotent no-op
        // from a different processed proposal. If another proposal moved the
        // run, continue to the normal state gate below so it is stale.
        if (
          processed.proposalId === opts.proposalId &&
          opts.sourceSha256 !== undefined &&
          processed.sourceSha256 !== opts.sourceSha256
        ) {
          throw new ReviewGateError(
            `review proposal ${processed.proposalId} sourceSha256 changed; expected ${opts.sourceSha256}, got ${processed.sourceSha256}`,
          );
        }
        if (processed.proposalId === opts.proposalId && runAlreadyPromoted) {
          return {
            runId: opts.runId,
            previousStatus: runRow.status as RunStatus,
            newStatus: runRow.status as RunStatus,
            reviewer: runRow.reviewer,
            reviewedAt: runRow.reviewed_at as string,
            warnings: ["already processed — idempotent no-op"],
          };
        }
      } else if (runAlreadyPromoted) {
        // the run is already promoted in the DB AND a processed
        // proposal records who did it — re-running `review process`
        // is a no-op.
        return {
          runId: opts.runId,
          previousStatus: runRow.status as RunStatus,
          newStatus: runRow.status as RunStatus,
          reviewer: runRow.reviewer,
          reviewedAt: runRow.reviewed_at as string,
          warnings: ["already processed — idempotent no-op"],
        };
      }
    }
  }
  const activeProposal =
    opts.proposalId === undefined
      ? proposalRepo.getLatestActiveProposal(opts.runId)
      : proposalRepo.getById(opts.proposalId);
  if (activeProposal !== null) {
    if (activeProposal.runId !== opts.runId) {
      throw new ReviewGateError(
        `review proposal ${activeProposal.proposalId} belongs to ${activeProposal.runId}, not ${opts.runId}`,
      );
    }
    if (activeProposal.supersededAt !== null) {
      throw new ReviewGateError(
        `review proposal ${activeProposal.proposalId} is superseded; rerun review before processing`,
      );
    }
    if (activeProposal.processedAt !== null) {
      throw new ReviewGateError(
        `review proposal ${activeProposal.proposalId} is already processed`,
      );
    }
    if (
      opts.sourceSha256 !== undefined &&
      activeProposal.sourceSha256 !== opts.sourceSha256
    ) {
      throw new ReviewGateError(
        `review proposal ${activeProposal.proposalId} sourceSha256 changed; expected ${opts.sourceSha256}, got ${activeProposal.sourceSha256}`,
      );
    }
    if (opts.proposalId !== undefined) {
      const latestActive = proposalRepo.getLatestActiveProposal(opts.runId);
      if (
        latestActive !== null &&
        latestActive.proposalId !== activeProposal.proposalId
      ) {
        throw new ReviewGateError(
          `review proposal ${activeProposal.proposalId} is stale; latest active proposal is ${latestActive.proposalId}`,
        );
      }
    }
    try {
      decision = parseReviewDecisionYaml(activeProposal.sourceYaml);
      proposalId = activeProposal.proposalId;
      proposalSha256 = activeProposal.sourceSha256;
    } catch (e) {
      throw new ReviewGateError(
        `review_proposals row for ${opts.runId} is malformed: ` +
          `${(e as Error).message}`,
      );
    }
  } else {
    if (opts.proposalId !== undefined) {
      throw new ReviewGateError(`review proposal ${opts.proposalId} not found`);
    }
    let decisionYaml: string;
    try {
      decisionYaml = await readFile(decisionPath, "utf8");
    } catch (e) {
      throw new ReviewGateError(
        `failed to read review-decision.yaml for ${opts.runId}: ${(e as Error).message}`,
      );
    }
    try {
      decision = await loadReviewDecision(decisionPath);
    } catch (e) {
      throw new ReviewGateError(
        `failed to read review-decision.yaml for ${opts.runId}: ${(e as Error).message}`,
      );
    }
    // Phase 9 post-close (second review) P2-2 fix — when the verdict
    // came from a file (legacy / hand-edited / pre-Phase-9 run), still
    // insert it as a `review_proposals` row so the audit trail stays
    // DB-canonical. db-first runs only: a legacy-file run is gated by
    // assertNoLegacyRuntimeRows.
    if (dbFirst && decision.decision !== "pending") {
      const fileSha = createHash("sha256").update(decisionYaml).digest("hex");
      const fileReviewer = decision.reviewer ?? "manual-file";
      const createdAt =
        decision.reviewed_at ?? (opts.now ?? new Date()).toISOString();
      try {
        const ins = proposalRepo.insertProposal({
          runId: opts.runId,
          reviewer: fileReviewer,
          decision: decision.decision,
          requiredChanges: decision.required_changes,
          nonBlockingComments: decision.non_blocking_comments,
          outOfScopeSuggestions: decision.out_of_scope_suggestions,
          reviewedAt: createdAt,
          sourceYaml: decisionYaml,
          sourceSha256: fileSha,
          createdAt,
        });
        proposalId = ins.proposalId;
        proposalSha256 = fileSha;
      } catch {
        // best-effort import — if the insert fails (e.g. constraint),
        // continue with the file-only decision so the operator's
        // command is not blocked.
      }
    }
  }
  if (decision.runId !== opts.runId) {
    throw new ReviewGateError(
      `review-decision.yaml runId (${decision.runId}) does not match directory (${opts.runId})`,
    );
  }
  if (decision.decision === "pending") {
    throw new ReviewGateError(
      `decision is still pending in ${decisionPath}; reviewer must set it to approved | changes_requested | rejected`,
    );
  }

  // Resolve the run's domain + status from the CANONICAL source —
  // the DB row for a db-first run, meta.json for a legacy run.
  let currentDomain: string;
  let currentStatus: string;
  let legacyMeta: RunMeta | null = null;
  if (dbFirst) {
    const row = db
      .prepare("SELECT domain, status FROM runs WHERE run_id = ?")
      .get(opts.runId) as { domain: string; status: string } | undefined;
    if (row === undefined) {
      throw new ReviewGateError(`run ${opts.runId} not found in the DB`);
    }
    currentDomain = row.domain;
    currentStatus = row.status;
  } else {
    legacyMeta = await readMeta(metaPath, opts.runId);
    currentDomain = legacyMeta.domain;
    currentStatus = legacyMeta.status;
  }

  if (decision.domain !== currentDomain) {
    throw new ReviewGateError(
      `review-decision.yaml domain (${decision.domain}) does not match the run domain (${currentDomain})`,
    );
  }
  if (currentStatus !== "needs_review") {
    throw new ReviewGateError(
      `run ${opts.runId} status is "${currentStatus}", only needs_review can be processed`,
    );
  }

  const warnings: string[] = [];
  if (decision.reviewer === null) {
    warnings.push("reviewer field is null");
  }

  const newStatus = DECISION_TO_STATUS[decision.decision];
  const now = opts.now ?? new Date();
  const reviewedAt = decision.reviewed_at ?? now.toISOString();

  // Phase 7-5: a `db-first` run is processed through the DB — a guarded
  // status transition + `review_decisions`, then re-export. A legacy /
  // file-canonical run keeps the direct meta.json / events.jsonl writes.
  // the normalized decision document (reviewed_at backfilled) is the
  // single source: it is stored in `review_decisions.source_yaml` AND is
  // what `exportRun` writes back to `review-decision.yaml`, so the DB and
  // the sidecar never diverge (P1-2).
  const normalizedYaml = serializeReviewDecision({
    ...decision,
    reviewed_at: reviewedAt,
  });
  if (dbFirst) {
    // Phase 9 post-close P1 #1 fix — promote the run AND mark the source
    // proposal processed in one transaction so a crash between the two
    // cannot leave an active-but-unprocessed proposal behind.
    new RunRepository(db).applyReviewDecision({
      runId: opts.runId,
      decision: decision.decision,
      reviewer: decision.reviewer,
      reviewedAt,
      requiredChanges: decision.required_changes,
      decisionYaml: normalizedYaml,
      ...(proposalId !== null
        ? {
            markProposalProcessed: {
              proposalId,
              reviewDecisionId: opts.runId,
              ...(proposalSha256 !== null
                ? { expectedSourceSha256: proposalSha256 }
                : {}),
            },
          }
        : {}),
    });

    // Phase 11-5: record a consensus row reflecting the just-promoted
    // decision. Phase 11 default rule is `latest-proposal` mode, so the
    // consensus simply mirrors the chosen proposal's decision. Failures
    // are best-effort: a missing snapshot row or an unexpected proposal
    // shape must not unwind the just-completed promotion.
    try {
      recordConsensusForReviewProcess(db, {
        runId: opts.runId,
        decision: decision.decision,
        reviewer: decision.reviewer,
        reviewedAt,
        ...(proposalId !== null ? { proposalId } : {}),
      });
    } catch (e) {
      process.stderr.write(
        `warning: could not record review consensus for ${opts.runId}: ` +
          `${(e as Error).message}\n`,
      );
    }

    warnIfExportFailed(exportRun(db, opts.runId, { runsDir: opts.runsDir }));
  } else {
    const updatedMeta: RunMeta = {
      ...(legacyMeta as RunMeta),
      status: newStatus,
      reviewer: decision.reviewer,
      reviewedAt,
    };
    await writeFile(
      metaPath,
      `${JSON.stringify(updatedMeta, null, 2)}\n`,
      "utf8",
    );
    const event = {
      type: "review_processed",
      runId: opts.runId,
      decision: decision.decision,
      previousStatus: currentStatus,
      newStatus,
      reviewer: decision.reviewer,
      reviewedAt,
    };
    await appendFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  }

  // A db-first run's `review-decision.yaml` is exported from the DB by
  // `exportRun` above (P1-2) — it is already normalized. A legacy run
  // backfills the sidecar's reviewed_at directly, ONLY after the canonical
  // write succeeded (a failed guard must not mutate the input file).
  if (!dbFirst && decision.reviewed_at === null) {
    await writeReviewDecision(decisionPath, {
      ...decision,
      reviewed_at: reviewedAt,
    });
  }

  // Phase 9-8: if the verdict came from a DB proposal, mark it processed
  // so a re-run can no-op (and the audit trail records which decision
  // came from which proposal).
  //
  // Phase 9 post-close P1 #1 fix — on the `dbFirst` path this UPDATE has
  // already happened inside `applyReviewDecision`'s transaction; the
  // `WHERE processed_at IS NULL` guard in `markProcessed` makes this
  // call an idempotent no-op there. The legacy-file path still relies on
  // it.
  //
  // Phase 9 post-close (second review) P1-4 — on the legacy-file path
  // a 0-rows changed result here means the proposal was concurrently
  // superseded between read and mark. Surface it as a warning (the
  // file-side decision is already applied; the DB just couldn't audit
  // which proposal it came from).
  if (proposalId !== null) {
    const ok = proposalRepo.markProcessed(proposalId, opts.runId, reviewedAt);
    if (!ok && !dbFirst) {
      warnings.push(
        `review_proposals(id=${proposalId}) was superseded between read ` +
          `and mark; the file-side decision is applied but the DB audit ` +
          `link was not recorded`,
      );
    }
  }

  return {
    runId: opts.runId,
    previousStatus: currentStatus as RunStatus,
    newStatus,
    reviewer: decision.reviewer,
    reviewedAt,
    warnings,
  };
}
