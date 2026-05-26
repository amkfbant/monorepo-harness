import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { KnowledgeRepository } from "../db/repositories/knowledge.js";
import { atomicWriteFile } from "../db/atomic-write.js";
import { exportKnowledgeDecisions } from "../db/export-files.js";
import {
  KnowledgePromoteGateError,
  assertKnowledgeRunId,
  isCandidate,
  loadCandidates,
  contentHash,
  scanKindDir,
  kindDirOf,
  assertSafeKind,
  buildPromotedMarkdown,
  promotedFilename,
  splitFrontmatter,
  type KnowledgeCandidate,
  type PromoteResult,
  type PromotedFile,
  type SkipRecord,
  type RejectResult,
} from "./knowledge-promoter.js";

/**
 * Knowledge DB-first write path (Phase 7-9).
 *
 * `knowledge promote` / `reject` write the *decision state* to the DB as
 * the canonical record, then export the compatibility files: a rejected
 * candidate re-projects `knowledge-decisions.yaml`, a promoted candidate
 * writes its `docs/knowledge/<kind>/*.md`. The candidate content itself
 * stays file-derived — it is synced into `knowledge_candidates` from the
 * immutable per-run `knowledge-candidates.yaml` observation log.
 *
 * The DB write is canonical; the file export is best-effort. A failed
 * export leaves the decision committed, the row marked `failed`, and an
 * `exportWarnings` entry the CLI surfaces to stderr.
 */

export interface KnowledgeDbContext {
  runsDir: string;
  /** absolute `docs/knowledge` root that promoted md files live under */
  knowledgeDir: string;
  dbPath: string;
}

const DECISIONS_FILE = "knowledge-decisions.yaml";

/** candidate_id is `<runId>:<index>` — matching the Phase 6 importer. */
function candidateId(runId: string, index: number): string {
  return `${runId}:${index}`;
}

/** Read repoId / projectId from a run's meta.json (best effort). */
function runAttribution(
  runsDir: string,
  runId: string,
): { repoId: string | null; projectId: string | null } {
  try {
    const meta = JSON.parse(
      readFileSync(join(runsDir, runId, "meta.json"), "utf8"),
    ) as Record<string, unknown>;
    const project = meta.project as { projectId?: string } | undefined;
    return {
      repoId: typeof meta.repoId === "string" ? meta.repoId : null,
      projectId: project?.projectId ?? null,
    };
  } catch {
    return { repoId: null, projectId: null };
  }
}

/**
 * Sync a run's `knowledge-candidates.yaml` into `knowledge_candidates`
 * (content only — decisions are preserved) and migrate any legacy
 * `knowledge-decisions.yaml` rejection into the DB. Returns the raw
 * candidate list (index-aligned).
 */
async function syncRun(
  repo: KnowledgeRepository,
  ctx: KnowledgeDbContext,
  runId: string,
): Promise<unknown[]> {
  const candidates = await loadCandidates(ctx.runsDir, runId);
  const attr = runAttribution(ctx.runsDir, runId);
  // the observation-log mtime keeps `created_at` stable across re-syncs and
  // matches what `db import` records (no wall-clock drift).
  const candidatesPath = join(ctx.runsDir, runId, "knowledge-candidates.yaml");
  const createdAt = new Date(statSync(candidatesPath).mtimeMs).toISOString();
  candidates.forEach((raw, i) => {
    const c = raw as Record<string, unknown>;
    repo.syncCandidate({
      candidateId: candidateId(runId, i),
      runId,
      projectId: attr.projectId,
      repoId: attr.repoId,
      domain: typeof c.domain === "string" ? c.domain : null,
      kind: typeof c.kind === "string" ? c.kind : "unknown",
      title: typeof c.title === "string" ? c.title : null,
      body: typeof c.content === "string" ? c.content : null,
      createdAt,
    });
  });
  migrateLegacyRejections(repo, ctx, runId, candidates.length);
  return candidates;
}

