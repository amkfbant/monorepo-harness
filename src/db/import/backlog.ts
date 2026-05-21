import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import {
  recordImportError,
  clearImportError,
  type ImportCounters,
} from "./common.js";

const STATUS_DIRS = ["open", "doing", "done", "deferred"];

/**
 * Import `backlog/{open,doing,done,deferred}/*.yaml` into `backlog_items`
 * and `backlog_run_links`. The directory is authoritative for status
 * (matching `core/backlog.ts`). A malformed item file is recorded in
 * `import_errors` and skipped.
 */
export function importBacklog(
  db: Database.Database,
  backlogDir: string,
  counters: ImportCounters,
): void {
  if (!existsSync(backlogDir)) return;

  const upsertItem = db.prepare(
    `INSERT INTO backlog_items (item_id, project_id, repo_id, domain, title,
       goal, status, priority, tags_json, created_at, updated_at)
     VALUES (@item_id, @project_id, @repo_id, @domain, @title, @goal, @status,
       @priority, @tags_json, @created_at, @updated_at)
     ON CONFLICT (item_id) DO UPDATE SET
       project_id = excluded.project_id, repo_id = excluded.repo_id,
       domain = excluded.domain, title = excluded.title, goal = excluded.goal,
       status = excluded.status, priority = excluded.priority,
       tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
  );
  const deleteLinks = db.prepare(
    "DELETE FROM backlog_run_links WHERE item_id = ?",
  );
  // a backlog item has no repo of its own — it is derived from the item's
  // project (importProjects runs first in runFullImport), so that
  // `backlog list --repo-id` resolves.
  const projectRepoId = db.prepare(
    "SELECT repo_id FROM projects WHERE project_id = ?",
  );
  const insertLink = db.prepare(
    `INSERT INTO backlog_run_links (item_id, run_id, linked_at)
     VALUES (?, ?, ?)
     ON CONFLICT (item_id, run_id) DO NOTHING`,
  );

  for (const status of STATUS_DIRS) {
    const dir = join(backlogDir, status);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const path = join(dir, file);
      let doc: Record<string, unknown>;
      try {
        const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object") {
          throw new Error("backlog item is not an object");
        }
        doc = parsed as Record<string, unknown>;
      } catch (e) {
        recordImportError(db, counters, path, "backlog", (e as Error).message);
        continue;
      }
      const id = typeof doc.id === "string" ? doc.id : null;
      if (id === null) {
        recordImportError(db, counters, path, "backlog", "missing item id");
        continue;
      }
      // the source file's mtime keeps re-imports of an unchanged item
      // idempotent (no wall-clock time enters the row).
      const mtime = new Date(statSync(path).mtimeMs).toISOString();
      const tags = Array.isArray(doc.tags)
        ? doc.tags.filter((t): t is string => typeof t === "string")
        : [];
      const links = Array.isArray(doc.linkedRuns)
        ? doc.linkedRuns.filter((r): r is string => typeof r === "string")
        : [];
      const projectId =
        typeof doc.projectId === "string" ? doc.projectId : null;
      const repoIdRow =
        projectId !== null
          ? (projectRepoId.get(projectId) as { repo_id: string } | undefined)
          : undefined;
      const tx = db.transaction(() => {
        upsertItem.run({
          item_id: id,
          project_id: projectId,
          repo_id: repoIdRow?.repo_id ?? null,
          domain: typeof doc.domain === "string" ? doc.domain : "(unknown)",
          title: typeof doc.title === "string" ? doc.title : "(untitled)",
          goal: typeof doc.goal === "string" ? doc.goal : "",
          // the directory is authoritative for status
          status,
          priority:
            typeof doc.priority === "string" ? doc.priority : "medium",
          tags_json: JSON.stringify(tags),
          created_at:
            typeof doc.createdAt === "string" ? doc.createdAt : mtime,
          updated_at: mtime,
        });
        deleteLinks.run(id);
        for (const runId of links) insertLink.run(id, runId, mtime);
      });
      tx();
      clearImportError(db, path);
      counters.backlogItems += 1;
    }
  }
}
