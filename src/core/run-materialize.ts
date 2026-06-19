import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type Database from "better-sqlite3";
import { DbError } from "../db/connection.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { exportRun } from "../db/export-files.js";
import {
  ingestRunArtifactPaths,
  ingestRunArtifacts,
  markArtifactsQuarantined,
} from "../db/run-artifacts.js";
import {
  REVIEWER_INPUT_DIRS,
  REVIEWER_INPUT_FILES,
} from "./reviewer-artifact-isolation.js";
import { fileExportEnabled } from "../config/export-mode.js";
import {
  recordScratchMaterialization,
  markScratchCleaned,
  markScratchFailed,
  listActiveScratchForRun,
} from "../db/repositories/run-materializations.js";

export const REPAIR_MISSING_REVIEW_DECISION_REASON =
  "ensureRunMaterialized:repair-missing-review-decision";

export interface UntrustedReviewerArtifactsSync {
  reviewerEventsPublished: boolean;
}

const UNTRUSTED_REVIEWER_ARTIFACTS = [
  "reviewer-agent.out.log",
  "reviewer-agent.err.log",
  ".reviewer-agent.events.raw.jsonl",
  ".reviewer-agent.events.redacted.tmp",
] as const;

const REVIEWER_GATE_ERROR_ARTIFACTS = ["review-auto-error.json"] as const;

/**
 * The reviewer gate-error sidecar (`reviewers/<id>/review-auto-error.json`) is
 * TRANSIENT, not a durable audit transcript (#303): `runReviewerAgent` removes
 * it on a successful retry, and the canonical failure record lives in the run
 * event log / `review_proposals`. So the quarantine must NOT stamp it as
 * intentionally-preserved — an absent-on-disk reviewer gate-error row is a
 * superseded artifact the db-first full sync should PRUNE, not re-materialize.
 *
 * The exclusion is NARROW: it matches ONLY the reviewer sidecar shape
 * (`reviewers/<id>/review-auto-error.json`, exactly two leading segments). The
 * review-evaluator's per-sample diagnostics
 * (`review-evaluations/<sample>/review-auto-error.json`, #279) share the
 * basename but ARE durable per-sample failure detail, so they stay
 * quarantine-preserved (#303 P2).
 */
const REVIEWER_GATE_ERROR_BASENAMES: ReadonlySet<string> = new Set(
  REVIEWER_GATE_ERROR_ARTIFACTS,
);

function isReviewerGateErrorSidecar(rel: string): boolean {
  const parts = rel.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "reviewers" &&
    parts[1] !== undefined &&
    parts[1] !== "" &&
    REVIEWER_GATE_ERROR_BASENAMES.has(parts[2] as string)
  );
}

function isQuarantinePreservedPath(rel: string): boolean {
  return !isReviewerGateErrorSidecar(rel);
}

const REVIEWER_SCOPED_ARTIFACT_FILES = [
  "reviewer-agent.out.log",
  "reviewer-agent.err.log",
  ".reviewer-agent.events.raw.jsonl",
  ".reviewer-agent.events.redacted.tmp",
  "reviewer-agent.events.jsonl",
  "review-auto-error.json",
] as const;

