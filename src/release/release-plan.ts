/**
 * Deterministic release-readiness + compatibility analysis (issue: agent-driven
 * version-up). This is the PURE core: given facts gathered from git + the repo
 * (see `release-git.ts`), it computes the recommended SemVer bump and a
 * compatibility report. It complements release-please (which owns the mechanical
 * version bump / CHANGELOG / tag) by surfacing what release-please cannot see:
 * the DB schema delta (no-downgrade impact) and removed/renamed CLI / MCP
 * surface — i.e. the deterministic answer to "what compatibility broke?".
 */

export type SemverBump = "major" | "minor" | "patch" | "none";

export interface ParsedCommit {
  sha: string;
  type: string | null;
  scope: string | null;
  breaking: boolean;
  subject: string;
}

export interface MigrationMeta {
  version: number;
  name: string;
  /** true when the migration only adds (ALTER ADD COLUMN / CREATE) — no DROP /
   * DELETE / table rebuild. A non-additive migration is flagged for review. */
  additive: boolean;
}

export interface SurfaceDiff {
  added: string[];
  removed: string[];
}

export interface SchemaCompat {
  fromVersion: number | null;
  toVersion: number;
  changed: boolean;
  newMigrations: MigrationMeta[];
  /** any non-additive migration in the range (possible data impact) */
  destructive: boolean;
  /** a newer DB is rejected by an older harness — i.e. no downgrade past here */
  noDowngrade: boolean;
}

export interface ReleasePlanInput {
  since: string;
  to: string;
  currentVersion: string;
  commits: ParsedCommit[];
  schema: SchemaCompat;
  mcpTools: SurfaceDiff;
  cliCommands: SurfaceDiff;
  /** gather-time caveats (e.g. a surface file was unreadable so a diff was
   * skipped) — surfaced so the analysis never silently looks complete. */
  warnings?: string[];
}

export interface ReleasePlan extends ReleasePlanInput {
  commitsByType: Record<string, number>;
  breakingCommits: ParsedCommit[];
  recommendedBump: SemverBump;
  recommendedVersion: string | null;
  /** human-readable warnings: a compat break with no `feat!` / BREAKING marker */
  undeclaredBreaking: string[];
  /** human-readable compatibility caveats to carry into the release notes */
  compatibilityNotes: string[];
  /** gather-time analysis caveats (incomplete data — treat the result as partial) */
  analysisWarnings: string[];
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Apply a bump to a semver string, honoring 0.x semantics at the call site. */
export function applyBump(version: string, bump: SemverBump): string | null {
  const parsed = parseSemver(version);
  if (parsed === null) return null;
  const [major, minor, patch] = parsed;
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "none":
      return `${major}.${minor}.${patch}`;
  }
}

export function buildReleasePlan(input: ReleasePlanInput): ReleasePlan {
  const commitsByType: Record<string, number> = {};
  for (const c of input.commits) {
    const key = c.type ?? "other";
    commitsByType[key] = (commitsByType[key] ?? 0) + 1;
  }
  const breakingCommits = input.commits.filter((c) => c.breaking);

  // A compat break the analyzer detects from the actual surfaces — independent
  // of whether a commit declared it.
  const detectedBreaking =
    input.schema.destructive ||
    input.mcpTools.removed.length > 0 ||
    input.cliCommands.removed.length > 0;

  const hasBreaking = breakingCommits.length > 0 || detectedBreaking;
  const hasFeat = (commitsByType.feat ?? 0) > 0;
  const hasFix = (commitsByType.fix ?? 0) > 0 || (commitsByType.perf ?? 0) > 0;

  const parsed = parseSemver(input.currentVersion);
  const isZeroVer = parsed !== null && parsed[0] === 0;

  let recommendedBump: SemverBump;
  if (hasBreaking) {
    // SemVer: breaking → major; but in 0.x a breaking change is a MINOR bump
    // (the 0.x "anything may change" rule — matches release-please's node type).
    recommendedBump = isZeroVer ? "minor" : "major";
  } else if (hasFeat) {
    recommendedBump = "minor";
  } else if (hasFix) {
    recommendedBump = "patch";
  } else {
    recommendedBump = "none";
  }

  const recommendedVersion =
    recommendedBump === "none"
      ? input.currentVersion
      : applyBump(input.currentVersion, recommendedBump);

  const undeclaredBreaking: string[] = [];
  if (detectedBreaking && breakingCommits.length === 0) {
    if (input.mcpTools.removed.length > 0) {
      undeclaredBreaking.push(
        `removed MCP tool(s) with no \`feat!\` / BREAKING CHANGE marker: ${input.mcpTools.removed.join(", ")}`,
      );
    }
    if (input.cliCommands.removed.length > 0) {
      undeclaredBreaking.push(
        `removed CLI command token(s) with no \`feat!\` / BREAKING CHANGE marker: ${input.cliCommands.removed.join(", ")}`,
      );
    }
    if (input.schema.destructive) {
      const names = input.schema.newMigrations
        .filter((m) => !m.additive)
        .map((m) => `v${m.version} ${m.name}`)
        .join(", ");
      undeclaredBreaking.push(
        `non-additive DB migration(s) with no BREAKING marker (review data impact): ${names}`,
      );
    }
  }

  const compatibilityNotes: string[] = [];
  if (input.schema.changed) {
    compatibilityNotes.push(
      `DB schema ${input.schema.fromVersion ?? "?"} → ${input.schema.toVersion}` +
        ` (migrations: ${input.schema.newMigrations.map((m) => `v${m.version}`).join(", ") || "none"}).` +
        " A new harness auto-migrates an older DB, but an OLDER harness rejects a" +
        " migrated DB (no downgrade) — back up `.harness/harness.sqlite` before upgrading.",
    );
  }
  if (input.mcpTools.added.length > 0) {
    compatibilityNotes.push(`new MCP tools: ${input.mcpTools.added.join(", ")}`);
  }
  if (input.cliCommands.added.length > 0) {
    compatibilityNotes.push(
      `new CLI command token(s): ${input.cliCommands.added.join(", ")}`,
    );
  }

  return {
    ...input,
    commitsByType,
    breakingCommits,
    recommendedBump,
    recommendedVersion,
    undeclaredBreaking,
    compatibilityNotes,
    analysisWarnings: input.warnings ?? [],
  };
}

