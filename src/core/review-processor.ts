import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { RunMeta, RunStatus } from "../logging/run-log.js";
import {
  loadReviewDecision,
  writeReviewDecision,
} from "./review-decision-loader.js";
import type { ReviewDecisionValue } from "./review-decision-schema.js";
import { acquireDomainLock } from "../workspace/domain-lock.js";
import { openDb } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { RunRepository } from "../db/repositories/runs.js";
import { exportRun, warnIfExportFailed } from "../db/export-files.js";
import { SourceModeError } from "../db/errors.js";

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

  // Open the DB BEFORE the lock so an open failure cannot leak a held
  // lock. The DB also tells us whether the run is db-first, which decides
  // what (DB row vs meta.json) is the canonical source for the lock key.
  const db = openDb(opts.dbPath);
  let lock: Awaited<ReturnType<typeof acquireDomainLock>> | undefined;
  try {
    runMigrations(db);
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
      db.close();
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
  // Load + validate review-decision.yaml. Any failure here (FS error,
  // YAML parse error, Zod validation error) is by definition user-fixable
  // since the reviewer just edited this file.
  let decision: Awaited<ReturnType<typeof loadReviewDecision>>;
  try {
    decision = await loadReviewDecision(decisionPath);
  } catch (e) {
    throw new ReviewGateError(
      `failed to read review-decision.yaml for ${opts.runId}: ${(e as Error).message}`,
    );
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
  if (dbFirst) {
    new RunRepository(db).applyReviewDecision({
      runId: opts.runId,
      decision: decision.decision,
      reviewer: decision.reviewer,
      reviewedAt,
      requiredChanges: decision.required_changes,
      decisionYaml: await readFile(decisionPath, "utf8"),
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

  // Backfill review-decision.yaml's reviewed_at ONLY after the canonical
  // write succeeded — a failed guard must not leave the input file
  // mutated while the decision was not applied.
  if (decision.reviewed_at === null) {
    await writeReviewDecision(decisionPath, {
      ...decision,
      reviewed_at: reviewedAt,
    });
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
