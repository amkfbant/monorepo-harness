import { readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { minimatch } from "minimatch";
import type {
  EvidenceCheckContext,
  RawJuryEvidence,
  VerifiedJuryEvidence,
} from "./types.js";

/**
 * #230 deliberation jury — deterministic evidence existence check (Layer 1,
 * deterministic IO, read-only). Frozen contract: design §4.4 + §0.1 R1 + P3.
 *
 * Safety boundary (design §0.1 R1): this function IGNORES any `verified` field
 * present on the input and recomputes it deterministically. The LLM cannot
 * self-assert verification — if the model claims `verified:true` on a citation
 * that does not resolve, the output is `verified:false`. Same input + same ctx
 * always yields a deep-equal output. No SQLite, no network.
 *
 * Relevance limit (design §0.1 R1 / §12): this only proves the citation EXISTS;
 * it does NOT prove the citation supports the claim. Relevance is handled by the
 * Stage3 critique and the deterministic proximity filter in `aggregateDelibera
 * tion` — never here.
 */

const SPEC_MATCH_OPTS = { dot: true, nocomment: true } as const;
const DEFAULT_SPEC_DOCS_GLOBS: readonly string[] = ["docs/specs/**/*.md"];

/**
 * Verify one piece of evidence against the deterministic context. Returns a
 * `VerifiedJuryEvidence` carrying a recomputed `verified` flag (and, for `file`
 * citations, the absolute resolved path in `resolvedRef`).
 */
export function verifyEvidence(
  ev: RawJuryEvidence,
  ctx: EvidenceCheckContext,
): VerifiedJuryEvidence {
  // Strip any LLM-claimed verified/resolvedRef: only deterministic recompute
  // below may set them (design §0.1 R1).
  const base: RawJuryEvidence = {
    citation: ev.citation,
    kind: ev.kind,
    claim: ev.claim,
  };

  switch (ev.kind) {
    case "file":
      return verifyFile(base, ctx);
    case "spec":
      return { ...base, verified: verifySpec(base, ctx) };
    case "policy":
      return { ...base, verified: verifyPolicy(base, ctx) };
    default:
      // Unknown / unresolvable kind -> fail-closed.
      return { ...base, verified: false };
  }
}

/**
 * A `file` citation is `<path>[:line]` or `<path>[:start-end]`. It is verified
 * iff `worktreePath/<path>` exists as a file AND the resolved path stays INSIDE
 * the worktree (no absolute path, no `..` escape — design §0.1 R1 fail-closed)
 * AND (no line given OR every cited line is within the file's line count).
 * `resolvedRef` is the absolute (in-tree) path.
 *
 * Path-traversal guard (codex P1): a citation like `src/a.ts/../../package.json`
 * resolves to an out-of-tree file and would otherwise existence-verify AND spoof
 * proximity (the raw first segment looks in-tree). We reject any absolute
 * citation and any resolved path whose worktree-relative form is empty, escapes
 * with `..`, or is itself absolute (Windows drive switch) -> verified:false.
 */
function verifyFile(
  ev: RawJuryEvidence,
  ctx: EvidenceCheckContext,
): VerifiedJuryEvidence {
  const parsed = parseFileCitation(ev.citation);
  if (parsed === undefined) return { ...ev, verified: false };
  const { path, startLine, endLine } = parsed;
  // Reject absolute citations outright (they are not worktree-relative).
  if (isAbsolute(path)) return { ...ev, verified: false };
  const abs = resolve(ctx.worktreePath, path);
  // Reject any resolved path that escapes the worktree (`..` traversal or a
  // different root). The relative form must be a non-empty, non-`..`,
  // non-absolute in-tree path.
  const rel = relative(ctx.worktreePath, abs);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ...ev, verified: false };
  }
  let lineCount: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { ...ev, verified: false, resolvedRef: abs };
    lineCount = countLines(readFileSync(abs, "utf8"));
  } catch {
    // ENOENT or any IO error -> unresolvable -> fail-closed.
    return { ...ev, verified: false, resolvedRef: abs };
  }
  const inRange =
    startLine === undefined ||
    (startLine >= 1 &&
      startLine <= lineCount &&
      (endLine === undefined || (endLine >= startLine && endLine <= lineCount)));
  return { ...ev, verified: inRange, resolvedRef: abs };
}

interface ParsedFileCitation {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** Parse `<path>[:line[-line]]`. Returns undefined if the suffix is malformed. */
function parseFileCitation(citation: string): ParsedFileCitation | undefined {
  const colon = citation.lastIndexOf(":");
  if (colon === -1) return { path: citation };
  const suffix = citation.slice(colon + 1);
  const lineRe = /^(\d+)(?:-(\d+))?$/;
  const m = lineRe.exec(suffix);
  if (m === null) {
    // ':' not a line spec — treat the whole string as a path (no line check).
    return { path: citation };
  }
  const path = citation.slice(0, colon);
  if (path.length === 0) return undefined;
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === undefined) return { path };
  const startLine = Number.parseInt(startRaw, 10);
  return endRaw === undefined
    ? { path, startLine }
    : { path, startLine, endLine: Number.parseInt(endRaw, 10) };
}

