import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import {
  recordImportError,
  clearImportError,
  type ImportCounters,
} from "./common.js";

/**
 * Import knowledge candidates (per-run `knowledge-candidates.yaml`) into
 * `knowledge_candidates`, and promoted entries (`docs/knowledge/**.md`)
 * into `knowledge_entries`.
 */
export function importKnowledge(
  db: Database.Database,
  runsDir: string,
  knowledgeDir: string,
  counters: ImportCounters,
): void {
  importCandidates(db, runsDir, counters);
  importEntries(db, knowledgeDir, counters);
}

/** Read repoId / projectId from a run's meta.json (best effort). */
function runAttribution(
  runDir: string,
): { repoId: string | null; projectId: string | null } {
  try {
    const meta = JSON.parse(
      readFileSync(join(runDir, "meta.json"), "utf8"),
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

function importCandidates(
  db: Database.Database,
  runsDir: string,
  counters: ImportCounters,
): void {
  if (!existsSync(runsDir)) return;
  // upsert content only — a `db-first` candidate's decision state (status /
  // decided_at / reviewer / reason) and `source_mode` are DB-canonical
  // (Phase 7-9) and must survive a re-import from the observation log.
  const upsert = db.prepare(
    `INSERT INTO knowledge_candidates (candidate_id, run_id, project_id, repo_id,
       domain, kind, title, body, status, created_at)
     VALUES (@candidate_id, @run_id, @project_id, @repo_id, @domain, @kind,
       @title, @body, 'candidate', @created_at)
     ON CONFLICT (candidate_id) DO UPDATE SET
       run_id = excluded.run_id, project_id = excluded.project_id,
       repo_id = excluded.repo_id, domain = excluded.domain,
       kind = excluded.kind, title = excluded.title, body = excluded.body,
       created_at = excluded.created_at`,
  );
  // candidate_id is keyed by list index, so a shortened candidates file
  // would leave stale high-index rows. Drop the run's rows that are no
  // longer present — but keep a `db-first` row, which is DB-canonical.
  const deleteStale = db.prepare(
    `DELETE FROM knowledge_candidates
     WHERE run_id = @run_id AND source_mode != 'db-first'
       AND candidate_id NOT IN (SELECT value FROM json_each(@keep))`,
  );
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsDir, entry.name);
    const path = join(runDir, "knowledge-candidates.yaml");
    if (!existsSync(path)) continue;
    let candidates: unknown[];
    try {
      const doc = parseYaml(readFileSync(path, "utf8")) as
        | { candidates?: unknown }
        | null;
      candidates = Array.isArray(doc?.candidates) ? doc.candidates : [];
    } catch (e) {
      recordImportError(db, counters, path, "knowledge", (e as Error).message);
      continue;
    }
    const attr = runAttribution(runDir);
    // mtime keeps re-imports of an unchanged file idempotent.
    const createdAt = new Date(statSync(path).mtimeMs).toISOString();
    const keepIds = candidates.map((_, i) => `${entry.name}:${i}`);
    const tx = db.transaction(() => {
      deleteStale.run({ run_id: entry.name, keep: JSON.stringify(keepIds) });
      candidates.forEach((c, i) => {
        const cand = c as Record<string, unknown>;
        upsert.run({
          candidate_id: `${entry.name}:${i}`,
          run_id: entry.name,
          project_id: attr.projectId,
          repo_id: attr.repoId,
          domain: typeof cand.domain === "string" ? cand.domain : null,
          kind: typeof cand.kind === "string" ? cand.kind : "unknown",
          title: typeof cand.title === "string" ? cand.title : null,
          body: typeof cand.content === "string" ? cand.content : null,
          created_at: createdAt,
        });
      });
    });
    tx();
    counters.knowledgeCandidates += candidates.length;
    clearImportError(db, path);
  }
}

/** Split a markdown file into (frontmatter object, body). */
function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: {}, body: text };
  const fmRaw = text.slice(4, end);
  const body = text.slice(end + 5);
  try {
    const fm = parseYaml(fmRaw) as unknown;
    return {
      frontmatter:
        fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {},
      body,
    };
  } catch {
    return { frontmatter: {}, body };
  }
}

function importEntries(
  db: Database.Database,
  knowledgeDir: string,
  counters: ImportCounters,
): void {
  if (!existsSync(knowledgeDir)) return;
  // a promoted knowledge entry's markdown body / frontmatter is file-backed
  // (Phase 7 canonical boundary — the `.md` is the artifact, editable by a
  // human). `knowledge_entries` is its read model: every `.md` is re-imported
  // so a hand edit (e.g. `deprecated: true`) is reflected.
  const upsert = db.prepare(
    `INSERT INTO knowledge_entries (entry_id, project_id, repo_id, domain, kind,
       path, title, body, frontmatter_json, created_at, source_candidate_id)
     VALUES (@entry_id, @project_id, @repo_id, @domain, @kind, @path, @title,
       @body, @frontmatter_json, @created_at, @source_candidate_id)
     ON CONFLICT (entry_id) DO UPDATE SET
       project_id = excluded.project_id, repo_id = excluded.repo_id,
       domain = excluded.domain, kind = excluded.kind, title = excluded.title,
       body = excluded.body, frontmatter_json = excluded.frontmatter_json,
       source_candidate_id = excluded.source_candidate_id,
       source_mode = 'legacy-file',
       export_status = 'synced', last_export_error = NULL`,
  );
  // docs/knowledge/<kind>/<file>.md
  for (const kindDir of readdirSync(knowledgeDir, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue;
    const kind = kindDir.name;
    const dir = join(knowledgeDir, kind);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const path = join(dir, file);
      const relPath = join("docs", "knowledge", kind, file);
      try {
        const { frontmatter, body } = splitFrontmatter(
          readFileSync(path, "utf8"),
        );
        const fm = frontmatter;
        upsert.run({
          entry_id: relPath,
          project_id: typeof fm.project_id === "string" ? fm.project_id : null,
          repo_id: typeof fm.repo_id === "string" ? fm.repo_id : null,
          domain: typeof fm.domain === "string" ? fm.domain : null,
          kind,
          path: relPath,
          title: typeof fm.title === "string" ? fm.title : file,
          body,
          frontmatter_json: JSON.stringify(fm),
          created_at:
            typeof fm.promoted_at === "string" ? fm.promoted_at : null,
          source_candidate_id:
            typeof fm.source_run === "string" &&
            typeof fm.source_index === "number"
              ? `${fm.source_run}:${fm.source_index}`
              : null,
        });
        clearImportError(db, path);
        counters.knowledgeEntries += 1;
      } catch (e) {
        recordImportError(db, counters, path, "knowledge", (e as Error).message);
      }
    }
  }
}
