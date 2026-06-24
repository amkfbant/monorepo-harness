import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { splitFrontmatter, isCandidate } from "./knowledge-promoter.js";

const RUN_DIR_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

export interface KnowledgeDigest {
  /** ISO lower bound, or null when unbounded */
  since: string | null;
  domain: string | null;
  candidatesByKind: Record<string, number>;
  candidateTotal: number;
  promoted: number;
  rejected: number;
  suggestions: string[];
}

export interface DigestOpts {
  runsDir: string;
  /** docs/knowledge — the promoted-knowledge root */
  knowledgeDir: string;
  /** only count items at or after this instant */
  since?: Date;
  /** restrict to one domain */
  domain?: string;
}

/**
 * Aggregate knowledge activity — candidate kinds, promotions, rejections —
 * over a time window, so an operator can review what built up.
 */
export async function buildKnowledgeDigest(
  opts: DigestOpts,
): Promise<KnowledgeDigest> {
  const sinceMs = opts.since ? opts.since.getTime() : null;
  const candidatesByKind: Record<string, number> = {};
  let candidateTotal = 0;
  let rejected = 0;
  // all promotions ever — used both for the windowed count and to know
  // (per source_run#index) whether a candidate has already been promoted.
  const { promotedKeys } = await scanPromoted(opts.knowledgeDir);
  // runs that still have a candidate neither promoted nor rejected
  const runsWithUnactioned: string[] = [];

  for (const runId of await readdirSafe(opts.runsDir)) {
    if (!RUN_DIR_RE.test(runId)) continue;
    const runDir = join(opts.runsDir, runId);
    const startedAt = await runStartedAt(runDir);
    const candidates = await readCandidates(runDir);
    // index -> latest decidedAt of a rejection for that candidate
    const rejections = await readRejections(runDir);

    const inWindow = withinSince(startedAt, sinceMs);
    let unactionedHere = false;
    for (const c of candidates) {
      if (!c.valid) continue; // malformed — `knowledge list` skips it too
      const domainMatch =
        opts.domain === undefined || c.domain === opts.domain;
      if (inWindow && domainMatch) {
        candidatesByKind[c.kind] = (candidatesByKind[c.kind] ?? 0) + 1;
        candidateTotal += 1;
        const acted =
          rejections.has(c.index) ||
          promotedKeys.has(`${runId}#${c.index}`);
        if (!acted) unactionedHere = true;
      }
    }
    if (unactionedHere) runsWithUnactioned.push(runId);

    // rejections — filtered by decidedAt + the rejected valid candidate's domain
    for (const [index, decidedAt] of rejections) {
      if (!withinSince(decidedAt, sinceMs)) continue;
      const c = candidates[index];
      if (!c?.valid) continue;
      if (opts.domain !== undefined && c.domain !== opts.domain) continue;
      rejected += 1;
    }
  }

  const promoted = await countPromoted(
    opts.knowledgeDir,
    sinceMs,
    opts.domain,
  );

  return {
    since: opts.since ? opts.since.toISOString() : null,
    domain: opts.domain ?? null,
    candidatesByKind,
    candidateTotal,
    promoted,
    rejected,
    suggestions: buildSuggestions(candidateTotal, runsWithUnactioned),
  };
}

function withinSince(iso: string | null, sinceMs: number | null): boolean {
  if (sinceMs === null) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t >= sinceMs;
}

async function runStartedAt(runDir: string): Promise<string | null> {
  try {
    const meta = JSON.parse(
      await readFile(join(runDir, "meta.json"), "utf8"),
    ) as { startedAt?: unknown };
    return typeof meta.startedAt === "string" ? meta.startedAt : null;
  } catch {
    return null;
  }
}

interface DigestCandidate {
  /** position in the run's knowledge-candidates.yaml (rejections key off it) */
  index: number;
  kind: string;
  domain: string;
  /** false when the candidate is malformed by the knowledge candidate schema */
  valid: boolean;
}

/**
 * Read a run's candidates, preserving index alignment. A malformed entry
 * is kept (so indices still line up with rejections) but flagged invalid
 * so the digest counts it the same way `knowledge list/promote` would —
 * i.e. not at all.
 */
