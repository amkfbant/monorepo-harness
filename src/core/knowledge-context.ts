import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { splitFrontmatter } from "./knowledge-promoter.js";
import { listCurrentKnowledgeRevisions } from "../db/repositories/knowledge-entry-revisions.js";

export class KnowledgeContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeContextError";
  }
}

const DOMAIN_RE = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$/;

/**
 * Map a domain to a single safe filename segment. A short content hash
 * keeps it injective — `apps/user-api` and `apps/user/api` both flatten
 * to `apps-user-api` but get distinct hashes, so build-context can never
 * overwrite a different domain's context file.
 */
export function domainSlug(domain: string): string {
  const flat = domain.replace(/\//g, "-");
  const hash = createHash("sha256").update(domain).digest("hex").slice(0, 8);
  return `${flat}-${hash}`;
}

/** true if a frontmatter `deprecated` value (bool or hand-edited string) is set. */
function isDeprecated(value: unknown): boolean {
  if (value === true) return true;
  return (
    typeof value === "string" && value.trim().toLowerCase() === "true"
  );
}

export interface KnowledgeContextEntry {
  file: string; // path relative to knowledgeDir
  kind: string;
  title: string;
  confidence: string;
  content: string;
}

export interface BuildKnowledgeContextOpts {
  /** <harnessRoot>/docs/knowledge */
  knowledgeDir: string;
  /** <harnessRoot>/docs/knowledge-context */
  outDir: string;
  domain: string;
  now?: Date;
}

export interface BuildKnowledgeContextResult {
  domain: string;
  outPath: string;
  entries: KnowledgeContextEntry[];
  knowledgeRevisionIds?: number[];
}

/**
 * Aggregate every PROMOTED knowledge md whose frontmatter `domain` matches
 * (and that is not `deprecated`) into a single context file
 * `<outDir>/<domain-slug>.md`.
 *
 * Only `docs/knowledge/` is scanned — candidate (knowledge-candidates.yaml)
 * and rejected (knowledge-decisions.yaml) entries live under runs/ and are
 * never reached, so they cannot leak into a run's context.
 */
export async function buildKnowledgeContext(
  opts: BuildKnowledgeContextOpts,
): Promise<BuildKnowledgeContextResult> {
  if (!DOMAIN_RE.test(opts.domain)) {
    throw new KnowledgeContextError(
      `invalid domain: ${JSON.stringify(opts.domain)}`,
    );
  }
  const entries: KnowledgeContextEntry[] = [];

  if (existsSync(opts.knowledgeDir)) {
    let kindDirs: string[];
    try {
      kindDirs = await readdir(opts.knowledgeDir);
    } catch {
      kindDirs = [];
    }
    for (const kind of kindDirs) {
      const kindDir = join(opts.knowledgeDir, kind);
      let files: string[];
      try {
        files = await readdir(kindDir);
      } catch {
        continue; // not a directory
      }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        let text: string;
        try {
          text = await readFile(join(kindDir, f), "utf8");
        } catch {
          continue;
        }
        const { frontmatter: fm, body } = splitFrontmatter(text);
        if (!fm) continue;
        if (fm.domain !== opts.domain) continue;
        if (isDeprecated(fm.deprecated)) continue;
        entries.push({
          file: `${kind}/${f}`,
          kind: typeof fm.kind === "string" ? fm.kind : kind,
          title: typeof fm.title === "string" ? fm.title : f,
          confidence:
            typeof fm.confidence === "string" ? fm.confidence : "unknown",
          content: body.trim(),
        });
      }
    }
  }
  // stable order so the context file is reproducible
  entries.sort((a, b) => a.file.localeCompare(b.file));

  const generatedAt = (opts.now ?? new Date()).toISOString();
  const outPath = join(opts.outDir, `${domainSlug(opts.domain)}.md`);
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(outPath, renderContext(opts.domain, generatedAt, entries));

  return { domain: opts.domain, outPath, entries };
}

export interface BuildKnowledgeContextFromDbOpts {
  db: Database.Database;
  outDir: string;
  domain: string;
  projectId?: string;
  repoId?: string;
  now?: Date;
}

/**
 * Phase 17 DB-first knowledge context. Current DB revisions are the source
 * of truth; docs/knowledge markdown is only the compatibility import/export
 * surface. The output file shape intentionally matches buildKnowledgeContext
 * so existing prompt injection keeps working.
 */
export async function buildKnowledgeContextFromDb(
  opts: BuildKnowledgeContextFromDbOpts,
): Promise<BuildKnowledgeContextResult> {
  if (!DOMAIN_RE.test(opts.domain)) {
    throw new KnowledgeContextError(
      `invalid domain: ${JSON.stringify(opts.domain)}`,
    );
  }
  const current = listCurrentKnowledgeRevisions(opts.db, {
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    ...(opts.repoId !== undefined ? { repoId: opts.repoId } : {}),
    domain: opts.domain,
  });
  const entries: KnowledgeContextEntry[] = [];
  const revisionIds: number[] = [];
  for (const r of current) {
    const { frontmatter, body } = splitFrontmatter(r.bodyMarkdown);
    const fm = frontmatter ?? {};
    if (fm.domain !== undefined && fm.domain !== opts.domain) continue;
    if (isDeprecated(fm.deprecated)) continue;
    entries.push({
      file: r.path ?? r.entryId,
      kind: typeof fm.kind === "string" ? fm.kind : r.kind,
      title:
        typeof fm.title === "string"
          ? fm.title
          : r.title ?? r.path ?? r.entryId,
      confidence:
        typeof fm.confidence === "string" ? fm.confidence : "unknown",
      content: body.trim(),
    });
    revisionIds.push(r.revisionId);
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  revisionIds.sort((a, b) => a - b);

  const generatedAt = (opts.now ?? new Date()).toISOString();
  const outPath = join(opts.outDir, `${domainSlug(opts.domain)}.md`);
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(outPath, renderContext(opts.domain, generatedAt, entries));

  return {
    domain: opts.domain,
    outPath,
    entries,
    knowledgeRevisionIds: revisionIds,
  };
}

function renderContext(
  domain: string,
  generatedAt: string,
  entries: KnowledgeContextEntry[],
): string {
  const head = [
    "---",
    `domain: ${JSON.stringify(domain)}`,
    `generated_at: ${JSON.stringify(generatedAt)}`,
    `entry_count: ${entries.length}`,
    "---",
    "",
    `# Knowledge context: ${domain}`,
    "",
    "Promoted knowledge for this domain, aggregated by " +
      "`harness knowledge build-context`. Deprecated and non-promoted " +
      "entries are excluded.",
    "",
  ];
  if (entries.length === 0) {
    head.push("(no promoted knowledge for this domain yet)", "");
    return head.join("\n");
  }
  const blocks = entries.map((e) =>
    [
      `## ${e.title}`,
      "",
      `- kind: ${e.kind}`,
      `- confidence: ${e.confidence}`,
      `- source: ${e.file}`,
      "",
      e.content,
      "",
    ].join("\n"),
  );
  return head.concat(blocks).join("\n");
}
