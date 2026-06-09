import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { splitFrontmatter } from "./knowledge-promoter.js";
import { getCurrentKnowledgeRevision } from "../db/repositories/knowledge-entry-revisions.js";
import {
  listOperationalKnowledge,
  importOperationalEntry,
  operationalEntryIdForKey,
  OperationalKnowledgeError,
} from "./operational-knowledge.js";

/**
 * Operational-knowledge file export/import (issue #57 — file-export parity).
 *
 * Operational entries are DB-canonical (no file); this is the COMPAT round-trip
 * that mirrors codebase knowledge's `docs/knowledge/` but under a SEPARATE
 * `docs/ops-knowledge/<kind>/<key>.md` namespace so it never collides with the
 * codebase-knowledge importer (which scans `docs/knowledge/` only, keyed by the
 * file path; operational entries keep the `ops/<key>` entry-id namespace).
 */

const ENTRY_PREFIX = "ops/";

export interface ExportOperationalResult {
  written: string[];
}

/** Export every operational entry (incl. deprecated) to `<outDir>/<kind>/<key>.md`. */
export async function exportOperationalKnowledge(
  db: Database.Database,
  outDir: string,
): Promise<ExportOperationalResult> {
  const entries = listOperationalKnowledge(db, { includeDeprecated: true });
  const root = resolve(outDir);
  const written: string[] = [];
  for (const e of entries) {
    const rev = getCurrentKnowledgeRevision(db, e.entryId);
    if (rev === null) continue;
    const key = e.entryId.slice(ENTRY_PREFIX.length);
    const path = join(outDir, e.kind, `${key}.md`);
    // Defense in depth: `kind`/`key` are slug-validated on write/import, but
    // never let a path escape outDir.
    const abs = resolve(path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new OperationalKnowledgeError(
        `operational export path escapes outDir: ${path}`,
      );
    }
    await mkdir(dirname(path), { recursive: true });
    // write the stored revision markdown byte-for-byte (idempotent round-trip).
    await writeFile(path, rev.bodyMarkdown, "utf8");
    written.push(path);
  }
  // Prune stale `.md` files no longer backed by an entry (e.g. an entry whose
  // `kind` changed leaves a `<old-kind>/<key>.md` orphan). Without this, an
  // export→import round-trip after a kind change would re-import BOTH copies
  // under the same key — a non-deterministic "current" pick. The export dir is a
  // harness-owned compat mirror, so removing non-current `.md` is safe.
  const keep = new Set(written.map((p) => resolve(p)));
  for (const orphan of await listMarkdownFiles(outDir)) {
    if (!keep.has(resolve(orphan))) await rm(orphan);
  }
  written.sort();
  return { written };
}

/** Every `*.md` directly under a kind subdir of `dir` (the export layout). */
async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const kindDir of await readdir(dir, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue;
    const sub = join(dir, kindDir.name);
    for (const f of (await readdir(sub)).filter((x) => x.endsWith(".md"))) {
      out.push(join(sub, f));
    }
  }
  return out;
}

export interface ImportOperationalResult {
  imported: number;
  skipped: { file: string; reason: string }[];
}

/** Import `<inDir>/<kind>/<key>.md` back into the DB (idempotent round-trip). */
export async function importOperationalKnowledge(
  db: Database.Database,
  inDir: string,
  opts: { actor?: string } = {},
): Promise<ImportOperationalResult> {
  const actor = opts.actor ?? "db-import";
  const skipped: { file: string; reason: string }[] = [];
  let imported = 0;
  if (!existsSync(inDir)) return { imported, skipped };
  for (const kindDir of await readdir(inDir, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue;
    const dir = join(inDir, kindDir.name);
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".md"))) {
      const rel = join(kindDir.name, f);
      const key = f.slice(0, -3); // basename without `.md` — the `ops/<key>` key
      let entryId: string;
      try {
        entryId = operationalEntryIdForKey(key);
      } catch (e) {
        skipped.push({
          file: rel,
          reason: e instanceof OperationalKnowledgeError ? e.message : "invalid key",
        });
        continue;
      }
      const raw = await readFile(join(dir, f), "utf8");
      const { frontmatter } = splitFrontmatter(raw);
      if (frontmatter === null) {
        // no / malformed / non-object YAML frontmatter — report, don't import a
        // default-kind entry from an operator's YAML mistake.
        skipped.push({ file: rel, reason: "no or malformed frontmatter" });
        continue;
      }
      try {
        importOperationalEntry(db, {
          entryId,
          rawMarkdown: raw,
          frontmatter,
          actor,
        });
        imported += 1;
      } catch (e) {
        // a malformed entry (e.g. an untrusted `kind` that is not a slug) is
        // skipped, not fatal — the rest of the dir still imports.
        skipped.push({
          file: rel,
          reason: e instanceof OperationalKnowledgeError ? e.message : "import failed",
        });
      }
    }
  }
  return { imported, skipped };
}
