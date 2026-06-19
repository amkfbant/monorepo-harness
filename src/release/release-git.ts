import { gitCli } from "../git/git-cli.js";
import {
  parseConventionalCommit,
  type MigrationMeta,
  type ReleasePlanInput,
  type SchemaCompat,
  type SurfaceDiff,
} from "./release-plan.js";

/**
 * Git/repo accessor for the release analyzer. Injectable so the gather logic
 * (ref resolution, surface parsing) is unit-testable with fixtures.
 */
export interface GitReader {
  /** Most recent tag reachable from HEAD, or null. */
  lastTag(): Promise<string | null>;
  /** Resolve a ref to a sha, or null when it does not exist. */
  resolveRef(ref: string): Promise<string | null>;
  /** Contents of `path` at `ref`, or null when absent at that ref. */
  fileAtRef(ref: string, path: string): Promise<string | null>;
  /** Non-merge commits in `since..to`, newest first. */
  logCommits(
    since: string,
    to: string,
  ): Promise<{ sha: string; subject: string; body: string }[]>;
}

// Field / record separators for `git log --format` (NUL + RS — never appear in
// commit text), so subjects/bodies cannot break the parse.
const NUL = String.fromCharCode(31);
const REC = String.fromCharCode(30);

/** A real GitReader backed by the `git` CLI in `cwd`. */
export function createGitReader(cwd: string): GitReader {
  const run = async (args: string[]): Promise<{ ok: boolean; out: string }> => {
    const r = await gitCli(args, { cwd, timeoutMs: 15_000 });
    return { ok: r.exitCode === 0 && !r.timedOut, out: r.stdout };
  };
  return {
    async lastTag() {
      const r = await run(["describe", "--tags", "--abbrev=0"]);
      return r.ok && r.out.trim() !== "" ? r.out.trim() : null;
    },
    async resolveRef(ref) {
      const r = await run([
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ]);
      return r.ok && r.out.trim() !== "" ? r.out.trim() : null;
    },
    async fileAtRef(ref, path) {
      const r = await run(["show", `${ref}:${path}`]);
      return r.ok ? r.out : null;
    },
    async logCommits(since, to) {
      const r = await run([
        "log",
        `${since}..${to}`,
        "--no-merges",
        `--format=%H${NUL}%s${NUL}%b${REC}`,
      ]);
      if (!r.ok) return [];
      return r.out
        .split(REC)
        .map((rec) => rec.replace(/^\n/, ""))
        .filter((rec) => rec.trim() !== "")
        .map((rec) => {
          const [sha = "", subject = "", body = ""] = rec.split(NUL);
          return { sha: sha.trim(), subject, body };
        });
    },
  };
}