/**
 * Seed the DB with rejections already recorded in a legacy
 * `knowledge-decisions.yaml`, so a DB-first command's re-projected
 * sidecar does not drop a pre-Phase-7 rejection. Only a candidate still
 * `candidate` in the DB is touched. A corrupt sidecar fails the command
 * rather than risk overwriting it with an incomplete projection.
 */
function migrateLegacyRejections(
  repo: KnowledgeRepository,
  ctx: KnowledgeDbContext,
  runId: string,
  candidateCount: number,
): void {
  const path = join(ctx.runsDir, runId, DECISIONS_FILE);
  if (!existsSync(path)) return;
  let decisions: Record<string, unknown>[];
  try {
    decisions = parseDecisions(readFileSync(path, "utf8"));
  } catch (e) {
    throw new KnowledgePromoteGateError(
      `failed to parse ${path}: ${(e as Error).message} — ` +
        `refusing to overwrite it with a partial projection`,
    );
  }
  for (const d of decisions) {
    if (
      d.decision !== "rejected" ||
      typeof d.index !== "number" ||
      d.index < 0 ||
      d.index >= candidateCount ||
      typeof d.reviewer !== "string"
    ) {
      continue;
    }
    const id = candidateId(runId, d.index);
    if (repo.getCandidate(id)?.status !== "candidate") continue;
    repo.setCandidateDecision({
      candidateId: id,
      decision: "rejected",
      reviewer: d.reviewer,
      reason: typeof d.reason === "string" ? d.reason : "",
      decidedAt: typeof d.decidedAt === "string" ? d.decidedAt : "",
    });
  }
}

/** Parse the `decisions:` array of a `knowledge-decisions.yaml` body. */
function parseDecisions(text: string): Record<string, unknown>[] {
  const parsed = parseYaml(text) as unknown;
  const list =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { decisions?: unknown }).decisions)
      ? (parsed as { decisions: unknown[] }).decisions
      : [];
  return list.filter(
    (d): d is Record<string, unknown> =>
      !!d && typeof d === "object" && !Array.isArray(d),
  );
}

/**
 * Re-project `knowledge-decisions.yaml` from the canonical DB decision
 * state. Returns a warning string when the file write failed (the DB
 * stays canonical), or undefined on success. The bulk `db export-files`
 * path shares the same `exportKnowledgeDecisions` exporter.
 */
function exportDecisionsSidecar(
  db: Database.Database,
  ctx: KnowledgeDbContext,
  runId: string,
): string | undefined {
  const r = exportKnowledgeDecisions(db, runId, { runsDir: ctx.runsDir });
  if (r.status === "failed") {
    return (
      `run ${runId}: the DB decision was recorded but exporting ` +
      `${DECISIONS_FILE} failed: ${r.error ?? "unknown error"}`
    );
  }
  return undefined;
}

/**
 * Reject a knowledge candidate. The decision is written to the DB
 * (canonical) and `knowledge-decisions.yaml` is re-projected from it.
 */
export async function rejectKnowledgeDbFirst(
  ctx: KnowledgeDbContext,
  opts: { runId: string; index: number; reviewer: string; reason: string; now?: Date },
): Promise<RejectResult> {
  assertKnowledgeRunId(opts.runId);
  if (opts.reviewer.trim() === "") {
    throw new KnowledgePromoteGateError("reviewer is required for reject");
  }
  if (opts.reason.trim() === "") {
    throw new KnowledgePromoteGateError("reason is required for reject");
  }
  const dbHandle = openManagedDb({ dbPath: ctx.dbPath });
  const db = dbHandle.db;
  const warnings: string[] = [];
  try {
    runMigrations(db);
    // Phase 9-11: refuse runtime writes while legacy-file rows linger.
    assertNoLegacyRuntimeRows(db);
    const repo = new KnowledgeRepository(db);
    const candidates = await syncRun(repo, ctx, opts.runId);
    if (
      !Number.isInteger(opts.index) ||
      opts.index < 0 ||
      opts.index >= candidates.length
    ) {
      throw new KnowledgePromoteGateError(
        `candidate index ${opts.index} is out of range ` +
          `(run has ${candidates.length} candidate entries)`,
      );
    }
    repo.setCandidateDecision({
      candidateId: candidateId(opts.runId, opts.index),
      decision: "rejected",
      reviewer: opts.reviewer,
      reason: opts.reason,
      decidedAt: (opts.now ?? new Date()).toISOString(),
    });
    const warning = exportDecisionsSidecar(db, ctx, opts.runId);
    if (warning !== undefined) warnings.push(warning);
  } finally {
    dbHandle.close();
  }
  return {
    runId: opts.runId,
    index: opts.index,
    reviewer: opts.reviewer,
    ...(warnings.length > 0 ? { exportWarnings: warnings } : {}),
  };
}

