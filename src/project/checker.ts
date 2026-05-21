import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { harnessPaths } from "../config/paths.js";
import { RepoPolicySchema } from "../policy/schema.js";
import { resolvePolicy } from "../policy/resolver.js";
import { loadProjectById } from "./profile-resolver.js";
import { ProjectError } from "./errors.js";
import { scanRepoSignals } from "./repo-signals.js";
import {
  loadCompileInputs,
  compileProjectPolicy,
  type CompileInputs,
} from "./policy-compiler.js";
import { gitCli } from "../git/git-cli.js";
import {
  serializeRepoPolicyYaml,
  provenanceSidecarPath,
} from "./policy-proposal.js";
import { parseProvenance, type PolicyProvenance } from "./provenance.js";
import { lintGlobs } from "./glob-linter.js";
import { checkGeneratedCommands } from "./command-checker.js";
import { buildContextPack } from "./context-pack-builder.js";
import {
  normalizeInlineContextPack,
  normalizeContextPackPreset,
  type NormalizedContextPack,
} from "./context-pack-spec.js";
import type { ProjectProfile } from "./schema.js";

/**
 * `project check` engine (Phase 5-6).
 *
 * Validates a project profile without running Codex: schema, repo layout,
 * compiled policy, glob hygiene, command sanity, context packs, and drift
 * of any on-disk generated policy. Every problem is classified ok / warn
 * / error so the result is CI-usable.
 */

export interface CheckItem {
  level: "ok" | "warn" | "error";
  label: string;
  detail?: string;
}

export interface ProjectCheckReport {
  projectId: string;
  status: "ok" | "warn" | "error";
  items: CheckItem[];
}

export interface CheckOptions {
  harnessRoot: string;
  projectId: string;
  repoOverride?: string;
  /** ISO instant for the compile (drift compares content, not this) */
  generatedAt: string;
}

export async function checkProject(
  opts: CheckOptions,
): Promise<ProjectCheckReport> {
  const items: CheckItem[] = [];

  let resolved;
  try {
    resolved = await loadProjectById(opts.harnessRoot, opts.projectId, {
      ...(opts.repoOverride !== undefined
        ? { repoOverride: opts.repoOverride }
        : {}),
    });
  } catch (e) {
    if (e instanceof ProjectError) {
      return finalize(opts.projectId, [
        { level: "error", label: "profile schema", detail: e.message },
      ]);
    }
    throw e;
  }
  const { profile, profilePath, repoPath } = resolved;
  items.push({
    level: "ok",
    label: "profile schema",
    detail: `projects/${opts.projectId}.yaml`,
  });

  const repoUsable = checkRepo(repoPath, items);
  if (repoUsable) {
    await checkBaseBranch(repoPath as string, profile, items);
  }
  items.push({
    level: "ok",
    label: "domains",
    detail: `${profile.domains.length}`,
  });
  if (repoUsable) checkDomainRoots(profile, repoPath as string, items);

  const repoSignals = repoUsable
    ? await scanRepoSignals(repoPath as string)
    : undefined;

  let inputs: CompileInputs;
  let compileResult;
  try {
    inputs = await loadCompileInputs(profile, profilePath, {
      templatesDir: harnessPaths(opts.harnessRoot).templatesDir,
      ...(repoSignals !== undefined ? { repoSignals } : {}),
      generatedAt: opts.generatedAt,
    });
    compileResult = compileProjectPolicy(inputs);
  } catch (e) {
    if (e instanceof ProjectError) {
      items.push({ level: "error", label: "policy compile", detail: e.message });
      return finalize(opts.projectId, items);
    }
    throw e;
  }
  items.push({ level: "ok", label: "policy compiles" });

  if (RepoPolicySchema.safeParse(compileResult.repoPolicy).success) {
    items.push({ level: "ok", label: "generated repo policy schema" });
  } else {
    items.push({
      level: "error",
      label: "generated repo policy schema",
      detail: "compiled policy does not satisfy RepoPolicySchema",
    });
  }

  checkResolvable(compileResult, items);
  for (const w of compileResult.warnings) {
    items.push({
      level: "warn",
      label: `compiler (${w.domain ?? "policy"})`,
      detail: w.message,
    });
  }
  checkGlobs(compileResult, items);
  checkWritability(compileResult, items);
  for (const f of checkGeneratedCommands(compileResult.repoPolicy)) {
    items.push({
      level: f.level,
      label: `commands (${f.domain})`,
      detail: f.message,
    });
  }
  if (repoUsable) {
    await checkContextPacks(profile, inputs, repoPath as string, items);
  }
  await checkDrift(opts.harnessRoot, profile, compileResult, items);

  return finalize(opts.projectId, items);
}

