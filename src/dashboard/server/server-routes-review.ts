// dashboard read API routes（後半: review/artifacts/reviewers/root/db/locks/snapshot）。

import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { openManagedDb } from "../../db/managed-connection.js";
import { SCHEMA_VERSION } from "../../db/schema.js";
import { loadDashboardSnapshot, DashboardSnapshotError, type DashboardFilters } from "../snapshot.js";

import { ReviewProposalRepository } from "../../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../../db/repositories/review-consensus.js";
import { ReviewerRepository } from "../../db/repositories/reviewers.js";
import { readArtifactBlob } from "../../db/artifact-blobs.js";
import { findBlobStore, findExternalBlob } from "../../db/blob-stores.js";

import { LocalBlobStore } from "../../storage/local-blob-store.js";
import { listActiveDomainLocks } from "../../workspace/db-domain-lock.js";
import { checkConsistency } from "../../db/consistency.js";
import { dbStats } from "../../db/maintenance.js";
import { renderDashboardHtml } from "../render.js";

import type { Route } from "./server-types.js";
import { validRunId, writeError, writeJson } from "./server-routing.js";

/**
 * Dashboard read-only HTTP server (Phase 12-1 skeleton).
 *
 * Single-file router; Node built-in http. Routes are matched by exact
 * path or `/api/runs/:runId/timeline`-style placeholders. Phase 12 only
 * accepts GET / HEAD; everything else is 405.
 *
 * Subsequent sub-phases (12-2 .. 12-7) extend the route list. The
 * skeleton intentionally keeps a single `routes` table — no framework,
 * no plugin system.
 */

