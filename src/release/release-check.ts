import type { ReleasePlan } from "./release-plan.js";

/**
 * `harness release check` — the fail-closed release-readiness GATE (issue:
 * agent-driven version-up). Where `release plan` *reports*, `release check`
 * *decides*: it returns a pass/fail verdict an agent / CI runs BEFORE merging
 * the release PR. It complements CI (which owns typecheck/build/test) by
 * asserting the release-specific preconditions release-please cannot: the plan
 * is clean, the version metadata is consistent, the changed surface is
 * documented (spec-driven), and the tree is clean.
 */

export interface ReleaseCheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ReleaseCheckReport {
  checks: ReleaseCheckResult[];
  ok: boolean;
}

export interface ReleaseCheckInput {
  plan: ReleasePlan;
  /** package.json version, or null when it is missing / unreadable */
  packageVersion: string | null;
  manifestVersion: string | null;
  /** git working tree clean (no uncommitted changes) */
  treeClean: boolean;
  /** spec file contents (or "" when absent) used for the spec-sync check */
  specs: { mcp: string; db: string; cli: string };
}

/**
 * Whether `token` appears in `haystack` as a standalone identifier — NOT as part
 * of a longer name. `nameChars` is the identifier alphabet for that surface, so
 * e.g. `harness.b` is not "documented" by `harness.b.extra` (`.` is a name char)
 * and `list` is not matched inside `listing` / `foo-list` (CLI name chars).
 * (CLI tokens are short, so a match in unrelated prose is still possible — the
 * CLI spec-sync check is best-effort; MCP names are dotted + unique → reliable.)
 */
function mentionsName(haystack: string, token: string, nameChars: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![${nameChars}])${escaped}(?![${nameChars}])`).test(haystack);
}

const MCP_NAME_CHARS = "A-Za-z0-9_.";
const CLI_NAME_CHARS = "A-Za-z0-9_-";
const SCHEMA_NAME_CHARS = "A-Za-z0-9_";

export function buildReleaseCheck(input: ReleaseCheckInput): ReleaseCheckReport {
  const { plan } = input;
  const checks: ReleaseCheckResult[] = [];

  // 1. plan-clean — no undeclared breaking change, no incomplete analysis
  //    (the `release plan` exit-2 conditions).
  const planIssues = [...plan.undeclaredBreaking, ...plan.analysisWarnings];
  checks.push({
    name: "plan-clean",
    pass: planIssues.length === 0,
    detail:
      planIssues.length === 0
        ? "no undeclared breaking change / incomplete analysis"
        : planIssues.join("; "),
  });

  // 2. version-consistency — package.json matches the release-please manifest.
  //    A missing/unreadable package version fails explicitly (never a false pass
  //    against a coincidentally-equal manifest).
  const versionMatch =
    input.packageVersion !== null &&
    input.manifestVersion !== null &&
    input.packageVersion === input.manifestVersion;
  checks.push({
    name: "version-consistency",
    pass: versionMatch,
    detail: versionMatch
      ? `package.json and manifest agree (${input.packageVersion})`
      : input.packageVersion === null
        ? "package.json version is missing / unreadable"
        : `package.json ${input.packageVersion} != manifest ${input.manifestVersion ?? "missing"}`,
  });

  // 3. spec-sync — the changed surface is documented (spec-driven discipline):
  //    every ADDED MCP tool is named in mcp.md, an ADDED CLI command token in
  //    cli.md, and a schema bump's target version in db.md. Matching is
  //    identifier-boundary aware so a longer name does not falsely "document" it.
  const missingMcp = plan.mcpTools.added.filter(
    (t) => !mentionsName(input.specs.mcp, t, MCP_NAME_CHARS),
  );
  const missingCli = plan.cliCommands.added.filter(
    (c) => !mentionsName(input.specs.cli, c, CLI_NAME_CHARS),
  );
  const schemaDocOk =
    !plan.schema.changed ||
    mentionsName(input.specs.db, `v${plan.schema.toVersion}`, SCHEMA_NAME_CHARS);
  const specPass = missingMcp.length === 0 && missingCli.length === 0 && schemaDocOk;
  const specDetail: string[] = [];
  if (missingMcp.length > 0) specDetail.push(`MCP tools not in mcp.md: ${missingMcp.join(", ")}`);
  if (missingCli.length > 0) specDetail.push(`CLI tokens not in cli.md: ${missingCli.join(", ")}`);
  if (!schemaDocOk) specDetail.push(`schema v${plan.schema.toVersion} not documented in db.md`);
  checks.push({
    name: "spec-sync",
    pass: specPass,
    detail: specPass ? "changed surface is documented" : specDetail.join("; "),
  });

  // 4. clean-tree — no uncommitted changes.
  checks.push({
    name: "clean-tree",
    pass: input.treeClean,
    detail: input.treeClean ? "working tree clean" : "uncommitted changes present",
  });

  return { checks, ok: checks.every((c) => c.pass) };
}

/** Render a check report as a human-readable, fail-closed summary. */
export function renderReleaseCheckText(report: ReleaseCheckReport): string {
  const lines = report.checks.map(
    (c) => `  ${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`,
  );
  lines.unshift(
    `release check: ${report.ok ? "PASS — ready to release" : "FAIL — not ready"}`,
  );
  lines.push("");
  return lines.join("\n");
}