function checkRepo(repoPath: string | null, items: CheckItem[]): boolean {
  if (repoPath === null) {
    items.push({
      level: "error",
      label: "repo path",
      detail: "repo.path is not set and no --repo override was given",
    });
    return false;
  }
  if (!existsSync(repoPath)) {
    items.push({
      level: "error",
      label: "repo path",
      detail: `does not exist: ${repoPath}`,
    });
    return false;
  }
  if (!statSync(repoPath).isDirectory()) {
    items.push({
      level: "error",
      label: "repo path",
      detail: `not a directory: ${repoPath}`,
    });
    return false;
  }
  items.push({ level: "ok", label: "repo path", detail: repoPath });
  items.push(
    existsSync(join(repoPath, ".git"))
      ? { level: "ok", label: "git repository" }
      : { level: "warn", label: "git repository", detail: "no .git directory" },
  );
  return true;
}

/**
 * Verify the profile's base branch resolves to a commit. Uses git
 * read-only (`rev-parse`) — never Codex. A missing branch is a config
 * error the operator should fix before a run.
 */
async function checkBaseBranch(
  repoPath: string,
  profile: ProjectProfile,
  items: CheckItem[],
): Promise<void> {
  if (!existsSync(join(repoPath, ".git"))) return; // not a git repo — already warned
  const ref = profile.repo.base_branch ?? "main";
  try {
    const r = await gitCli(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd: repoPath, timeoutMs: 10_000 },
    );
    items.push(
      r.exitCode === 0
        ? { level: "ok", label: "base branch", detail: ref }
        : {
            level: "warn",
            label: "base branch",
            detail: `"${ref}" does not resolve to a commit in the repo`,
          },
    );
  } catch (e) {
    items.push({
      level: "warn",
      label: "base branch",
      detail: `could not verify "${ref}": ${(e as Error).message}`,
    });
  }
}

function checkDomainRoots(
  profile: ProjectProfile,
  repoPath: string,
  items: CheckItem[],
): void {
  for (const d of profile.domains) {
    const abs = d.root === "." ? repoPath : join(repoPath, d.root);
    if (!existsSync(abs)) {
      items.push({
        level: "warn",
        label: `domain root (${d.id})`,
        detail: `"${d.root}" does not exist in the repo`,
      });
    }
  }
}

function checkResolvable(
  result: ReturnType<typeof compileProjectPolicy>,
  items: CheckItem[],
): void {
  let allOk = true;
  for (const domain of Object.keys(result.repoPolicy.domains)) {
    try {
      resolvePolicy(result.globalPolicy, result.repoPolicy, domain);
    } catch (e) {
      allOk = false;
      items.push({
        level: "error",
        label: `resolvePolicy (${domain})`,
        detail: (e as Error).message,
      });
    }
  }
  if (allOk) {
    items.push({ level: "ok", label: "resolvePolicy for all domains" });
  }
}

function checkGlobs(
  result: ReturnType<typeof compileProjectPolicy>,
  items: CheckItem[],
): void {
  for (const [domain, dp] of Object.entries(result.repoPolicy.domains)) {
    for (const f of lintGlobs([...dp.write, ...dp.deny_write, ...dp.read])) {
      items.push({
        level: "warn",
        label: `glob lint (${domain})`,
        detail: f.message,
      });
    }
  }
}

const MATCH_OPTS = { dot: true, nocomment: true } as const;

/**
 * Collapse a glob's wildcards into a literal segment so it becomes a
 * concrete representative path inside the glob's scope —
 * `docs/**\/*.md` → `docs/x/x.md`.
 */
function representativePath(glob: string): string {
  return glob
    .replace(/\*\*/g, "x")
    .replace(/[*?]/g, "x")
    .replace(/\/+/g, "/");
}

/**
 * Every domain must be able to write *something*: at least one write glob
 * must have a representative path that deny_write does not also match.
 * (A probe-at-root check false-warns narrow scopes like `docs/**\/*.md`,
 * so writability is judged from the write scope itself.)
 */
