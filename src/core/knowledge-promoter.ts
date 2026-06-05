import {
  readFile,
  writeFile,
  rename,
  mkdir,
  appendFile,
  readdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

export class KnowledgePromoteGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgePromoteGateError";
  }
}

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// kind becomes a directory segment, so it must be a single safe name.
// No path separators, no '..', no leading dot.
const KIND_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const DECISIONS_FILE = "knowledge-decisions.yaml";

export interface KnowledgeCandidate {
  kind: string;
  domain: string;
  title: string;
  content: string;
  evidence: string[];
  confidence: string;
  status: string;
}

/** governance status of a candidate, derived from the docs + decisions sidecar */
export type KnowledgeStatus = "candidate" | "promoted" | "rejected";

export interface RejectDecision {
  index: number;
  reviewer: string;
  reason: string;
  decidedAt: string;
}

// --- shared helpers -------------------------------------------------------

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new KnowledgePromoteGateError(
      `invalid runId: ${JSON.stringify(runId)}`,
    );
  }
}

export function isCandidate(x: unknown): x is KnowledgeCandidate {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.kind === "string" &&
    typeof c.domain === "string" &&
    typeof c.title === "string" &&
    typeof c.content === "string" &&
    Array.isArray(c.evidence) &&
    typeof c.confidence === "string"
  );
}

/**
 * Read knowledge-candidates.yaml for a run. Returns the raw entry array
 * (each element may or may not be a well-formed candidate — callers
 * filter with isCandidate). Exported for the DB-first path (Phase 7-9),
 * which syncs the same observation log into `knowledge_candidates`.
 */
export async function loadCandidates(
  runsDir: string,
  runId: string,
): Promise<unknown[]> {
  const candidatesPath = join(runsDir, runId, "knowledge-candidates.yaml");
  if (!existsSync(candidatesPath)) {
    throw new KnowledgePromoteGateError(`${candidatesPath} not found`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(candidatesPath, "utf8"));
  } catch (e) {
    throw new KnowledgePromoteGateError(
      `failed to parse ${candidatesPath}: ${(e as Error).message}`,
    );
  }
  return parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { candidates?: unknown }).candidates)
    ? (parsed as { candidates: unknown[] }).candidates
    : [];
}

/**
 * Read the raw `decisions` array from the sidecar (entries are kept
 * verbatim so unknown decision types / fields survive a rewrite).
 */
async function loadRawDecisions(
  runsDir: string,
  runId: string,
): Promise<Record<string, unknown>[]> {
  const path = join(runsDir, runId, DECISIONS_FILE);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(path, "utf8"));
  } catch (e) {
    throw new KnowledgePromoteGateError(
      `failed to parse ${path}: ${(e as Error).message}`,
    );
  }
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

/** index → RejectDecision, restricted to entries with decision === rejected. */
async function loadRejectDecisions(
  runsDir: string,
  runId: string,
): Promise<Map<number, RejectDecision>> {
  const out = new Map<number, RejectDecision>();
  for (const r of await loadRawDecisions(runsDir, runId)) {
    if (
      typeof r.index === "number" &&
      r.decision === "rejected" &&
      typeof r.reviewer === "string"
    ) {
      out.set(r.index, {
        index: r.index,
        reviewer: r.reviewer,
        reason: typeof r.reason === "string" ? r.reason : "",
        decidedAt: typeof r.decidedAt === "string" ? r.decidedAt : "",
      });
    }
  }
  return out;
}

/**
 * Stable content hash of a candidate. JSON.stringify of the field array
 * keeps the boundaries unambiguous (no separator-collision: ["a b","c"]
 * and ["a","b c"] serialize differently).
 */