/** Count lines (1-based) the file spans; an empty file has 0 lines. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const withoutTrailingNewline = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  return withoutTrailingNewline.split("\n").length;
}

/**
 * A `spec` citation is `<md-path>#<anchor>`. It is verified iff the md file is
 * covered by `specDocsGlobs` (default `docs/specs/**\/*.md`), STAYS inside the
 * spec root the glob anchors (no `..` escape, no absolute path), AND a heading
 * whose GitHub-style slug equals `<anchor>` exists exactly once (design §4.4 +
 * P3: missing -> false; duplicate-ambiguous -> false / fail-closed).
 *
 * Path-traversal guard (codex P2): the glob check runs on the RAW citation path,
 * and minimatch's extglob (`+(..)`) — or any operator-set glob — can match a
 * `..`-escaping citation. Resolving that path directly would read a markdown
 * file OUTSIDE the spec tree (and verify if it has the anchor). Mirroring the
 * file-kind guard, the RESOLVED path must stay INSIDE the static-prefix root of
 * a glob it matched (`relative(specRoot, resolved)` non-empty / not `..` /
 * non-absolute); otherwise -> false (fail-closed).
 */
function verifySpec(ev: RawJuryEvidence, ctx: EvidenceCheckContext): boolean {
  const hash = ev.citation.indexOf("#");
  if (hash === -1) return false;
  const path = ev.citation.slice(0, hash);
  const anchor = slugify(ev.citation.slice(hash + 1));
  if (path.length === 0 || anchor.length === 0) return false;
  // Reject absolute citations outright (they are not worktree-relative).
  if (isAbsolute(path)) return false;
  const globs = ctx.specDocsGlobs ?? DEFAULT_SPEC_DOCS_GLOBS;
  const matchedGlobs = globs.filter((g) => minimatch(path, g, SPEC_MATCH_OPTS));
  if (matchedGlobs.length === 0) return false;
  const abs = resolve(ctx.worktreePath, path);
  // The resolved path must stay inside the static-prefix spec root of at least
  // one glob it matched (defense-in-depth against a `..`-escaping citation that
  // the glob nonetheless matched on the raw string).
  if (!resolvedStaysInSpecRoot(abs, ctx.worktreePath, matchedGlobs)) return false;
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return false;
  }
  const matches = headingSlugs(content).filter((s) => s === anchor).length;
  // Exactly one heading matches -> verified. Zero (missing) or many
  // (ambiguous) -> false (fail-closed, deterministic).
  return matches === 1;
}

/**
 * Whether the resolved absolute path stays INSIDE the static-prefix root of at
 * least one of the matched globs. Each glob's spec root is its leading path
 * segments BEFORE the first wildcard segment, resolved against the worktree. A
 * path is in-root iff its worktree-relative form against that root is non-empty,
 * does not start with `..`, and is not itself absolute (fail-closed default: an
 * empty static prefix anchors to the worktree root).
 */
function resolvedStaysInSpecRoot(
  abs: string,
  worktreePath: string,
  matchedGlobs: readonly string[],
): boolean {
  return matchedGlobs.some((g) => {
    const root = resolve(worktreePath, globStaticPrefix(g));
    const rel = relative(root, abs);
    return (
      rel.length > 0 &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel)
    );
  });
}

/**
 * The static (wildcard-free) leading directory prefix of a glob. Segments are
 * scanned until the first one containing a glob magic character
 * (`*?[]{}!+@()`); everything before it is the literal root. `docs/specs/**\/*.md`
 * -> `docs/specs`; `docs/specs/+(..)/x.md` -> `docs/specs`; `**\/*.md` -> "".
 */
function globStaticPrefix(glob: string): string {
  const segments = glob.split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[\]{}!+@()]/.test(segment)) break;
    literal.push(segment);
  }
  // Drop a trailing literal FILE segment (it is not a directory prefix). A
  // segment is a file only when it is the LAST glob segment and contains a dot;
  // for prefix purposes we keep directory segments only.
  if (literal.length === segments.length && literal.length > 0) {
    // Whole glob is literal (no wildcard): the last segment is the file itself.
    literal.pop();
  }
  return literal.join("/");
}

/** Extract the GitHub-style slug of every ATX heading line in the markdown. */
function headingSlugs(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m !== null && m[2] !== undefined) out.push(slugify(m[2]));
  }
  return out;
}

/** Deterministic GitHub-style heading slug. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * Policy-citation grammar (deterministic): a `policy` citation is verified iff
 * it EITHER names an existing domain key in `compiledPolicy.repo.domains`, OR is
 * string-equal to a glob present in any domain's `read`/`write`/`deny_write`
 * list. Zero match -> false. (Pure structural lookup — no glob evaluation, so
 * the same citation+policy always yields the same result.)
 */
function verifyPolicy(ev: RawJuryEvidence, ctx: EvidenceCheckContext): boolean {
  const domains = ctx.compiledPolicy.repo.domains;
  const citation = ev.citation;
  if (Object.prototype.hasOwnProperty.call(domains, citation)) return true;
  for (const domain of Object.values(domains)) {
    if (
      domain.read.includes(citation) ||
      domain.write.includes(citation) ||
      domain.deny_write.includes(citation)
    ) {
      return true;
    }
  }
  return false;
}
