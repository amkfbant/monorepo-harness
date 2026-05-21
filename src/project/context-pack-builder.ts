import { readFile, readdir, lstat } from "node:fs/promises";
import { join, basename } from "node:path";
import { minimatch } from "minimatch";
import { scanForSecrets, SCAN_SAMPLE_BYTES } from "../reporter/secret-scan.js";
import type { NormalizedContextPack } from "./context-pack-spec.js";

/**
 * Context pack builder (Phase 5-6).
 *
 * Resolves a context pack's globs against a repo, reads the matched files
 * (no Codex, no symlink following), and applies the pack's secret /
 * binary / byte-cap rules. Used by `project check` to validate a pack and
 * by the runtime (Phase 5-7) to assemble prompt context.
 */

const IGNORE_DIRS = new Set([
  ".git",
  ".github",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);
const MAX_WALK_FILES = 20000;
const MAX_WALK_DIRS = 20000;
const MATCH_OPTS = { dot: true, nocomment: true } as const;

export interface ContextPackFile {
  /** repo-relative path */
  path: string;
  bytes: number;
  /** true → safe to inject; false → redacted / skipped */
  included: boolean;
  /** UTF-8 content, present only for an included text file */
  content?: string;
  /** why the file was excluded, when `included` is false */
  excludedReason?: string;
}

export interface ContextPackFinding {
  level: "error" | "warn";
  message: string;
}

export interface ContextPackBuildResult {
  packId: string;
  files: ContextPackFile[];
  /** total bytes of the included files */
  includedBytes: number;
  findings: ContextPackFinding[];
}

export async function buildContextPack(
  repoPath: string,
  pack: NormalizedContextPack,
): Promise<ContextPackBuildResult> {
  const findings: ContextPackFinding[] = [];
  const walk = await listRepoFiles(repoPath);
  if (walk.truncated) {
    findings.push({
      level: "warn",
      message: `context pack ${pack.id}: repo walk was truncated (very large repo) — some files may be missing`,
    });
  }

  // match files per glob; record globs that matched nothing.
  const matched = new Set<string>();
  for (const glob of pack.globs) {
    const hits = walk.files.filter((f) => minimatch(f, glob, MATCH_OPTS));
    if (hits.length === 0 && pack.missing !== "ignore") {
      findings.push({
        level: pack.missing === "error" ? "error" : "warn",
        message: `context pack ${pack.id}: glob "${glob}" matched no file`,
      });
    }
    for (const h of hits) matched.add(h);
  }

  const files: ContextPackFile[] = [];
  let includedBytes = 0;
  let capReached = false;

  for (const rel of [...matched].sort()) {
    const abs = join(repoPath, rel);
    let size: number;
    try {
      const st = await lstat(abs);
      if (!st.isFile()) {
        files.push({
          path: rel,
          bytes: 0,
          included: false,
          excludedReason: "not a regular file",
        });
        continue;
      }
      size = st.size;
    } catch {
      files.push({
        path: rel,
        bytes: 0,
        included: false,
        excludedReason: "unreadable (lstat failed)",
      });
      findings.push({
        level: "warn",
        message: `context pack ${pack.id}: ${rel} could not be stat'd — skipped`,
      });
      continue;
    }

    // cap checks BEFORE reading, so total bytes read stays bounded.
    if (size > pack.maxBytes) {
      files.push({
        path: rel,
        bytes: size,
        included: false,
        excludedReason: `file exceeds the pack byte cap (${size} > ${pack.maxBytes})`,
      });
      findings.push({
        level: "warn",
        message: `context pack ${pack.id}: ${rel} exceeds max_bytes — skipped`,
      });
      continue;
    }
    if (includedBytes + size > pack.maxBytes) {
      files.push({
        path: rel,
        bytes: size,
        included: false,
        excludedReason: "pack byte cap reached",
      });
      if (!capReached) {
        capReached = true;
        findings.push({
          level: "warn",
          message: `context pack ${pack.id}: byte cap (${pack.maxBytes}) reached — later files skipped`,
        });
      }
      continue;
    }

    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      files.push({
        path: rel,
        bytes: size,
        included: false,
        excludedReason: "unreadable",
      });
      findings.push({
        level: "warn",
        message: `context pack ${pack.id}: ${rel} could not be read — skipped`,
      });
      continue;
    }
    const sample = buf.subarray(0, SCAN_SAMPLE_BYTES);
    if (sample.includes(0)) {
      files.push({
        path: rel,
        bytes: size,
        included: false,
        excludedReason: "binary file",
      });
      if (pack.binary === "error") {
        findings.push({
          level: "error",
          message: `context pack ${pack.id}: ${rel} is a binary file`,
        });
      }
      continue;
    }

    const text = buf.toString("utf8");
    if (pack.denySecretLike) {
      const secret = scanForSecrets(
        basename(rel),
        text.slice(0, SCAN_SAMPLE_BYTES),
      );
      if (secret.matched) {
        files.push({
          path: rel,
          bytes: size,
          included: false,
          excludedReason: `secret-shaped (${secret.reasons.join(", ")})`,
        });
        findings.push({
          level: "error",
          message: `context pack ${pack.id}: ${rel} looks secret-shaped (${secret.reasons.join(", ")}) — content withheld`,
        });
        continue;
      }
    }

    includedBytes += size;
    files.push({ path: rel, bytes: size, included: true, content: text });
  }

  return { packId: pack.id, files, includedBytes, findings };
}

interface RepoWalk {
  files: string[];
  truncated: boolean;
}

/** Bounded, symlink-free recursive listing of repo-relative file paths. */
async function listRepoFiles(repoPath: string): Promise<RepoWalk> {
  const out: string[] = [];
  const stack: string[] = [""];
  let dirsVisited = 0;
  let truncated = false;
  while (stack.length > 0) {
    if (out.length >= MAX_WALK_FILES || dirsVisited >= MAX_WALK_DIRS) {
      truncated = true;
      break;
    }
    dirsVisited += 1;
    const rel = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(join(repoPath, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // isFile / isDirectory are false for a symlink dirent — symlinks are
      // therefore skipped, never followed.
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
        if (out.length >= MAX_WALK_FILES) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { files: out, truncated };
}