export function contentHash(c: KnowledgeCandidate): string {
  return createHash("sha256")
    .update(JSON.stringify([c.kind, c.domain, c.title, c.content]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Unicode-aware slug: keep letters / numbers (any script), normalize
 * separators to '-', truncate to 48 chars, and append a short hash so
 * truncated or non-ASCII titles still have a discriminator.
 */
export function slugify(s: string): string {
  const lowered = s.toLowerCase().normalize("NFKC");
  const cleaned = lowered
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  const base = cleaned.slice(0, 48) || "untitled";
  const hash = createHash("sha1").update(s).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}

export function assertSafeKind(kind: string, index: number): void {
  if (!KIND_RE.test(kind)) {
    throw new KnowledgePromoteGateError(
      `candidate ${index} has unsafe 'kind' (must match ${KIND_RE.source}): ${JSON.stringify(kind)}`,
    );
  }
}

export function kindDirOf(knowledgeRoot: string, kind: string, index: number): string {
  const dir = join(knowledgeRoot, kind);
  const resolved = resolve(dir);
  // Defense in depth: KIND_RE already prevents traversal.
  if (resolved !== knowledgeRoot && !resolved.startsWith(knowledgeRoot + sep)) {
    throw new KnowledgePromoteGateError(
      `candidate ${index} kind ${JSON.stringify(kind)} resolves outside knowledgeDir`,
    );
  }
  return dir;
}

/** Throw `KnowledgePromoteGateError` when `runId` is not a safe run id. */
export function assertKnowledgeRunId(runId: string): void {
  assertRunId(runId);
}

/** The `<runId>-<NN>-<slug>.md` filename a promoted candidate is written to. */
export function promotedFilename(
  runId: string,
  index: number,
  title: string,
): string {
  return `${runId}-${String(index).padStart(2, "0")}-${slugify(title)}.md`;
}

export interface PromoteMeta {
  runId: string;
  index: number;
  reviewer: string;
  promotedAt: string;
  hash: string;
}

export interface PromotedMarkdown {
  /** the full `docs/knowledge/<kind>/*.md` file content */
  markdown: string;
  /** the markdown body alone (everything after the frontmatter) */
  body: string;
  /** the frontmatter as the object `parseYaml` would produce from the md */
  frontmatter: Record<string, unknown>;
}

/** The frontmatter object for a promoted candidate (the single source). */
function promotedFrontmatter(
  c: KnowledgeCandidate,
  meta: PromoteMeta,
): Record<string, unknown> {
  return {
    kind: c.kind,
    domain: c.domain,
    title: c.title,
    source_run: meta.runId,
    source_index: meta.index,
    confidence: c.confidence,
    source_status: c.status,
    promoted_by: meta.reviewer,
    promoted_at: meta.promotedAt,
    // deprecated knowledge is excluded from `knowledge build-context`.
    // promote writes false; `knowledge deprecate` retires an entry later.
    deprecated: false,
    hash: meta.hash,
  };
}

/**
 * Render a promoted candidate as its `docs/knowledge/<kind>/*.md` file —
 * the YAML frontmatter (provenance + content hash) followed by the
 * candidate's content. Shared by the legacy file writer and the DB-first
 * export (Phase 7-9) so both emit byte-identical markdown, and so the DB
 * manifest's `frontmatter_json` is the exact object the md parses to.
 */
export function buildPromotedMarkdown(
  c: KnowledgeCandidate,
  meta: PromoteMeta,
): PromotedMarkdown {
  const fm = promotedFrontmatter(c, meta);
  const frontmatterText = [
    "---",
    `kind: ${c.kind}`,
    `domain: ${JSON.stringify(c.domain)}`,
    `title: ${JSON.stringify(c.title)}`,
    `source_run: ${meta.runId}`,
    `source_index: ${meta.index}`,
    `confidence: ${JSON.stringify(c.confidence)}`,
    `source_status: ${JSON.stringify(c.status)}`,
    `promoted_by: ${JSON.stringify(meta.reviewer)}`,
    `promoted_at: ${JSON.stringify(meta.promotedAt)}`,
    "deprecated: false",
    `hash: ${meta.hash}`,
    "---",
  ].join("\n");
  const body = [
    "",
    `# ${c.title}`,
    "",
    `Evidence: ${c.evidence.join(", ") || "(none)"}`,
    "",
    "## Content",
    "",
    c.content,
    "",
  ].join("\n");
  return { markdown: `${frontmatterText}\n${body}`, body, frontmatter: fm };
}

/**
 * Split a md file into its leading YAML frontmatter (if any) and body.
 * The frontmatter is delimited by a `---` line at the very start and a
 * closing `---` line — both matched as WHOLE lines (`^---\s*$`), so a
 * `---...` sequence inside a value/body does not falsely close it. CRLF
 * is tolerated. parseFrontmatter / stripFrontmatter both route here so
 * they always agree on the boundary.
 */
export function splitFrontmatter(md: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: null, body: md };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return { frontmatter: null, body: md };
  const body = lines.slice(close + 1).join("\n");
  let frontmatter: Record<string, unknown> | null = null;
  try {
    const parsed = parseYaml(lines.slice(1, close).join("\n"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    frontmatter = null;
  }
  return { frontmatter, body };
}

/** Parse the leading `--- ... ---` YAML frontmatter of a md file. */
export function parseFrontmatter(
  md: string,
): Record<string, unknown> | null {
  return splitFrontmatter(md).frontmatter;
}

export interface KindDirScan {
  /** content hashes already present (from frontmatter `hash`) */
  hashes: Set<string>;
  /** "<source_run>#<source_index>" keys already promoted */
  promotedKeys: Set<string>;
}

/**
 * Scan a kind dir's md files, reading each one's frontmatter. Used for
 * both duplicate-by-hash and duplicate-by-(run,index) detection — both
 * keyed off the frontmatter, NOT the filename (filenames concatenate
 * runId and index ambiguously).
 */
export async function scanKindDir(kindDir: string): Promise<KindDirScan> {
  const scan: KindDirScan = {
    hashes: new Set<string>(),
    promotedKeys: new Set<string>(),
  };
  if (!existsSync(kindDir)) return scan;
  let files: string[];
  try {
    files = await readdir(kindDir);
  } catch {
    return scan;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    let fm: Record<string, unknown> | null;
    try {
      fm = parseFrontmatter(await readFile(join(kindDir, f), "utf8"));
    } catch {
      continue;
    }
    if (!fm) continue;
    if (typeof fm.hash === "string" && /^[0-9a-f]{16}$/.test(fm.hash)) {
      scan.hashes.add(fm.hash);
    }
    if (
      typeof fm.source_run === "string" &&
      typeof fm.source_index === "number"
    ) {
      scan.promotedKeys.add(`${fm.source_run}#${fm.source_index}`);
    }
  }
  return scan;
}

// --- knowledge list -------------------------------------------------------

export interface KnowledgeListEntry {
  index: number;
  kind: string;
  domain: string;
  title: string;
  confidence: string;
  status: KnowledgeStatus;
  /** populated when status === rejected */
  rejectedBy?: string;
  rejectReason?: string;
}

export interface ListKnowledgeOpts {
  runsDir: string;
  knowledgeDir: string;
  runId: string;
  kind?: string;
  domain?: string;
}

/**
 * List a run's knowledge candidates with their governance status:
 *   - rejected: an entry in knowledge-decisions.yaml
 *   - promoted: a md under docs/knowledge/<kind>/ whose frontmatter has
 *     source_run === runId and source_index === this index
 *   - candidate: neither
 */
export async function listKnowledge(
  opts: ListKnowledgeOpts,
): Promise<KnowledgeListEntry[]> {
  assertRunId(opts.runId);
  const candidates = await loadCandidates(opts.runsDir, opts.runId);
  const rejects = await loadRejectDecisions(opts.runsDir, opts.runId);
  const knowledgeRoot = resolve(opts.knowledgeDir);

  // cache per-kind scans
  const scanByKind = new Map<string, KindDirScan>();

  const out: KnowledgeListEntry[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!isCandidate(c)) continue;
    if (opts.kind !== undefined && c.kind !== opts.kind) continue;
    if (opts.domain !== undefined && c.domain !== opts.domain) continue;

    let status: KnowledgeStatus = "candidate";
    const reject = rejects.get(i);
    if (reject) {
      status = "rejected";
    } else if (KIND_RE.test(c.kind)) {
      let scan = scanByKind.get(c.kind);
      if (!scan) {
        scan = await scanKindDir(join(knowledgeRoot, c.kind));
        scanByKind.set(c.kind, scan);
      }
      if (scan.promotedKeys.has(`${opts.runId}#${i}`)) {
        status = "promoted";
      }
    }
    const entry: KnowledgeListEntry = {
      index: i,
      kind: c.kind,
      domain: c.domain,
      title: c.title,
      confidence: c.confidence,
      status,
    };
    if (reject) {
      entry.rejectedBy = reject.reviewer;
      entry.rejectReason = reject.reason;
    }
    out.push(entry);
  }
  return out;
}

// --- knowledge reject -----------------------------------------------------

export interface RejectKnowledgeOpts {
  runsDir: string;
  runId: string;
  index: number;
  reviewer: string;
  reason: string;
  now?: Date;
}

export interface RejectResult {
  runId: string;
  index: number;
  reviewer: string;
  /** DB-first path: warnings when the DB write succeeded but export did not */
  exportWarnings?: string[];
}

/**
 * Record a reject decision for a candidate in the run's
 * knowledge-decisions.yaml sidecar. knowledge-candidates.yaml itself is
 * never modified. The sidecar is rewritten preserving any decision
 * entries this code does not recognise, and replaced atomically.
 */
export async function rejectKnowledge(
  opts: RejectKnowledgeOpts,
): Promise<RejectResult> {
  assertRunId(opts.runId);
  if (opts.reviewer.trim() === "") {
    throw new KnowledgePromoteGateError("reviewer is required for reject");
  }
  // governance: a reject must record WHY (Phase 2-9 intent).
  if (opts.reason.trim() === "") {
    throw new KnowledgePromoteGateError("reason is required for reject");
  }
  const candidates = await loadCandidates(opts.runsDir, opts.runId);
  if (
    !Number.isInteger(opts.index) ||
    opts.index < 0 ||
    opts.index >= candidates.length
  ) {
    throw new KnowledgePromoteGateError(
      `candidate index ${opts.index} is out of range (run has ${candidates.length} candidate entries)`,
    );
  }

  const decidedAt = (opts.now ?? new Date()).toISOString();
  const raw = await loadRawDecisions(opts.runsDir, opts.runId);
  const entry: Record<string, unknown> = {
    index: opts.index,
    decision: "rejected",
    reviewer: opts.reviewer,
    reason: opts.reason,
    decidedAt,
  };
  // upsert: replace an existing rejected decision for the same index,
  // otherwise append. Other entries (incl. unknown decision types) are
  // preserved verbatim.
  const existingIdx = raw.findIndex(
    (d) => d.index === opts.index && d.decision === "rejected",
  );
  if (existingIdx >= 0) raw[existingIdx] = entry;
  else raw.push(entry);
  raw.sort((a, b) => {
    const ai = typeof a.index === "number" ? a.index : 0;
    const bi = typeof b.index === "number" ? b.index : 0;
    return ai - bi;
  });

  const body =
    "decisions:\n" +
    raw
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
  // atomic replace: write to a temp file then rename.
  const finalPath = join(opts.runsDir, opts.runId, DECISIONS_FILE);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, finalPath);

  await appendFile(
    join(opts.runsDir, opts.runId, "events.jsonl"),
    `${JSON.stringify({
      type: "knowledge_rejected",
      runId: opts.runId,
      index: opts.index,
      reviewer: opts.reviewer,
      reason: opts.reason,
      decidedAt,
    })}\n`,
    "utf8",
  );

  return { runId: opts.runId, index: opts.index, reviewer: opts.reviewer };
}

// --- knowledge promote ----------------------------------------------------

export interface PromoteOpts {
  runsDir: string;
  /** absolute path of the directory to write knowledge files into */
  knowledgeDir: string;
  runId: string;
  /** reviewer handle stamped into each promoted md (required) */
  reviewer: string;
  /** if set, only candidates whose kind matches are promoted */
  kind?: string;
  /** create a md even if an identical content hash already exists */
  allowDuplicate?: boolean;
  now?: Date;
}

export interface PromotedFile {
  kind: string;
  title: string;
  path: string;
  /** the candidate's index in `knowledge-candidates.yaml` */
  index: number;
  /** the candidate's domain */
  domain: string;
  /** the candidate content hash stamped into the md frontmatter */
  hash: string;
}

export interface SkipRecord {
  index: number;
  reason:
	    | "kind-filter"
	    | "index-filter"
	    | "rejected"
    | "duplicate-index"
    | "duplicate-hash"
    | "malformed";
  detail?: string;
}

export interface PromoteResult {
  runId: string;
  promoted: PromotedFile[];
  skipped: SkipRecord[];
  /** DB-first path: warnings when the DB write succeeded but export did not */
  exportWarnings?: string[];
}

/**
 * Promote knowledge-candidates.yaml entries into individual markdown
 * files under `<knowledgeDir>/<kind>/<runId>-<idx>-<title-slug>.md`, each
 * with a YAML frontmatter recording who promoted it and a content hash.
 *
 * knowledge-candidates.yaml is never modified (immutable observation log).
 * Candidates rejected in knowledge-decisions.yaml are skipped. Re-running
 * promote is idempotent: a candidate already promoted (a md with matching
 * source_run/source_index frontmatter exists) is skipped, and an
 * identical content hash is skipped unless allowDuplicate is set.
 */
export async function promoteKnowledge(
  opts: PromoteOpts,
): Promise<PromoteResult> {
  assertRunId(opts.runId);
  if (opts.reviewer.trim() === "") {
    throw new KnowledgePromoteGateError("reviewer is required for promote");
  }
  const candidates = await loadCandidates(opts.runsDir, opts.runId);
  const rejects = await loadRejectDecisions(opts.runsDir, opts.runId);
  const knowledgeRoot = resolve(opts.knowledgeDir);
  const promotedAt = (opts.now ?? new Date()).toISOString();

  const promoted: PromotedFile[] = [];
  const skipped: SkipRecord[] = [];
  // per-kind scans, lazily seeded from existing md files
  const scanByKind = new Map<string, KindDirScan>();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!isCandidate(c)) {
      skipped.push({ index: i, reason: "malformed" });
      continue;
    }
    assertSafeKind(c.kind, i);
    if (opts.kind !== undefined && c.kind !== opts.kind) {
      skipped.push({ index: i, reason: "kind-filter" });
      continue;
    }
    if (rejects.has(i)) {
      skipped.push({
        index: i,
        reason: "rejected",
        detail: `rejected by ${rejects.get(i)!.reviewer}`,
      });
      continue;
    }
    const kindDir = kindDirOf(knowledgeRoot, c.kind, i);
    let scan = scanByKind.get(c.kind);
    if (!scan) {
      scan = await scanKindDir(kindDir);
      scanByKind.set(c.kind, scan);
    }
    if (scan.promotedKeys.has(`${opts.runId}#${i}`)) {
      skipped.push({ index: i, reason: "duplicate-index" });
      continue;
    }
    const hash = contentHash(c);
    if (scan.hashes.has(hash) && !opts.allowDuplicate) {
      skipped.push({
        index: i,
        reason: "duplicate-hash",
        detail: `content hash ${hash} already promoted`,
      });
      continue;
    }

    const filename = promotedFilename(opts.runId, i, c.title);
    await mkdir(kindDir, { recursive: true });
    const outPath = join(kindDir, filename);
    const { markdown } = buildPromotedMarkdown(c, {
      runId: opts.runId,
      index: i,
      reviewer: opts.reviewer,
      promotedAt,
      hash,
    });
    await writeFile(outPath, markdown, "utf8");
    // keep the in-memory scan current so two identical candidates in the
    // same run don't both get promoted.
    scan.hashes.add(hash);
    scan.promotedKeys.add(`${opts.runId}#${i}`);
    promoted.push({
      kind: c.kind,
      title: c.title,
      path: outPath,
      index: i,
      domain: c.domain,
      hash,
    });
  }

  await appendFile(
    join(opts.runsDir, opts.runId, "events.jsonl"),
    `${JSON.stringify({
      type: "knowledge_promoted",
      runId: opts.runId,
      reviewer: opts.reviewer,
      ...(opts.kind !== undefined ? { kindFilter: opts.kind } : {}),
      promotedCount: promoted.length,
      skippedCount: skipped.length,
      files: promoted.map((p) => p.path),
    })}\n`,
    "utf8",
  );

  return { runId: opts.runId, promoted, skipped };
}