async function readCandidates(runDir: string): Promise<DigestCandidate[]> {
  const path = join(runDir, "knowledge-candidates.yaml");
  if (!existsSync(path)) return [];
  try {
    const doc = parseYaml(await readFile(path, "utf8")) as {
      candidates?: unknown;
    } | null;
    if (!Array.isArray(doc?.candidates)) return [];
    return (doc.candidates as unknown[]).map((c, index) => {
      // valid == the SAME schema `knowledge list / promote` accept, so a
      // candidate counted here is one those commands can actually act on.
      const valid = isCandidate(c);
      const o = (c ?? {}) as { kind?: unknown; domain?: unknown };
      return {
        index,
        kind: typeof o.kind === "string" && o.kind !== "" ? o.kind : "unknown",
        domain:
          typeof o.domain === "string" && o.domain !== "" ? o.domain : "?",
        valid,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Read a run's rejections as `index -> latest decidedAt`. Only a syntactically
 * valid non-negative integer index is kept; candidate existence/schema validity
 * is resolved by callers that have the candidate list. A duplicate index keeps
 * the most recent decision (matching how `listKnowledge` keys rejections by
 * index).
 */
async function readRejections(
  runDir: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const path = join(runDir, "knowledge-decisions.yaml");
  if (!existsSync(path)) return out;
  try {
    const doc = parseYaml(await readFile(path, "utf8")) as {
      decisions?: unknown;
    } | null;
    if (!Array.isArray(doc?.decisions)) return out;
    for (const raw of doc.decisions as unknown[]) {
      const d = (raw ?? {}) as Record<string, unknown>;
      if (d.decision !== "rejected") continue;
      if (typeof d.index !== "number" || !Number.isInteger(d.index)) continue;
      if (d.index < 0) continue;
      const decidedAt = typeof d.decidedAt === "string" ? d.decidedAt : "";
      const prev = out.get(d.index);
      if (prev === undefined || decidedAt > prev) out.set(d.index, decidedAt);
    }
  } catch {
    // unreadable decisions file — treat as no rejections
  }
  return out;
}

/**
 * Promoted-candidate keys (`<source_run>#<source_index>`) across
 * docs/knowledge — shared with `inbox` so both judge "actioned" the
 * same way (Phase 4-5 parity).
 */
export async function scanPromotedKeys(
  knowledgeDir: string,
): Promise<Set<string>> {
  return (await scanPromoted(knowledgeDir)).promotedKeys;
}

/**
 * Count a run's valid candidates that are neither promoted nor rejected —
 * i.e. the ones still needing an operator decision.
 */
export async function countUnactionedCandidates(
  runDir: string,
  runId: string,
  promotedKeys: Set<string>,
): Promise<number> {
  const candidates = await readCandidates(runDir);
  const rejections = await readRejections(runDir);
  let n = 0;
  for (const c of candidates) {
    if (!c.valid) continue;
    if (rejections.has(c.index)) continue;
    if (promotedKeys.has(`${runId}#${c.index}`)) continue;
    n += 1;
  }
  return n;
}

interface PromotedScan {
  /** every promoted candidate's `<source_run>#<source_index>` key */
  promotedKeys: Set<string>;
}

/** Scan all promoted md, collecting source_run#source_index keys. */
async function scanPromoted(knowledgeDir: string): Promise<PromotedScan> {
  const promotedKeys = new Set<string>();
  for (const kind of await readdirSafe(knowledgeDir)) {
    const kindDir = join(knowledgeDir, kind);
    for (const f of await readdirSafe(kindDir)) {
      if (!f.endsWith(".md")) continue;
      const fm = await frontmatterOf(join(kindDir, f));
      if (!fm) continue;
      if (
        typeof fm.source_run === "string" &&
        typeof fm.source_index === "number"
      ) {
        promotedKeys.add(`${fm.source_run}#${fm.source_index}`);
      }
    }
  }
  return { promotedKeys };
}

/** Count promoted md files filtered by promoted_at window + domain. */
async function countPromoted(
  knowledgeDir: string,
  sinceMs: number | null,
  domain: string | undefined,
): Promise<number> {
  let count = 0;
  for (const kind of await readdirSafe(knowledgeDir)) {
    const kindDir = join(knowledgeDir, kind);
    for (const f of await readdirSafe(kindDir)) {
      if (!f.endsWith(".md")) continue;
      const fm = await frontmatterOf(join(kindDir, f));
      if (!fm) continue;
      if (domain !== undefined && fm.domain !== domain) continue;
      if (
        sinceMs !== null &&
        !withinSince(
          typeof fm.promoted_at === "string" ? fm.promoted_at : null,
          sinceMs,
        )
      ) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

async function frontmatterOf(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return splitFrontmatter(await readFile(path, "utf8")).frontmatter;
  } catch {
    return null;
  }
}

function buildSuggestions(
  candidateTotal: number,
  runsWithUnactioned: string[],
): string[] {
  if (candidateTotal === 0) {
    return ["No new knowledge candidates in this window."];
  }
  // each suggested run genuinely has a candidate that is neither promoted
  // nor rejected (checked per (runId, index)).
  return runsWithUnactioned
    .slice(0, 3)
    .map(
      (runId) =>
        `Review candidates from ${runId} — harness knowledge list --run-id ${runId}`,
    );
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export function formatDigest(d: KnowledgeDigest): string {
  const lines: string[] = [];
  const window = d.since ? `since ${d.since}` : "all time";
  lines.push(
    `Knowledge digest: ${window}${d.domain ? ` (domain ${d.domain})` : ""}`,
    "",
    "Candidates:",
  );
  const kinds = Object.keys(d.candidatesByKind).sort();
  if (kinds.length === 0) {
    lines.push("  (none)");
  } else {
    for (const k of kinds) lines.push(`  ${k}: ${d.candidatesByKind[k]}`);
  }
  lines.push(
    "",
    `Promoted: ${d.promoted}`,
    `Rejected: ${d.rejected}`,
    "",
    "Suggested actions:",
  );
  if (d.suggestions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of d.suggestions) lines.push(`  - ${s}`);
  }
  lines.push("");
  return lines.join("\n");
}