const SCHEMA_VERSION_RE = /SCHEMA_VERSION\s*=\s*(\d+)/;
const MCP_TOOL_RE = /name:\s*"(harness\.[a-z0-9_.]+)"/g;
const CLI_COMMAND_RE = /\.command\(\s*"([a-z][a-z0-9_-]*)"/g;

function parseSchemaVersion(content: string | null): number | null {
  if (content === null) return null;
  const m = SCHEMA_VERSION_RE.exec(content);
  return m ? Number(m[1]) : null;
}

function matchAll(content: string | null, re: RegExp): Set<string> {
  const out = new Set<string>();
  if (content === null) return out;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return out;
}

function diffSurface(from: Set<string>, to: Set<string>): SurfaceDiff {
  return {
    added: [...to].filter((x) => !from.has(x)).sort(),
    removed: [...from].filter((x) => !to.has(x)).sort(),
  };
}

/**
 * A migration is "additive" when it has no destructive / rebuild statement —
 * any `DROP TABLE/COLUMN`, `DELETE FROM`, or `RENAME` (table OR column rename, or
 * a table-rebuild `RENAME TO`). A non-additive migration is flagged for review.
 */
export function isAdditiveMigration(statements: readonly string[]): boolean {
  return !statements.some((s) =>
    /\bDROP\s+(TABLE|COLUMN)\b|\bDELETE\s+FROM\b|\bRENAME\b/i.test(s),
  );
}

export interface MigrationDef {
  version: number;
  name: string;
  statements: readonly string[];
}

export interface GatherOpts {
  migrations: readonly MigrationDef[];
  currentVersion: string;
  /** default: the last tag */
  since?: string;
  /** default: HEAD */
  to?: string;
}

const SCHEMA_PATH = "src/db/schema.ts";
const MCP_REGISTRY_PATH = "src/mcp/registry/tool-registry.ts";
// CLI commands are registered across run.ts plus the per-domain modules
// (`registerXCommands`), so all must be scanned — otherwise a removal in e.g.
// db.ts / hitch.ts is invisible.
// 露出: CLI surface を持つ全ファイルを列挙できているかを meta-test
// (tests/unit/release/cli-paths-coverage.test.ts) が検証するため export する。
// course.ts / onboard.ts は register*Commands を持つ per-domain モジュールだが
// 旧来この一覧から漏れており、両者の command 削除が release の breaking 検知を
// すり抜けていた（coverage gap の修正）。標準の最新タグ起点（例 v0.7.17..HEAD）では
// 両ファイルが `since`/`to` 双方に既存のため surface diff は不変（+0/-0）。ただし
// course/onboard の command 構成が異なる古い/任意の since..to では、追加した両ファイル
// 分だけ surface 比較対象が増えるため diff 結果が変わり得る（=これらの正しい検知に
// なる）。すなわち「全範囲で挙動不変」ではなく、欠けていた検知対象を補う変更である。
export const CLI_PATHS: readonly string[] = [
  "src/cli/run.ts",
  "src/cli/project.ts",
  "src/cli/policy.ts",
  "src/cli/db.ts",
  "src/cli/hitch.ts",
  "src/cli/course.ts",
  "src/cli/onboard.ts",
  "src/cli/lock.ts",
  "src/cli/inbox.ts",
  "src/cli/operations.ts",
  "src/cli/dashboard.ts",
  "src/cli/release.ts",
  "src/cli/rerun.ts",
  "src/cli/diagnostics.ts",
  "src/cli/review.ts",
  "src/cli/knowledge.ts",
  "src/mcp/cli.ts",
];

export class ReleaseGatherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseGatherError";
  }
}

/**
 * Gather every fact the analyzer needs from git + the repo. The `since` ref
 * defaults to the last tag; `to` defaults to HEAD. Throws when a ref cannot be
 * resolved so the caller can guide the operator.
 */
export async function gatherReleasePlanInput(
  reader: GitReader,
  opts: GatherOpts,
): Promise<ReleasePlanInput> {
  const to = opts.to ?? "HEAD";
  const since = opts.since ?? (await reader.lastTag());
  if (since === null) {
    throw new ReleaseGatherError(
      "no `since` ref: the repo has no tags yet — pass --since <ref>",
    );
  }
  if ((await reader.resolveRef(since)) === null) {
    throw new ReleaseGatherError(`cannot resolve --since ref: ${since}`);
  }
  if ((await reader.resolveRef(to)) === null) {
    throw new ReleaseGatherError(`cannot resolve --to ref: ${to}`);
  }

  const warnings: string[] = [];

  // Schema is the critical compat signal — the `to` (target) ref MUST yield a
  // parseable SCHEMA_VERSION (fail closed; never silently "unchanged v0").
  const toSchemaSrc = await reader.fileAtRef(to, SCHEMA_PATH);
  if (toSchemaSrc === null) {
    throw new ReleaseGatherError(
      `cannot read ${SCHEMA_PATH} at ${to} (moved file or bad ref?) — refusing to guess schema compat`,
    );
  }
  const toSchema = parseSchemaVersion(toSchemaSrc);
  if (toSchema === null) {
    throw new ReleaseGatherError(`cannot parse SCHEMA_VERSION in ${SCHEMA_PATH} at ${to}`);
  }
  // `since` may predate schema.ts (file absent → schema introduced after, v0);
  // but a present-yet-unparseable file is a hard error.
  const fromSchemaSrc = await reader.fileAtRef(since, SCHEMA_PATH);
  let fromSchema: number;
  if (fromSchemaSrc === null) {
    fromSchema = 0;
  } else {
    const parsed = parseSchemaVersion(fromSchemaSrc);
    if (parsed === null) {
      throw new ReleaseGatherError(`cannot parse SCHEMA_VERSION in ${SCHEMA_PATH} at ${since}`);
    }
    fromSchema = parsed;
  }
  const schema = buildSchemaCompat(fromSchema, toSchema, opts.migrations);
  if (schema.changed) {
    const expected = schema.toVersion - (schema.fromVersion ?? 0);
    if (schema.newMigrations.length < expected) {
      warnings.push(
        `migration metadata incomplete: expected ${expected} migration(s) for ` +
          `v${(schema.fromVersion ?? 0) + 1}..v${schema.toVersion}, found ` +
          `${schema.newMigrations.length} in MIGRATIONS`,
      );
    }
  }

  // Surface diffs: if the `to` file is unreadable (moved/renamed), SKIP the diff
  // (do not report every tool/command as "removed" → false breaking) and warn.
  const mcpTools = await surfaceDiffAtRefs(
    reader, since, to, MCP_REGISTRY_PATH, MCP_TOOL_RE, "MCP tool", warnings,
  );
  const cliCommands = await surfaceDiffMulti(
    reader, since, to, CLI_PATHS, CLI_COMMAND_RE, "CLI command", warnings,
  );

  const commits = (await reader.logCommits(since, to)).map((c) =>
    parseConventionalCommit(c.sha, c.subject, c.body),
  );

  return {
    since,
    to,
    currentVersion: opts.currentVersion,
    commits,
    schema,
    mcpTools,
    cliCommands,
    warnings,
  };
}