export function reviewRoutes(): Route[] {

  return [
    {
      method: "GET",
      pattern: "/api/review/proposals",
      handler: ({ ctx, res, query }) => {
        const runId = query.get("runId");
        if (runId === null) {
          writeError(res, 400, "bad_request", "runId query is required");
          return;
        }
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const proposals = new ReviewProposalRepository(handle.db).listForRun(
            runId,
            { includeArchived: query.get("includeArchived") === "1" },
          );
          writeJson(res, 200, { runId, proposals });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/review/consensus",
      handler: ({ ctx, res, query }) => {
        const runId = query.get("runId");
        if (runId === null) {
          writeError(res, 400, "bad_request", "runId query is required");
          return;
        }
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const active = new ReviewConsensusRepository(handle.db).findActive(
            runId,
          );
          writeJson(res, 200, { runId, consensus: active });
        } finally {
          handle.close();
        }
      },
    },
    // Phase 12 post-close fix (external review P1-1): `artifact_id` is
    // a TEXT id of the form `<runId>:<relativePath>` (see
    // `src/db/run-artifacts.ts`). The previous handler validated it as a
    // positive integer and the SELECT read a non-existent `byte_size`
    // column (the real column is `bytes`). Both endpoints were broken.
    // The path segment is base64url-encoded so a `:` or `/` in the id
    // does not collide with the URL grammar.
    {
      method: "GET",
      pattern: "/api/artifacts/:artifactIdB64",
      handler: ({ ctx, res, params }) => {
        const id = decodeBase64UrlArtifactId(params.artifactIdB64!);
        if (id === null) {
          writeError(
            res,
            400,
            "bad_request",
            "artifactId must be base64url-encoded (e.g. base64url('run-XYZ:summary.md'))",
          );
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const row = handle.db
            .prepare(
              `SELECT artifact_id, run_id, relative_path, content_type,
                      bytes, sha256, blob_sha256, storage,
                      secret_suspect, original_bytes, original_sha256,
                      body_status
                 FROM artifacts
                WHERE artifact_id = ?`,
            )
            .get(id) as Record<string, unknown> | undefined;
          if (row === undefined) {
            writeError(res, 404, "not_found", `artifact ${id} not found`);
            return;
          }
          writeJson(res, 200, row);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/artifacts/:artifactIdB64/body",
      handler: async ({ ctx, res, params }) => {
        const id = decodeBase64UrlArtifactId(params.artifactIdB64!);
        if (id === null) {
          writeError(
            res,
            400,
            "bad_request",
            "artifactId must be base64url-encoded (e.g. base64url('run-XYZ:summary.md'))",
          );
          return;
        }
        if (ctx.config.artifactBodyDisabled === true) {
          writeError(
            res,
            403,
            "forbidden",
            "artifact body serving is disabled (--no-artifact-body)",
          );
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const row = handle.db
            .prepare(
              `SELECT blob_sha256, bytes, content_type, secret_suspect,
                      relative_path, storage
                 FROM artifacts WHERE artifact_id = ?`,
            )
            .get(id) as
            | {
                blob_sha256: string | null;
                bytes: number | null;
                content_type: string | null;
                secret_suspect: number | null;
                relative_path: string;
                storage: string;
              }
            | undefined;
          if (row === undefined || row.blob_sha256 === null) {
            writeError(
              res,
              404,
              "not_found",
              `artifact ${id} has no DB-stored body`,
            );
            return;
          }
          const max =
            ctx.config.maxInlineArtifactBytes ?? 1024 * 1024;
          const tooLarge =
            row.bytes !== null && row.bytes > max;
          let buf: Buffer | null;
          try {
            buf = await readArtifactBody(handle.db, {
              blobSha256: row.blob_sha256,
              storage: row.storage,
            });
          } catch (e) {
            writeError(
              res,
              409,
              "blob_integrity_error",
              (e as Error).message,
            );
            return;
          }
          if (buf === null) {
            writeError(
              res,
              404,
              "not_found",
              `artifact blob ${row.blob_sha256} missing`,
            );
            return;
          }
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            row.content_type ?? "application/octet-stream",
          );
          res.setHeader("X-Content-Type-Options", "nosniff");
          if (row.secret_suspect === 1) {
            res.setHeader("X-Harness-Secret-Suspect", "1");
          }
          if (tooLarge) {
            // download-style: encourage client to save rather than render
            const filename = row.relative_path.split("/").pop() ?? "artifact";
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
            );
          }
          res.setHeader("Content-Length", buf.length.toString());
          res.end(buf);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/review/reviewers",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const reviewers = new ReviewerRepository(handle.db).list();
          writeJson(res, 200, { reviewers });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/",
      handler: ({ ctx, res }) => {
        // Phase 12-6: serve the same read-only HTML the static export
        // writes, but with a live snapshot.
        try {
          const snapshot = loadDashboardSnapshot({
            harnessRoot: dirname(dirname(ctx.config.dbPath)),
            autoImport: false,
          });
          const html = renderDashboardHtml(snapshot);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "no-store");
          res.end(html);
        } catch (e) {
          if (e instanceof DashboardSnapshotError) {
            writeError(res, 404, "not_found", e.message);
            return;
          }
          throw e;
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/db/status",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const ver = handle.db
            .prepare("SELECT MAX(version) AS v FROM schema_migrations")
            .get() as { v: number | null };
          const runs = handle.db
            .prepare("SELECT count(*) AS n FROM runs")
            .get() as { n: number };
          writeJson(res, 200, {
            dbPath: ctx.config.dbPath,
            schemaVersion: ver.v,
            schemaVersionExpected: SCHEMA_VERSION,
            runs: runs.n,
            generatedAt: new Date().toISOString(),
          });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/db/stats",
      handler: ({ ctx, res }) => {
        // Phase 12 post-close P1: hold the shared maintenance lock for
        // the lifetime of dbStats so a concurrent `db restore` cannot
        // swap the DB out mid-stats. dbStats() opens its own raw
        // readonly connection internally; while *this* managed handle
        // is alive, the maintenance lock is held shared so
        // db restore (exclusive) waits.
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const stats = dbStats(ctx.config.dbPath);
          writeJson(res, 200, stats);
        } catch (e) {
          writeError(
            res,
            500,
            "internal_error",
            (e as Error).message ?? "dbStats failed",
          );
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/db/consistency",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const report = checkConsistency({
            db: handle.db,
            harnessRoot: dirname(dirname(ctx.config.dbPath)),
          });
          writeJson(res, 200, report);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/locks",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const locks = listActiveDomainLocks(handle.db);
          writeJson(res, 200, { locks });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/snapshot",
      handler: ({ ctx, res, query }) => {
        // Phase 12-2: DashboardSnapshot live from the DB. The server
        // never auto-imports (autoImport: false enforces read-only).
        // Phase 12 minimum filters: project / repo are the only fields
        // supported by DashboardFilters at this point. domain / status /
        // since / until query params are accepted but silently ignored
        // (forward-compatible for Phase 14+ wiring).
        const filters: DashboardFilters = {};
        const proj = query.get("project");
        const repo = query.get("repo");
        if (proj !== null) filters.projectId = proj;
        if (repo !== null) filters.repoId = repo;

        try {
          const snapshot = loadDashboardSnapshot({
            harnessRoot: dirname(dirname(ctx.config.dbPath)),
            filters,
            autoImport: false,
          });
          writeJson(res, 200, snapshot);
        } catch (e) {
          if (e instanceof DashboardSnapshotError) {
            writeError(res, 404, "not_found", e.message);
            return;
          }
          throw e;
        }
      },
    },
  ];
}

/**
 * Phase 12 post-close fix (external review P1-1): decode the base64url
 * URL segment back to the canonical `<runId>:<relativePath>` artifact id.
 * Returns null if the segment is empty / not a string. Loose-form
 * `+`/`/`/`=` are also tolerated so curl users who don't strictly use
 * base64url still work.
 */
function decodeBase64UrlArtifactId(seg: string): string | null {
  if (typeof seg !== "string" || seg.length === 0) return null;
  // accept base64 too — replace url-safe chars and add padding.
  const padded = seg
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(seg.length / 4) * 4, "=");
  try {
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    // canonical artifact ids contain ':'; reject obvious junk so a
    // mistyped numeric id does not silently match nothing.
    if (decoded.length === 0) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function readArtifactBody(
  db: Database.Database,
  input: { blobSha256: string; storage: string },
): Promise<Buffer | null> {
  if (input.storage === "db") {
    return readArtifactBlob(db, input.blobSha256);
  }
  if (input.storage !== "external") return null;
  const external = findExternalBlob(db, input.blobSha256);
  if (external === null || external.status !== "available") return null;
  const storeRow = findBlobStore(db, external.storeId);
  if (storeRow === null || storeRow.storeType !== "local") return null;
  const config = JSON.parse(storeRow.configJson) as { root?: unknown };
  if (typeof config.root !== "string") return null;
  return new LocalBlobStore({ root: config.root }).get({
    sha256: external.sha256,
    uri: external.uri,
  });
}
