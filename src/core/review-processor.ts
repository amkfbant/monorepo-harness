import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
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
import { acquireDomainLock } from "../workspace/domain-lock.js";
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
   * locksDir is required: review processing mutates meta.json, which
   * `harness cleanup` for the same run also mutates. Both acquire the
   * per-domain lock so a concurrent cleanup can't interleave a stale
   * meta write.
   */
  locksDir: string;
  /** harness DB path — a `db-first` run is processed through the DB. */
  dbPath: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
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

  // Open the DB BEFORE the file domain lock so an open failure cannot
  // leak a held lock. The DB also tells us whether the run is db-first,
  // which decides what (DB row vs meta.json) is the canonical source for
  // the lock key. Phase 9 post-close P0 fix: open through the managed
  // wrapper so the DB-wide shared maintenance lock is held for the
  // lifetime of this command — a concurrent `db restore` must wait.
  const dbHandle = openManagedDb({ dbPath: opts.dbPath });
  const db = dbHandle.db;
  let lock: Awaited<ReturnType<typeof acquireDomainLock>> | undefined;
  try {
    runMigrations(db);
    // Phase 9-11: refuse to operate on a DB that still has legacy-file
    // runtime rows — operators must run `db migrate-legacy` first.
    assertNoLegacyRuntimeRows(db);
    const dbRow = db
      .prepare(
        "SELECT source_mode, domain, repo_id, status FROM runs WHERE run_id = ?",
      )
      .get(opts.runId) as
      | {
          source_mode: string;
          domain: string;
          repo_id: string | null;
          status: string;
        }
      | undefined;
    if (
      dbRow !== undefined &&
      dbRow.source_mode !== "db-first" &&
      dbRow.source_mode !== "legacy-file"
    ) {
      throw new SourceModeError(
        opts.runId,
        dbRow.source_mode,
        "db-first | legacy-file",
      );
    }
    const dbFirst = dbRow?.source_mode === "db-first";

    // lock key: a db-first run is DB-canonical, so its domain/repoId come
    // from the DB row; a legacy / not-in-DB run probes meta.json.
    let lockDomain: string;
    let lockRepoId: string | undefined;
    if (dbFirst && dbRow !== undefined) {
      lockDomain = dbRow.domain;
      lockRepoId = dbRow.repo_id ?? undefined;
    } else {
      const probe = await readMeta(metaPath, opts.runId);
      lockDomain = probe.domain;
      lockRepoId =
        typeof probe.repoId === "string" ? probe.repoId : undefined;
    }
    lock = await acquireDomainLock({
      locksDir: opts.locksDir,
      domain: lockDomain,
      runId: `review:${opts.runId}`,
      // namespace the lock by repo so the same domain id across two repos
      // does not collide — must match how `harness run` acquired it.
      ...(lockRepoId !== undefined ? { repoId: lockRepoId } : {}),
    });
    return await processUnderLock(
      opts,
      runDir,
      metaPath,
      decisionPath,
      db,
      dbFirst,
    );
  } finally {
    try {
      dbHandle.close();
    } finally {
      if (lock !== undefined) await lock.release();
    }
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
      if (
        runRow !== undefined &&
        runRow.status !== "needs_review" &&
        runRow.reviewed_at !== null
      ) {
        // the run is already promoted in the DB AND a processed
        // proposal records who did it — re-running `review process`
        // is a no-op.
        return {
          runId: opts.runId,
          previousStatus: runRow.status as RunStatus,
          newStatus: runRow.status as RunStatus,
          reviewer: runRow.reviewer,
          reviewedAt: runRow.reviewed_at,
          warnings: ["already processed — idempotent no-op"],
        };
      }
    }
  }
  const activeProposal = proposalRepo.getLatestActiveProposal(opts.runId);
  if (activeProposal !== null) {
    try {
      decision = parseReviewDecisionYaml(activeProposal.sourceYaml);
      proposalId = activeProposal.proposalId;
    } catch (e) {
      throw new ReviewGateError(
        `review_proposals row for ${opts.runId} is malformed: ` +
          `${(e as Error).message}`,
      );
    }
  } else {
    try {
      decision = await loadReviewDecision(decisionPath);
    } catch (e) {
      throw new ReviewGateError(
        `failed to read review-decision.yaml for ${opts.runId}: ${(e as Error).message}`,
      );
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
            },
          }
        : {}),
    });
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