/**
 * Promote a run's knowledge candidates. Each eligible candidate's
 * `promoted` decision and `knowledge_entries` manifest are committed to
 * the DB, then the `docs/knowledge/<kind>/*.md` artifact is exported.
 * Idempotent: a candidate already promoted (its md exists) is skipped —
 * and if the DB does not yet record that promotion (a pre-Phase-7 md), it
 * is reconciled into the DB from the existing file.
 */
export async function promoteKnowledgeDbFirst(
  ctx: KnowledgeDbContext,
	  opts: {
	    runId: string;
	    reviewer: string;
	    index?: number;
	    kind?: string;
	    allowDuplicate?: boolean;
	    now?: Date;
	  },
): Promise<PromoteResult> {
  assertKnowledgeRunId(opts.runId);
  if (opts.reviewer.trim() === "") {
    throw new KnowledgePromoteGateError("reviewer is required for promote");
  }
  const promotedAt = (opts.now ?? new Date()).toISOString();
  const promoted: PromotedFile[] = [];
  const skipped: SkipRecord[] = [];
  const warnings: string[] = [];

  const dbHandle = openManagedDb({ dbPath: ctx.dbPath });
  const db = dbHandle.db;
  try {
    runMigrations(db);
    // Phase 9-11: refuse runtime writes while legacy-file rows linger.
    assertNoLegacyRuntimeRows(db);
	    const repo = new KnowledgeRepository(db);
	    const candidates = await syncRun(repo, ctx, opts.runId);
	    if (
	      opts.index !== undefined &&
	      (!Number.isInteger(opts.index) ||
	        opts.index < 0 ||
	        opts.index >= candidates.length)
	    ) {
	      throw new KnowledgePromoteGateError(
	        `candidate index ${opts.index} is out of range ` +
	          `(run has ${candidates.length} candidate entries)`,
	      );
	    }
	    const attr = runAttribution(ctx.runsDir, opts.runId);
	    const scanByKind = new Map<
	      string,
      Awaited<ReturnType<typeof scanKindDir>>
    >();

	    for (let i = 0; i < candidates.length; i++) {
	      if (opts.index !== undefined && i !== opts.index) {
	        skipped.push({ index: i, reason: "index-filter" });
	        continue;
	      }
	      const raw = candidates[i];
      if (!isCandidate(raw)) {
        skipped.push({ index: i, reason: "malformed" });
        continue;
      }
      const c: KnowledgeCandidate = raw;
      assertSafeKind(c.kind, i);
      if (opts.kind !== undefined && c.kind !== opts.kind) {
        skipped.push({ index: i, reason: "kind-filter" });
        continue;
      }
      const id = candidateId(opts.runId, i);
      const decided = repo.getCandidate(id);
      if (decided?.status === "rejected") {
        skipped.push({
          index: i,
          reason: "rejected",
          detail: `rejected by ${decided.reviewer ?? "?"}`,
        });
        continue;
      }
      const kindDir = kindDirOf(ctx.knowledgeDir, c.kind, i);
      let scan = scanByKind.get(c.kind);
      if (scan === undefined) {
        scan = await scanKindDir(kindDir);
        scanByKind.set(c.kind, scan);
      }
      if (scan.promotedKeys.has(`${opts.runId}#${i}`)) {
        skipped.push({ index: i, reason: "duplicate-index" });
        // an md exists but the DB does not record the promotion (a
        // pre-Phase-7 promotion) — reconcile the decision into the DB.
        if (decided?.status === "candidate") {
          reconcileFromExistingMd(repo, ctx, opts.runId, i, c, kindDir, attr);
        }
        continue;
      }
      const hash = contentHash(c);
      if (scan.hashes.has(hash) && opts.allowDuplicate !== true) {
        skipped.push({
          index: i,
          reason: "duplicate-hash",
          detail: `content hash ${hash} already promoted`,
        });
        continue;
      }

      const filename = promotedFilename(opts.runId, i, c.title);
      const relPath = join("docs", "knowledge", c.kind, filename);
      const rendered = buildPromotedMarkdown(c, {
        runId: opts.runId,
        index: i,
        reviewer: opts.reviewer,
        promotedAt,
        hash,
      });
      // DB first (canonical decision + read-model manifest), then write
      // the canonical `.md` artifact.
      db.transaction(() => {
        repo.setCandidateDecision({
          candidateId: id,
          decision: "promoted",
          reviewer: opts.reviewer,
          reason: null,
          decidedAt: promotedAt,
        });
        repo.upsertEntry({
          entryId: relPath,
          projectId: attr.projectId,
          repoId: attr.repoId,
          domain: c.domain,
          kind: c.kind,
          path: relPath,
          title: c.title,
          body: rendered.body,
          frontmatterJson: JSON.stringify(rendered.frontmatter),
          createdAt: promotedAt,
          sourceCandidateId: id,
        });
      })();
      // the `.md` is the canonical artifact (file-backed body) — promote
      // writes it directly. A write failure leaves the candidate decision
      // committed; the candidate is marked `failed` and a re-run recovers.
      try {
        atomicWriteFile(join(kindDir, filename), rendered.markdown);
        repo.markCandidateExported(id);
      } catch (e) {
        const error = (e as Error).message;
        repo.markCandidateExportFailed(id, error);
        warnings.push(
          `candidate ${id}: the decision was recorded but writing ${relPath} ` +
            `failed: ${error}`,
        );
      }
      // keep the in-memory scan current so two identical candidates in
      // the same run don't both promote.
      scan.hashes.add(hash);
      scan.promotedKeys.add(`${opts.runId}#${i}`);
      promoted.push({
        kind: c.kind,
        title: c.title,
        path: join(kindDir, filename),
        index: i,
        domain: c.domain,
        hash,
      });
    }
  } finally {
    dbHandle.close();
  }
  return {
    runId: opts.runId,
    promoted,
    skipped,
    ...(warnings.length > 0 ? { exportWarnings: warnings } : {}),
  };
}