const REVIEWER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function appendRunEvent(
  db: Database.Database,
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  const occurredAt = new Date().toISOString();
  const seq = (
    db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?",
      )
      .get(runId) as { next: number }
  ).next;
  db.prepare(
    `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    runId,
    seq,
    type,
    occurredAt,
    JSON.stringify({ type, occurredAt, ...payload }),
  );
}

function quarantineUntrustedReviewerArtifacts(opts: {
  db: Database.Database;
  runDir: string;
  runId: string;
  reviewerEventsPublished: boolean;
}): void {
  const candidates = [
    ...UNTRUSTED_REVIEWER_ARTIFACTS,
    ...(opts.reviewerEventsPublished ? [] : ["reviewer-agent.events.jsonl"]),
    ...reviewerScopedArtifactPaths(opts.runDir, [
      "reviewer-agent.out.log",
      "reviewer-agent.err.log",
      ".reviewer-agent.events.raw.jsonl",
      ".reviewer-agent.events.redacted.tmp",
      ...(opts.reviewerEventsPublished ? [] : ["reviewer-agent.events.jsonl"]),
    ]),
  ];
  const quarantined: string[] = [];
  for (const rel of candidates) {
    const source = join(opts.runDir, rel);
    if (!existsSync(source)) continue;
    const target = join(opts.runDir, `.quarantined.${rel.replaceAll("/", "_")}`);
    try {
      rmSync(target, { force: true });
      renameSync(source, target);
      quarantined.push(rel);
    } catch {
      rmSync(source, { force: true });
      quarantined.push(rel);
    }
  }
  if (quarantined.length === 0) return;
  process.stderr.write(
    `warning: run ${opts.runId}: artifacts_quarantined ` +
      `${quarantined.join(", ")}\n`,
  );
  appendRunEvent(opts.db, opts.runId, "artifacts_quarantined", {
    paths: quarantined,
  });
}

function reviewerScopedArtifactPaths(
  runDir: string,
  filenames: readonly string[],
): string[] {
  const reviewersDir = join(runDir, "reviewers");
  if (!existsSync(reviewersDir)) return [];
  let reviewerEntries;
  try {
    reviewerEntries = readdirSync(reviewersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const wanted = new Set(filenames);
  const out: string[] = [];
  for (const reviewerEntry of reviewerEntries) {
    if (
      !reviewerEntry.isDirectory() ||
      !REVIEWER_ID_RE.test(reviewerEntry.name) ||
      reviewerEntry.name.includes("..")
    ) {
      continue;
    }
    const reviewerDir = join(reviewersDir, reviewerEntry.name);
    let files;
    try {
      files = readdirSync(reviewerDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !wanted.has(file.name)) continue;
      out.push(`reviewers/${reviewerEntry.name}/${file.name}`);
    }
  }
  out.sort();
  return out;
}

/**
 * Run materialization helpers (Phase 8-13).
 *
 * With file export optional (Phase 8-5) a db-first run may have no run
 * dir. Commands that genuinely need the run's files on disk — the
 * reviewer agent spawns codex with a read-only sandbox over the run dir —
 * materialize them from the DB first, and sync any artifacts they then
 * add back into the DB so those bodies stay DB-canonical.
 */

/**
 * Restore a db-first run's files from the DB when they are absent.
 * A no-op when the files already exist or the run is not in the DB.
 * Returns true when files were written.
 *
 * Phase 9 post-close (second review) P1-1 fix — this is a **scratch
 * materialization** (the reviewer agent needs the run dir on disk to
 * spawn codex over it). It must NOT be recorded as a compatibility
 * export: with export OFF the DB-only runtime semantics require
 * `runs.export_status` to stay `disabled` and `exported_files` to stay
 * empty. Passing `trackExport: false` keeps the export bookkeeping
 * untouched while still writing the files.
 */
export function ensureRunMaterialized(opts: {
  dbPath: string;
  runsDir: string;
  runId: string;
  /**
   * Repair a partially materialized run dir where meta.json exists but
   * review-decision.yaml is missing. This is intentionally narrower than a
   * generic re-export: review auto needs the sidecar, and the audit reason must
   * identify this repair path.
   */
  repairMissingReviewDecision?: boolean;
  /**
   * Phase 10-3: optional `reason` recorded in `run_materializations`
   * for audit / `db doctor` visibility. Defaults to "ensureRunMaterialized".
   */
  reason?: string;
}): boolean {
  if (!existsSync(opts.dbPath)) return false;
  const runDir = join(opts.runsDir, opts.runId);
  const metaExists = existsSync(join(runDir, "meta.json"));
  const repairMissingReviewDecision =
    opts.repairMissingReviewDecision === true &&
    metaExists &&
    !existsSync(join(runDir, "review-decision.yaml"));
  if (metaExists && !repairMissingReviewDecision) return false;
  const dbHandle = openManagedDb({ dbPath: opts.dbPath });
  const db = dbHandle.db;
  try {
    // force: materialize even with file export OFF — the caller needs
    // the files regardless of the export setting.
    // trackExport: false: scratch materialization is not a compatibility
    // export, so do not flip export_status / exported_files (Phase 9
    // post-close P1-1 fix).
    const result = exportRun(db, opts.runId, {
      runsDir: opts.runsDir,
      force: true,
      trackExport: false,
    });
    // `exportRun` reports a failed export (e.g. a missing blob) via its
    // return value, not an exception — fail loudly so the caller never
    // proceeds to read a partially materialized run dir.
    if (result.status === "failed") {
      throw new DbError(
        `could not materialize run ${opts.runId}: ` +
          `${result.error ?? "export failed"}`,
      );
    }
    // Phase 10-3: record the scratch row so `db doctor` can detect leaks
    // and so `db materialize cleanup --expired` has a list to work from.
    // This is a best-effort write — a failure here must not roll back the
    // already-completed materialization.
    try {
      recordScratchMaterialization(db, {
        runId: opts.runId,
        path: runDir,
        reason:
          opts.reason ??
          (repairMissingReviewDecision
            ? REPAIR_MISSING_REVIEW_DECISION_REASON
            : "ensureRunMaterialized"),
      });
    } catch (e) {
      // Phase 10-3 post-review P2 #1: bookkeeping insert failed but the
      // on-disk scratch dir already exists. We do not abort the caller
      // (that would break the review agent for a bookkeeping issue), but
      // surface the leak explicitly so operators can recover via
      // `harness db materialize cleanup --expired` or manual rm.
      process.stderr.write(
        `warning: could not record scratch materialization for ` +
          `${opts.runId}: ${(e as Error).message} — the scratch dir at ` +
          `${runDir} may leak; ` +
          `\`db doctor\` will not see it. ` +
          `Recover with \`harness db materialize cleanup --run ${opts.runId}\` ` +
          `or remove the dir manually.\n`,
      );
    }
    return true;
  } catch (e) {
    // a DbError naming this run is "no such run" — let the caller's own
    // "run not found" path report it; a materialize failure is rethrown.
    if (e instanceof DbError && e.message.includes("no run")) return false;
    throw e;
  } finally {
    dbHandle.close();
  }
}

