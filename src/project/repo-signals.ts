import { readFile, readdir, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager } from "./schema.js";

/** a package.json larger than this is treated as unreadable (DoS guard). */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
/** cap on the total directories scanned, so a huge tree cannot exhaust memory. */
const MAX_SCANNED_DIRS = 400;

/**
 * Static repo inspection signals (Phase 5-3).
 *
 * `scanRepoSignals` reads a target repo's filesystem only — it never runs
 * Codex, git, or allowed commands. It feeds `inspectProject`, which matches
 * a domain registry against these signals.
 */

export interface DirSignal {
  /** repo-relative directory path, e.g. `apps/catalog` or `docs` */
  path: string;
  /** 1 = top-level dir, 2 = a child of a top-level dir */
  depth: number;
  hasPackageJson: boolean;
  hasPyproject: boolean;
  /** `name` from the dir's package.json, when present and valid */
  packageName: string | null;
  /** script names from the dir's package.json */
  scripts: string[];
}

export interface RepoSignals {
  repoPath: string;
  isGitRepo: boolean;
  packageManager: PackageManager;
  hasWorkspaces: boolean;
  /** shallow language detection from root markers */
  languages: string[];
  /** script names from the root package.json */
  rootScripts: string[];
  /** directories at depth 1 and 2, ignoring build/vendor dirs */
  directories: DirSignal[];
  /** true when the directory scan hit MAX_SCANNED_DIRS and stopped early */
  truncated: boolean;
}

// dirs that are never domain roots and must not be descended into.
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

export async function scanRepoSignals(
  repoPath: string,
): Promise<RepoSignals> {
  const rootPkg = await readPackageJson(join(repoPath, "package.json"));
  const scan = await scanDirectories(repoPath);
  return {
    repoPath,
    isGitRepo: existsSync(join(repoPath, ".git")),
    packageManager: detectPackageManager(repoPath, rootPkg !== null),
    hasWorkspaces: detectWorkspaces(repoPath, rootPkg),
    languages: detectLanguages(repoPath),
    rootScripts: rootPkg?.scripts ?? [],
    directories: scan.directories,
    truncated: scan.truncated,
  };
}

function detectPackageManager(
  repoPath: string,
  hasPackageJson: boolean,
): PackageManager {
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "bun.lockb"))) return "bun";
  if (existsSync(join(repoPath, "package-lock.json"))) return "npm";
  // a package.json with no lockfile: it is a Node repo, manager unknown.
  return hasPackageJson ? "unknown" : "none";
}

function detectWorkspaces(
  repoPath: string,
  rootPkg: PackageJsonSignal | null,
): boolean {
  return (
    existsSync(join(repoPath, "pnpm-workspace.yaml")) ||
    existsSync(join(repoPath, "turbo.json")) ||
    existsSync(join(repoPath, "nx.json")) ||
    (rootPkg?.hasWorkspaces ?? false)
  );
}

function detectLanguages(repoPath: string): string[] {
  const langs: string[] = [];
  if (
    existsSync(join(repoPath, "tsconfig.json")) ||
    existsSync(join(repoPath, "tsconfig.base.json"))
  ) {
    langs.push("typescript");
  }
  if (existsSync(join(repoPath, "package.json"))) langs.push("javascript");
  if (
    existsSync(join(repoPath, "pyproject.toml")) ||
    existsSync(join(repoPath, "setup.py")) ||
    existsSync(join(repoPath, "setup.cfg"))
  ) {
    langs.push("python");
  }
  if (existsSync(join(repoPath, "go.mod"))) langs.push("go");
  return langs;
}

async function scanDirectories(
  repoPath: string,
): Promise<{ directories: DirSignal[]; truncated: boolean }> {
  const out: DirSignal[] = [];
  let truncated = false;
  for (const top of await listDirs(repoPath)) {
    if (out.length >= MAX_SCANNED_DIRS) {
      truncated = true;
      break;
    }
    out.push(await dirSignal(repoPath, top, 1));
    for (const child of await listDirs(join(repoPath, top))) {
      if (out.length >= MAX_SCANNED_DIRS) {
        truncated = true;
        break;
      }
      out.push(await dirSignal(repoPath, `${top}/${child}`, 2));
    }
  }
  // deterministic order so inspect output is stable.
  return {
    directories: out.sort((a, b) => a.path.localeCompare(b.path)),
    truncated,
  };
}

async function listDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name))
    .map((e) => e.name);
}

async function dirSignal(
  repoPath: string,
  rel: string,
  depth: number,
): Promise<DirSignal> {
  const abs = join(repoPath, rel);
  const pkg = await readPackageJson(join(abs, "package.json"));
  return {
    path: rel,
    depth,
    hasPackageJson: pkg !== null,
    hasPyproject: existsSync(join(abs, "pyproject.toml")),
    packageName: pkg?.name ?? null,
    scripts: pkg?.scripts ?? [],
  };
}

interface PackageJsonSignal {
  name: string | null;
  scripts: string[];
  hasWorkspaces: boolean;
}

async function readPackageJson(
  path: string,
): Promise<PackageJsonSignal | null> {
  // lstat (not stat) so a symlinked package.json is not followed, and a
  // FIFO / device / oversized file is rejected before any read.
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > MAX_PACKAGE_JSON_BYTES) return null;
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(await readFile(path, "utf8")) as {
      name?: unknown;
      scripts?: unknown;
      workspaces?: unknown;
    };
    const scripts =
      doc.scripts !== null && typeof doc.scripts === "object"
        ? Object.keys(doc.scripts as Record<string, unknown>)
        : [];
    return {
      name: typeof doc.name === "string" ? doc.name : null,
      scripts,
      hasWorkspaces: doc.workspaces !== undefined,
    };
  } catch {
    return null;
  }
}
