import { existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openDbReadonly } from "../../db/connection.js";
import { openManagedDb } from "../../db/managed-connection.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, permissionDenied } from "../schemas/outputs.js";
import type { McpConfig } from "../security/config.js";
import type { McpToolContext } from "../registry/tool-registry.js";

export interface McpDbScope {
  db: Database.Database;
  dbPath: string;
}

export function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as
      | { offset?: unknown }
      | unknown;
    const offset =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { offset?: unknown }).offset
        : undefined;
    return typeof offset === "number" && Number.isInteger(offset) && offset >= 0
      ? offset
      : 0;
  } catch {
    return 0;
  }
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function normalizeLimit(limit: number | undefined, fallback = 20): number {
  return Math.max(1, Math.min(100, limit ?? fallback));
}

export function withReadonlyDb<T>(
  context: McpToolContext,
  read: (scope: McpDbScope) => T,
): HarnessMcpToolResult | T {
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    return errorResult("harness DB is not initialized", {
      dbPath: paths.dbPath,
    });
  }
  const handle = openManagedDb({
    dbPath: paths.dbPath,
    lockPath: paths.dbLockPath,
    readonly: true,
    timeoutMs: 250,
  });
  try {
    return read({ db: handle.db, dbPath: paths.dbPath });
  } finally {
    handle.close();
  }
}

export function withArchiveFallback<T>(
  db: Database.Database,
  readMain: (db: Database.Database) => T | null,
  readArchive: (db: Database.Database) => T | null,
): T | null {
  const main = readMain(db);
  if (main !== null) return main;
  for (const archivePath of attachedArchivePaths(db)) {
    const archiveDb = openDbReadonly(archivePath);
    try {
      const archived = readArchive(archiveDb);
      if (archived !== null) return archived;
    } finally {
      archiveDb.close();
    }
  }
  return null;
}

export function attachedArchivePaths(db: Database.Database): string[] {
  if (!tableExists(db, "archive_catalog")) return [];
  const rows = db
    .prepare(
      `SELECT path FROM archive_catalog
        WHERE status = 'attached'
        ORDER BY created_at DESC`,
    )
    .all() as { path: string }[];
  return rows.map((r) => r.path).filter((p) => existsSync(p));
}

export function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

export function parseJson<T = unknown>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function ensureProjectVisible(
  config: McpConfig,
  projectId: string | null | undefined,
): HarnessMcpToolResult | null {
  if (config.allowedProjects.length === 0) return null;
  if (projectId !== null && projectId !== undefined && config.allowedProjects.includes(projectId)) {
    return null;
  }
  return permissionDenied("MCP permission denied: project_not_allowed", {
    reason: "project_not_allowed",
    projectId: projectId ?? null,
  });
}

/** Cap `text` to `maxBytes` UTF-8 bytes, reporting the original size. */
export function cappedText(
  text: string,
  maxBytes: number,
): { text: string; bytes: number; capped: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, bytes, capped: false };
  return {
    text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
    bytes,
    capped: true,
  };
}

export function artifactIdToUri(artifactId: string): string {
  return `harness://artifact/${Buffer.from(artifactId, "utf8").toString("base64url")}`;
}

export function artifactIdFromUriSegment(segment: string): string | null {
  try {
    return Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return null;
  }
}