/**
 * Re-ingest a db-first run's artifact bodies into the DB after a later
 * command (review auto / reviewed-run) added artifacts to the run dir, so
 * the new bodies are DB-canonical and survive a backup / file wipe.
 *
 * Only db-first runs are synced — a legacy-file run's artifacts stay
 * `storage='file'` (its files are canonical).
 */
export function syncRunArtifactsToDb(opts: {
  dbPath: string;
  runsDir: string;
  runId: string;
  untrustedReviewerArtifacts?: UntrustedReviewerArtifactsSync;
}): void {
  if (!existsSync(opts.dbPath)) return;
  const runDir = join(opts.runsDir, opts.runId);
  if (!existsSync(runDir)) return;
  // Phase 10-3 post-review P1 #1: hold a single shared maintenance lock
  // across ingest, run-dir removal, and scratch bookkeeping so an
  // exclusive `db restore` cannot swap the DB between steps. Phase 10-3
  // post-review P1 #2: only mark scratch rows cleaned AFTER successful
  // removal — a failed rmSync leaves the row in `active` (or `failed`)
  // so `db doctor` / `db materialize cleanup --expired` can see the leak.
  const dbHandle = openManagedDb({ dbPath: opts.dbPath });
  const db = dbHandle.db;
  try {
    // #303 P1#2: `ingestRunArtifacts` reads the v35 `artifacts.quarantined`
    // column. `openManagedDb` does NOT migrate, and this path can run on a
    // freshly-upgraded-but-unmigrated DB (the reviewer flow quarantines before
    // its own migrate), so bring the schema current first. runMigrations is
    // idempotent.
    runMigrations(db);
    const row = db
      .prepare("SELECT source_mode FROM runs WHERE run_id = ?")
      .get(opts.runId) as { source_mode: string } | undefined;
    if (row === undefined || row.source_mode !== "db-first") return;
    if (opts.untrustedReviewerArtifacts !== undefined) {
      quarantineUntrustedReviewerArtifacts({
        db,
        runDir,
        runId: opts.runId,
        reviewerEventsPublished:
          opts.untrustedReviewerArtifacts.reviewerEventsPublished,
      });
    }
    // best-effort post-processing: a sync failure (e.g. an unreadable run
    // dir) must not crash the review command that succeeded — warn and
    // leave the prior manifest intact (ingestRunArtifacts is transactional).
    let ingestOk = false;
    try {
      if (opts.untrustedReviewerArtifacts === undefined) {
        ingestRunArtifacts(db, runDir, opts.runId);
      } else {
        ingestRunArtifactPaths(db, runDir, opts.runId, [
          ...REVIEWER_GATE_ERROR_ARTIFACTS,
          ...reviewerScopedArtifactPaths(
            runDir,
            REVIEWER_SCOPED_ARTIFACT_FILES,
          ),
          ...(opts.untrustedReviewerArtifacts.reviewerEventsPublished
            ? ["reviewer-agent.events.jsonl"]
            : []),
        ]);
      }
      ingestOk = true;
    } catch (e) {
      process.stderr.write(
        `warning: could not sync run ${opts.runId} artifacts to the DB: ` +
          `${(e as Error).message}\n`,
      );
    }
    // Phase 9 post-close (second review) P1-1 fix — with export OFF, a
    // scratch materialization (ensureRunMaterialized) plus a successful
    // ingest leaves a runDir that is no longer needed and would otherwise
    // mislead `run show` (file-first) into rendering stale meta.json /
    // artifact listing. Remove it so the DB stays the single source of
    // truth.
    if (!ingestOk || fileExportEnabled()) return;
    let rmError: Error | undefined;
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch (e) {
      rmError = e as Error;
      process.stderr.write(
        `warning: could not remove scratch run dir ${runDir}: ` +
          `${rmError.message}\n`,
      );
    }
    // Phase 10-3 post-review P1 #2: bookkeeping reflects what actually
    // happened on disk.
    const active = listActiveScratchForRun(db, opts.runId);
    for (const r of active) {
      try {
        if (rmError === undefined) {
          markScratchCleaned(db, r.materializationId);
        } else {
          markScratchFailed(
            db,
            r.materializationId,
            `rm failed: ${rmError.message}`,
          );
        }
      } catch (e) {
        process.stderr.write(
          `warning: could not update run_materializations for ` +
            `${opts.runId} (id=${r.materializationId}): ` +
            `${(e as Error).message}\n`,
        );
      }
    }
  } finally {
    dbHandle.close();
  }
}

