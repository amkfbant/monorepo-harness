import { basename } from "node:path";
import { minimatch } from "minimatch";
import { isValidDomainId } from "./schema.js";
import type { DomainKind, PackageManager } from "./schema.js";
import type { RepoSignals, DirSignal } from "./repo-signals.js";
import type { DomainRegistry, RegistryPattern } from "./domain-registry.js";

/**
 * Project inspector (Phase 5-3).
 *
 * `inspectProject` matches a domain registry against static repo signals
 * and proposes candidate domains. It runs no Codex and no commands; output
 * is deterministically ordered so it can be diffed in CI.
 */

export type Confidence = "high" | "medium" | "low";

export interface DomainCandidate {
  id: string;
  root: string;
  kind: DomainKind;
  confidence: Confidence;
  /** human-readable signals that produced this candidate */
  signals: string[];
  suggestedPolicyTemplate: string | null;
  suggestedCommandPresets: string[];
  suggestedContextPacks: string[];
}

export interface InspectResult {
  repoPath: string;
  registryId: string;
  isGitRepo: boolean;
  packageManager: PackageManager;
  hasWorkspaces: boolean;
  languages: string[];
  candidates: DomainCandidate[];
  warnings: string[];
}

export function inspectProject(
  signals: RepoSignals,
  registry: DomainRegistry,
): InspectResult {
  const byId = new Map<string, DomainCandidate>();
  for (const pattern of registry.patterns) {
    for (const dir of signals.directories) {
      if (!minimatch(dir.path, pattern.root_glob)) continue;
      const id = pattern.id_template.replace("{name}", basename(dir.path));
      // a weird directory name could yield an unsafe id — drop it.
      if (!isValidDomainId(id)) continue;
      // first registry pattern to claim an id wins (patterns are ordered).
      if (byId.has(id)) continue;
      byId.set(id, buildCandidate(id, dir, pattern, registry));
    }
  }
  const candidates = [...byId.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  return {
    repoPath: signals.repoPath,
    registryId: registry.registry_id,
    isGitRepo: signals.isGitRepo,
    packageManager: signals.packageManager,
    hasWorkspaces: signals.hasWorkspaces,
    languages: signals.languages,
    candidates,
    warnings: buildWarnings(signals, candidates),
  };
}

function buildCandidate(
  id: string,
  dir: DirSignal,
  pattern: RegistryPattern,
  registry: DomainRegistry,
): DomainCandidate {
  const signals: string[] = [`directory:${pattern.root_glob}`];
  if (dir.hasPackageJson) signals.push("package.json");
  if (dir.hasPyproject) signals.push("pyproject.toml");
  if (dir.scripts.length > 0) {
    signals.push(`scripts:${dir.scripts.slice(0, 4).join(",")}`);
  }
  // a manifest (or a docs domain, which never has one) is a strong signal.
  const confidence: Confidence =
    dir.hasPackageJson || dir.hasPyproject || pattern.kind === "docs"
      ? "high"
      : "medium";
  return {
    id,
    root: dir.path,
    kind: pattern.kind,
    confidence,
    signals,
    suggestedPolicyTemplate: registry.suggested_policy_template ?? null,
    suggestedCommandPresets: [...pattern.command_presets],
    suggestedContextPacks: [...pattern.context_packs],
  };
}

function buildWarnings(
  signals: RepoSignals,
  candidates: DomainCandidate[],
): string[] {
  const warnings: string[] = [];
  if (!signals.isGitRepo) {
    warnings.push("target is not a git repository");
  }
  if (signals.truncated) {
    warnings.push(
      "directory scan was truncated (very large repo) — some domains may be missing",
    );
  }
  if (candidates.length === 0) {
    warnings.push(
      "no candidate domains matched the registry — try a different --registry",
    );
  }
  if (
    signals.languages.includes("javascript") &&
    signals.packageManager === "unknown"
  ) {
    warnings.push(
      "Node repo with no lockfile — package manager is unknown, so package_script commands may not resolve",
    );
  }
  // a candidate using a node command preset needs a usable package manager.
  const usesNodePreset = candidates.some((c) =>
    c.suggestedCommandPresets.some((p) => p.startsWith("node-")),
  );
  if (usesNodePreset && signals.rootScripts.length === 0) {
    warnings.push(
      "root package.json declares no scripts; verify each domain package declares its own",
    );
  }
  return warnings;
}

export function formatInspectJson(result: InspectResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function formatInspectText(result: InspectResult): string {
  const lines: string[] = [];
  lines.push(`Project inspect: ${result.repoPath}`);
  lines.push(`registry: ${result.registryId}`);
  lines.push(`gitRepo: ${result.isGitRepo ? "yes" : "no"}`);
  lines.push(`packageManager: ${result.packageManager}`);
  lines.push(`workspaces: ${result.hasWorkspaces ? "yes" : "no"}`);
  lines.push(
    `languages: ${result.languages.length > 0 ? result.languages.join(", ") : "(none detected)"}`,
  );
  lines.push("");
  lines.push("candidate domains:");
  if (result.candidates.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of result.candidates) {
      lines.push(
        `  ${c.id}  kind=${c.kind}  confidence=${c.confidence}  signals=${c.signals.join(",")}`,
      );
    }
  }
  lines.push("");
  lines.push("warnings:");
  if (result.warnings.length === 0) {
    lines.push("  (none)");
  } else {
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  lines.push("");
  return lines.join("\n");
}