function checkWritability(
  result: ReturnType<typeof compileProjectPolicy>,
  items: CheckItem[],
): void {
  for (const [domain, dp] of Object.entries(result.repoPolicy.domains)) {
    if (dp.write.length === 0) {
      items.push({
        level: "error",
        label: `write scope (${domain})`,
        detail: "write scope is empty",
      });
      continue;
    }
    const live = dp.write.filter((w) => {
      const probe = representativePath(w);
      return !dp.deny_write.some((d) => minimatch(probe, d, MATCH_OPTS));
    });
    if (live.length === 0) {
      items.push({
        level: "error",
        label: `write scope (${domain})`,
        detail:
          "deny_write covers the entire write scope — the domain cannot write anything",
      });
    }
  }
}

async function checkContextPacks(
  profile: ProjectProfile,
  inputs: CompileInputs,
  repoPath: string,
  items: CheckItem[],
): Promise<void> {
  const refs = new Set(
    profile.domains.flatMap((d) => d.context_packs ?? []),
  );
  for (const ref of [...refs].sort()) {
    const pack = resolveContextPack(ref, profile, inputs);
    if (pack === null) {
      items.push({
        level: "error",
        label: `context pack (${ref})`,
        detail: "neither defined inline nor a loaded preset",
      });
      continue;
    }
    const built = await buildContextPack(repoPath, pack);
    for (const f of built.findings) {
      items.push({
        level: f.level,
        label: `context pack (${ref})`,
        detail: f.message,
      });
    }
    const included = built.files.filter((f) => f.included).length;
    items.push({
      level: "ok",
      label: `context pack (${ref})`,
      detail: `${included} file(s), ${built.includedBytes} bytes`,
    });
  }
}

function resolveContextPack(
  ref: string,
  profile: ProjectProfile,
  inputs: CompileInputs,
): NormalizedContextPack | null {
  const inline = profile.context_packs?.[ref];
  if (inline !== undefined) return normalizeInlineContextPack(ref, inline);
  const preset = inputs.contextPackPresets.get(ref);
  if (preset !== undefined) return normalizeContextPackPreset(preset);
  return null;
}

async function checkDrift(
  harnessRoot: string,
  profile: ProjectProfile,
  result: ReturnType<typeof compileProjectPolicy>,
  items: CheckItem[],
): Promise<void> {
  const repoPolicyPath = harnessPaths(harnessRoot).repoPolicyPath(
    profile.repo.id,
  );
  if (!existsSync(repoPolicyPath)) return; // nothing generated yet — not drift

  // 1. the generated policy YAML must match a fresh compile.
  let policyInSync = false;
  try {
    const onDisk = await readFile(repoPolicyPath, "utf8");
    policyInSync =
      onDisk.trim() === serializeRepoPolicyYaml(result.repoPolicy).trim();
  } catch {
    policyInSync = false;
  }

  // 2. the provenance sidecar must exist, parse, and match a fresh compile
  // (a context-pack / catalog-version change can drift provenance without
  // changing the policy YAML).
  const sidecarPath = provenanceSidecarPath(repoPolicyPath);
  let provenanceInSync = false;
  let sidecarDetail = "provenance sidecar missing";
  if (existsSync(sidecarPath)) {
    try {
      const onDisk = parseProvenance(await readFile(sidecarPath, "utf8"));
      if (onDisk === null) {
        sidecarDetail = "provenance sidecar is malformed";
      } else if (provenanceMatches(onDisk, result.provenance)) {
        provenanceInSync = true;
      } else {
        sidecarDetail = "provenance sidecar differs from the profile";
      }
    } catch {
      sidecarDetail = "provenance sidecar unreadable";
    }
  }

  if (policyInSync && provenanceInSync) {
    items.push({ level: "ok", label: "generated policy in sync" });
  } else {
    items.push({
      level: "warn",
      label: "generated policy drift",
      detail: `${policyInSync ? sidecarDetail : `${repoPolicyPath} differs from the profile`} — re-run 'project init --write --force'`,
    });
  }
}

/** Compare provenance ignoring volatile fields (generatedAt / profilePath). */
function provenanceMatches(
  a: PolicyProvenance,
  b: PolicyProvenance,
): boolean {
  const strip = (p: PolicyProvenance): string =>
    JSON.stringify({ ...p, generatedAt: "", profilePath: "" });
  return strip(a) === strip(b);
}

function finalize(
  projectId: string,
  items: CheckItem[],
): ProjectCheckReport {
  const status = items.some((i) => i.level === "error")
    ? "error"
    : items.some((i) => i.level === "warn")
      ? "warn"
      : "ok";
  return { projectId, status, items };
}