async function surfaceDiffAtRefs(
  reader: GitReader,
  since: string,
  to: string,
  path: string,
  re: RegExp,
  label: string,
  warnings: string[],
): Promise<SurfaceDiff> {
  const toSrc = await reader.fileAtRef(to, path);
  const fromSrc = await reader.fileAtRef(since, path);
  if (toSrc === null) {
    // A file present at `since` but gone at `to` = moved/deleted → the diff is
    // incomplete (a real removal could hide here): warn (fail-closed signal). A
    // file absent at BOTH refs is simply not-applicable → silent.
    if (fromSrc !== null) {
      warnings.push(`${path} present at ${since} but unreadable at ${to}; ${label} diff partial`);
    }
    return { added: [], removed: [] };
  }
  return diffSurface(matchAll(fromSrc, re), matchAll(toSrc, re));
}

/**
 * Diff the surface over the UNION of tokens across several files. A token is
 * "removed" only when it is absent from EVERY readable `to` file (so a token
 * that merely moved between files, or is shared, is not a false removal). A file
 * whose `to` content is unreadable contributes nothing to either side + warns
 * (so a moved file never looks like a removal — the diff is just marked partial).
 */
async function surfaceDiffMulti(
  reader: GitReader,
  since: string,
  to: string,
  paths: readonly string[],
  re: RegExp,
  label: string,
  warnings: string[],
): Promise<SurfaceDiff> {
  const fromUnion = new Set<string>();
  const toUnion = new Set<string>();
  for (const p of paths) {
    const toSrc = await reader.fileAtRef(to, p);
    const fromSrc = await reader.fileAtRef(since, p);
    if (toSrc === null) {
      // present at `since` but gone at `to` = moved/deleted → partial (warn);
      // absent at both = not-applicable (silent).
      if (fromSrc !== null) {
        warnings.push(`${p} present at ${since} but unreadable at ${to}; ${label} diff partial`);
      }
      continue;
    }
    for (const x of matchAll(fromSrc, re)) fromUnion.add(x);
    for (const x of matchAll(toSrc, re)) toUnion.add(x);
  }
  return diffSurface(fromUnion, toUnion);
}

function buildSchemaCompat(
  fromVersion: number | null,
  toVersion: number | null,
  migrations: readonly MigrationDef[],
): SchemaCompat {
  const toV = toVersion ?? 0;
  const fromV = fromVersion;
  const changed = fromV !== null && toV > fromV;
  const newMigrations: MigrationMeta[] = changed
    ? migrations
        .filter((m) => m.version > (fromV as number) && m.version <= toV)
        .map((m) => ({
          version: m.version,
          name: m.name,
          additive: isAdditiveMigration(m.statements),
        }))
        .sort((a, b) => a.version - b.version)
    : [];
  return {
    fromVersion: fromV,
    toVersion: toV,
    changed,
    newMigrations,
    destructive: newMigrations.some((m) => !m.additive),
    noDowngrade: changed,
  };
}