/**
 * INPUT-ALLOWLIST (#272 inversion): the only run-dir entries a reviewer
 * legitimately needs to KEEP before its codex starts. Everything ELSE under
 * `runs/<id>/` is a prior output (another reviewer's / pass's / command's
 * artifact) and is quarantined. Using an input-allowlist instead of a
 * verdict-filename denylist means ANY current OR FUTURE verdict-bearing
 * producer (`reviewers/**`, `review-evaluations/**`, refute artifacts, root
 * `review-decision.yaml`, …) is removed by default — no hand-maintained list to
 * keep in sync, no missed vector.
 *
 *   - `meta.json`     — run metadata the harness reads directly from runDir
 *   - `events.jsonl`  — run event log (not verdict-bearing); kept as run state
 *   - REVIEWER_INPUT_FILES / REVIEWER_INPUT_DIRS — the materialized review
 *     inputs (review-request.md / summary.md / final-diff.patch / untracked-* /
 *     commands/). These are the SAME for every reviewer and carry no verdict.
 */
const REVIEWER_RUN_DIR_INPUT_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "meta.json",
  "events.jsonl",
  ...REVIEWER_INPUT_FILES,
  ...REVIEWER_INPUT_DIRS,
]);

/**
 * A run-relative path is DB-ingestable iff `ingestRunArtifactPaths` would
 * actually store it — i.e. no path component is empty / `.` / `..` or
 * dot-prefixed. Raw/tmp dotfile streams (`.reviewer-agent.events.raw.jsonl`,
 * `.reviewer-agent.events.redacted.tmp`, `.refute-agent.events.raw.jsonl`) are
 * therefore NOT ingestable — they are non-canonical raw streams (the published
 * `reviewer-agent.events.jsonl` is the recoverable one), so they are
 * REMOVE-ONLY. Mirrors `isIngestableRelPath` in db/run-artifacts.ts.
 */
function isDbIngestableRelPath(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\")) return false;
  return rel
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !part.startsWith("."),
    );
}

/**
 * Recursively collect every FILE under `dir` as a run-relative path.
 */
function collectFilesRel(runDir: string, dir: string): string[] {
  const out: string[] = [];
  const entries = readDirEntriesSafe(dir);
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collectFilesRel(runDir, abs));
    } else if (e.isFile()) {
      out.push(relative(runDir, abs).split("\\").join("/"));
    }
  }
  return out;
}