/**
 * Reconcile a pre-Phase-7 promotion into the DB: the md file exists but
 * `knowledge_candidates` still says `candidate`. The decision and entry
 * manifest are taken from the existing file's frontmatter so the DB
 * matches what is already on disk (no file is written).
 */
function reconcileFromExistingMd(
  repo: KnowledgeRepository,
  ctx: KnowledgeDbContext,
  runId: string,
  index: number,
  c: KnowledgeCandidate,
  kindDir: string,
  attr: { repoId: string | null; projectId: string | null },
): void {
  const filename = promotedFilename(runId, index, c.title);
  const path = join(kindDir, filename);
  if (!existsSync(path)) return; // title drifted — leave the DB untouched
  const { frontmatter, body } = splitFrontmatter(readFileSync(path, "utf8"));
  const fm = frontmatter ?? {};
  const id = candidateId(runId, index);
  const reviewer =
    typeof fm.promoted_by === "string" ? fm.promoted_by : "(unknown)";
  const decidedAt =
    typeof fm.promoted_at === "string" ? fm.promoted_at : "";
  const relPath = join("docs", "knowledge", c.kind, filename);
  repo.setCandidateDecision({
    candidateId: id,
    decision: "promoted",
    reviewer,
    reason: null,
    decidedAt,
  });
  repo.upsertEntry({
    entryId: relPath,
    projectId: attr.projectId,
    repoId: attr.repoId,
    domain: c.domain,
    kind: c.kind,
    path: relPath,
    title: c.title,
    body,
    frontmatterJson: JSON.stringify(fm),
    createdAt: decidedAt === "" ? null : decidedAt,
    sourceCandidateId: id,
  });
}
