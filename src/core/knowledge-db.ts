import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { openDb } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { KnowledgeRepository } from "../db/repositories/knowledge.js";
import { atomicWriteFile } from "../db/atomic-write.js";
import {
  describeExportedFile,
  recordExportSuccess,
} from "../db/export-records.js";
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
 * immutable per-run `knowledge-candidates.yaml` observation log, and any
 * decision already present in a legacy sidecar is migrated into the DB so
 * the re-projected sidecar never drops a prior rejection.
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
 * `knowledge-decisions.yaml` rejection into the DB for a candidate still
 * undecided there. Returns the raw candidate list (index-aligned).
 */
async function syncRun(
  repo: KnowledgeRepository,
  ctx: KnowledgeDbContext,
  runId: string,
): Promise<unknown[]> {
  const candidates = await loadCandidates(ctx.runsDir, runId);
  const attr = runAttribution(ctx.runsDir, runId);
  const createdAt = new Date().toISOString();
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
 * `candidate` in the DB is touched (a `db-first` decision always wins).
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
  } catch {
    return;
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
 * Write `knowledge-decisions.yaml` from the DB's rejected candidates for
 * a run — the file is a pure projection of the canonical decision state.
 */
function exportDecisionsSidecar(
  db: Database.Database,
  ctx: KnowledgeDbContext,
  runId: string,
): void {
  const rows = db
    .prepare(
      `SELECT candidate_id, reviewer, reason, decided_at
       FROM knowledge_candidates
       WHERE run_id = ? AND status = 'rejected'
       ORDER BY candidate_id`,
    )
    .all(runId) as {
    candidate_id: string;
    reviewer: string | null;
    reason: string | null;
    decided_at: string | null;
  }[];
  const entries = rows
    .map((r) => ({
      index: indexOfCandidate(r.candidate_id),
      decision: "rejected",
      reviewer: r.reviewer ?? "",
      reason: r.reason ?? "",
      decidedAt: r.decided_at ?? "",
    }))
    .sort((a, b) => a.index - b.index);
  const body =
    "decisions:\n" +
    entries
      .map((d) =>
        Object.entries(d)
          .map(
            ([k, v], idx) =>
              `${idx === 0 ? "  - " : "    "}${k}: ${JSON.stringify(v)}`,
          )
          .join("\n"),
      )
      .join("\n") +
    "\n";
  atomicWriteFile(join(ctx.runsDir, runId, DECISIONS_FILE), body);
  for (const r of rows) {
    new KnowledgeRepository(db).markCandidateExported(r.candidate_id);
  }
}

/** The candidate's list index, parsed from a `<runId>:<index>` id. */
function indexOfCandidate(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(":") + 1));
  return Number.isInteger(n) && n >= 0 ? n : 0;
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
  const db = openDb(ctx.dbPath);
  try {
    runMigrations(db);
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
    exportDecisionsSidecar(db, ctx, opts.runId);
  } finally {
    db.close();
  }
  return { runId: opts.runId, index: opts.index, reviewer: opts.reviewer };
}

/**
 * Promote a run's knowledge candidates. Each eligible candidate's
 * `promoted` decision and `knowledge_entries` manifest are committed to
 * the DB, then the `docs/knowledge/<kind>/*.md` artifact is exported.
 * Idempotent: a candidate already promoted (its md exists) is skipped.
 */
export async function promoteKnowledgeDbFirst(
  ctx: KnowledgeDbContext,
  opts: {
    runId: string;
    reviewer: string;
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

  const db = openDb(ctx.dbPath);
  try {
    runMigrations(db);
    const repo = new KnowledgeRepository(db);
    const candidates = await syncRun(repo, ctx, opts.runId);
    const attr = runAttribution(ctx.runsDir, opts.runId);
    // per-kind scans of the existing md files, lazily seeded.
    const scanByKind = new Map<
      string,
      Awaited<ReturnType<typeof scanKindDir>>
    >();

    for (let i = 0; i < candidates.length; i++) {
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
      const md = buildPromotedMarkdown(c, {
        runId: opts.runId,
        index: i,
        reviewer: opts.reviewer,
        promotedAt,
        hash,
      });
      // DB first (canonical decision + manifest), then export the md.
      const { dbRevision } = db.transaction((): { dbRevision: number } => {
        repo.setCandidateDecision({
          candidateId: id,
          decision: "promoted",
          reviewer: opts.reviewer,
          reason: null,
          decidedAt: promotedAt,
        });
        return repo.upsertEntry({
          entryId: relPath,
          projectId: attr.projectId,
          repoId: attr.repoId,
          domain: c.domain,
          kind: c.kind,
          path: relPath,
          title: c.title,
          body: md,
          frontmatterJson: JSON.stringify({
            kind: c.kind,
            domain: c.domain,
            title: c.title,
            source_run: opts.runId,
            source_index: i,
            confidence: c.confidence,
            promoted_by: opts.reviewer,
            promoted_at: promotedAt,
            hash,
          }),
          createdAt: promotedAt,
          sourceCandidateId: id,
        });
      })();
      atomicWriteFile(join(kindDir, filename), md);
      recordExportSuccess(db, {
        scopeType: "knowledge_entry",
        scopeId: relPath,
        dbRevision,
        startedAt: promotedAt,
        files: [describeExportedFile(relPath, md)],
      });
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
    db.close();
  }
  return { runId: opts.runId, promoted, skipped };
}