/** Render a release plan as a human-readable report. */
export function renderReleasePlanText(plan: ReleasePlan): string {
  const lines: string[] = [];
  lines.push(`release plan: ${plan.since}..${plan.to} (current ${plan.currentVersion})`);
  const versionTarget =
    plan.recommendedVersion === null
      ? " → n/a (current version is not SemVer)"
      : ` → ${plan.recommendedVersion}`;
  lines.push(
    `recommended bump: ${plan.recommendedBump}` +
      (plan.recommendedBump === "none"
        ? " (nothing release-worthy since the last tag)"
        : versionTarget),
  );
  if (plan.analysisWarnings.length > 0) {
    lines.push("");
    lines.push("⚠ analysis incomplete (treat as partial):");
    for (const w of plan.analysisWarnings) lines.push(`  - ${w}`);
  }
  lines.push("");
  const byType = Object.entries(plan.commitsByType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}:${n}`)
    .join("  ");
  lines.push(`commits: ${plan.commits.length}${byType ? `  (${byType})` : ""}`);
  if (plan.breakingCommits.length > 0) {
    lines.push(`breaking commits (marked): ${plan.breakingCommits.length}`);
    for (const c of plan.breakingCommits) {
      lines.push(`  - ${c.sha.slice(0, 8)} ${c.subject}`);
    }
  }
  lines.push("");
  lines.push("compatibility:");
  const s = plan.schema;
  if (s.changed) {
    const migs =
      s.newMigrations
        .map((m) => `v${m.version} ${m.name}${m.additive ? "" : " [non-additive]"}`)
        .join(", ") || "none";
    lines.push(`  schema: ${s.fromVersion ?? "?"} → ${s.toVersion}  (${migs})`);
    lines.push(`          no downgrade past this point${s.destructive ? "; NON-ADDITIVE migration — review data impact" : ""}`);
  } else {
    lines.push(`  schema: unchanged (v${s.toVersion})`);
  }
  lines.push(`  MCP tools:    +${plan.mcpTools.added.length} / -${plan.mcpTools.removed.length}` +
    surfaceDetail(plan.mcpTools));
  lines.push(`  CLI commands: +${plan.cliCommands.added.length} / -${plan.cliCommands.removed.length}` +
    surfaceDetail(plan.cliCommands));

  if (plan.undeclaredBreaking.length > 0) {
    lines.push("");
    lines.push("⚠ UNDECLARED breaking change(s) — no `feat!` / BREAKING marker:");
    for (const w of plan.undeclaredBreaking) lines.push(`  - ${w}`);
  }
  if (plan.compatibilityNotes.length > 0) {
    lines.push("");
    lines.push("release / upgrade notes:");
    for (const n of plan.compatibilityNotes) lines.push(`  - ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

function surfaceDetail(d: SurfaceDiff): string {
  const parts: string[] = [];
  if (d.added.length > 0) parts.push(`+[${d.added.join(", ")}]`);
  if (d.removed.length > 0) parts.push(`-[${d.removed.join(", ")}]`);
  return parts.length > 0 ? `  ${parts.join(" ")}` : "";
}

/** Parse a Conventional Commit subject (+ optional body) into a ParsedCommit. */
export function parseConventionalCommit(
  sha: string,
  subject: string,
  body = "",
): ParsedCommit {
  const m = /^([a-z]+)(\(([^)]+)\))?(!)?:\s*(.*)$/.exec(subject);
  if (m === null) {
    return { sha, type: null, scope: null, breaking: false, subject };
  }
  const bangBreaking = m[4] === "!";
  const bodyBreaking = /(^|\n)BREAKING CHANGE:/.test(body);
  return {
    sha,
    type: m[1] ?? null,
    scope: m[3] ?? null,
    breaking: bangBreaking || bodyBreaking,
    subject: m[5] ?? subject,
  };
}