/** readdir with file types; [] on error (missing / unreadable dir). */
function readDirEntriesSafe(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * #272 (definitive) — before a reviewer's read-only codex starts, make EVERY
 * prior reviewer's / prior pass's / prior command's verdict UNREACHABLE on disk.
 * codex `--sandbox read-only` can absolute-read ANY path, so cwd isolation alone
 * does not stop a reviewer recovering a prior verdict verbatim from a sibling's
 * `reviewer-agent.out.log` / events, a `review-evaluations/**` log, a refute
 * transcript, or the root/scoped `review-decision.yaml`.
 *
 * INPUT-ALLOWLIST model (DB-backed file-export-OFF review only): keep ONLY the
 * reviewer input allowlist (`REVIEWER_RUN_DIR_INPUT_ALLOWLIST`); treat every
 * OTHER run-dir entry as a prior output to quarantine. Ingestable files are
 * ingested into the DB FIRST (so the audit/export artifact set stays
 * recoverable — no lost logs), then removed; non-ingestable raw dotfile streams
 * are REMOVE-ONLY (intentionally non-recoverable — the published events.jsonl is
 * the canonical one). The CURRENT reviewer's scoped dir is created AFTER this
 * runs, so only prior/completed artifacts are affected. The verdict stays
 * canonical in `review_proposals`; nothing verdict-shaped remains on disk while
 * the next reviewer's codex runs. Returns removed run-rel paths (audit/test).
 * Safe no-op when nothing extra is present.
 */
export function quarantinePriorReviewerVerdictArtifacts(opts: {
  dbPath: string;
  runsDir: string;
  runId: string;
}): { removed: string[]; ingested: string[] } {
  const runDir = join(opts.runsDir, opts.runId);
  if (!existsSync(runDir)) return { removed: [], ingested: [] };
  // P2 (gating): the WHOLE operation — removal AND ingest — runs ONLY for a run
  // row that EXISTS and is `db-first`. In db-first export-OFF the run dir is
  // ephemeral scratch and the DB is canonical, so removal is recoverable. For a
  // missing / legacy / file-first run the DB is NOT canonical, so removing
  // scratch files would lose data with no recovery — fail-closed to a no-op.
  if (!existsSync(opts.dbPath)) return { removed: [], ingested: [] };

  // Enumerate top-level entries; everything not in the input allowlist is a
  // prior output. Collect the full set of files to quarantine (recursively).
  const topLevel = readDirEntriesSafe(runDir);
  const quarantineRoots: string[] = [];
  const quarantineFiles: string[] = [];
  for (const e of topLevel) {
    if (REVIEWER_RUN_DIR_INPUT_ALLOWLIST.has(e.name)) continue;
    const abs = join(runDir, e.name);
    quarantineRoots.push(abs);
    if (e.isDirectory()) {
      quarantineFiles.push(...collectFilesRel(runDir, abs));
    } else if (e.isFile()) {
      quarantineFiles.push(relative(runDir, abs).split("\\").join("/"));
    }
  }
  if (quarantineRoots.length === 0) return { removed: [], ingested: [] };

  const ingested: string[] = [];
  const dbHandle = openManagedDb({ dbPath: opts.dbPath });
  try {
    // #303 P1#2: `markArtifactsQuarantined` writes the v35 `artifacts.quarantined`
    // column. `openManagedDb` does NOT migrate, and `runReviewerAgent` calls this
    // quarantine BEFORE its own runMigrations, so on a freshly-upgraded v34 DB the
    // column would be missing. Bring the schema current first (idempotent).
    runMigrations(dbHandle.db);
    const row = dbHandle.db
      .prepare("SELECT source_mode FROM runs WHERE run_id = ?")
      .get(opts.runId) as { source_mode: string } | undefined;
    // Fail-closed gate: not a db-first run → no-op (do NOT remove unrecoverable
    // files). The verdict's security comes from removal, which we only do when
    // the DB can recover the audit body.
    if (row === undefined || row.source_mode !== "db-first") {
      return { removed: [], ingested: [] };
    }
    // Ingest the DB-ingestable prior-output files BEFORE removal so the audit /
    // export artifact set is recoverable. Raw dotfile streams are not ingestable
    // and are remove-only (intentionally non-recoverable).
    const ingestable = quarantineFiles.filter((p) => isDbIngestableRelPath(p));
    if (ingestable.length > 0) {
      ingestRunArtifactPaths(dbHandle.db, runDir, opts.runId, ingestable);
      // #303: stamp the DURABLE prior-output rows as INTENTIONALLY quarantined so
      // the later db-first full sync (`ingestRunArtifacts`) preserves them — and
      // ONLY them — when their scratch file is absent. Gate-error sidecars
      // (`review-auto-error.json`) are deliberately EXCLUDED: they are transient
      // (removed on a successful retry, canonical record is in the event log), so
      // an absent gate-error row must be pruned, not re-materialized stale.
      markArtifactsQuarantined(
        dbHandle.db,
        opts.runId,
        ingestable.filter(isQuarantinePreservedPath),
      );
      ingested.push(...ingestable);
    }
    // Remove every prior-output entry (files + dirs) from disk WHILE STILL HOLDING
    // the DB maintenance lock, so a concurrent `db restore` cannot acquire the
    // exclusive lock between ingest and delete, restore a snapshot lacking the
    // just-ingested rows, and leave us deleting the only on-disk copy (TOCTOU).
    for (const abs of quarantineRoots) {
      rmSync(abs, { recursive: true, force: true });
    }
  } finally {
    dbHandle.close();
  }

  quarantineFiles.sort();
  ingested.sort();
  return { removed: quarantineFiles, ingested };
}
