import type {
  GlobalPolicy,
  RepoPolicy,
  DomainPolicy,
  CommandEntry,
  CommandDefaults,
  StructuredCommand,
} from "../policy/schema.js";
import type { ProjectProfile, ProjectDomain } from "./schema.js";
import type { PolicyTemplate } from "./template-schema.js";
import {
  compilePresetCommand,
  type CommandPreset,
  type PackageManagerTool,
  type PackageScriptCommand,
} from "./command-preset.js";
import type { ContextPackPreset } from "./context-pack-spec.js";
import type { RepoSignals } from "./repo-signals.js";
import type { PolicyProvenance, CatalogRef } from "./provenance.js";
import {
  loadPolicyTemplate,
  loadCommandPreset,
  loadContextPackPreset,
} from "./template-loader.js";
import { ProjectProfileError } from "./errors.js";
import {
  ReviewRuleCompileError,
  resolveEffectiveRule,
  type ReviewRuleResolution,
} from "../core/review-rule.js";

/**
 * Policy compiler (Phase 5-4).
 *
 * Compiles a project profile + a policy template + command presets into
 * the existing `GlobalPolicy` / `RepoPolicy` shapes, so a profile feeds
 * `resolvePolicy()` exactly like a hand-written policy. Output is
 * deterministic (sorted, deduped) so dry-run proposals diff cleanly.
 */

export interface ProjectWarning {
  /** the domain the warning concerns, when domain-specific */
  domain?: string;
  message: string;
}

export interface CompileInputs {
  profile: ProjectProfile;
  /** profile path recorded in provenance */
  profilePath: string;
  policyTemplate: PolicyTemplate;
  /** command presets referenced by the profile, keyed by preset id */
  commandPresets: Map<string, CommandPreset>;
  /** context pack presets referenced by the profile, keyed by pack id */
  contextPackPresets: Map<string, ContextPackPreset>;
  /** repo signals — needed to resolve abstract package_script commands */
  repoSignals?: RepoSignals;
  /** the domain registry used by inspect, when one informed this profile */
  domainRegistry?: CatalogRef;
  /** ISO instant recorded in provenance (caller-supplied for determinism) */
  generatedAt: string;
}

export interface ProjectPolicyCompileResult {
  projectId: string;
  repoId: string;
  globalPolicy: GlobalPolicy;
  repoPolicy: RepoPolicy;
  /** repo-relative root path per domain id */
  domainRoots: Record<string, string>;
  /** context pack ids referenced per domain id */
  domainContextPacks: Record<string, string[]>;
  /** effective review rule compiled from profile.review, or default. */
  reviewRuleResolution: ReviewRuleResolution;
  warnings: ProjectWarning[];
  provenance: PolicyProvenance;
}

export function compileProjectPolicy(
  inputs: CompileInputs,
): ProjectPolicyCompileResult {
  const { profile, policyTemplate: tpl } = inputs;
  const warnings: ProjectWarning[] = [];

  const rootDeny = uniqSort([
    ...(tpl.root_deny ?? []),
    ...(profile.policy?.global_deny ?? []),
  ]);

  const globalPolicy: GlobalPolicy = {
    always_deny_write: rootDeny,
    ignore_untracked: uniqSort([
      ...(tpl.ignore_untracked ?? []),
      ...(profile.policy?.ignore_untracked ?? []),
    ]),
    ...(tpl.defaults?.codex ? { defaults: { codex: tpl.defaults.codex } } : {}),
    ...(tpl.defaults?.limits ? { limits: tpl.defaults.limits } : {}),
    // #410 Phase 2: pass the profile's opt-in workspace isolation through to
    // the compiled global policy (omitted → resolver applies worktree default).
    ...(profile.workspace ? { workspace: profile.workspace } : {}),
  };

  const allRoots = profile.domains.map((d) => d.root);
  const usedPresetIds = new Set<string>();
  const domainContextPacks: Record<string, string[]> = {};
  const domainRoots: Record<string, string> = {};

  const domains: Record<string, DomainPolicy> = {};
  for (const d of profile.domains) {
    domains[d.id] = compileDomain(d, {
      tpl,
      allRoots,
      rootDeny,
      inputs,
      warnings,
      usedPresetIds,
    });
    domainRoots[d.id] = d.root;
    domainContextPacks[d.id] = resolveContextPackRefs(d, profile, inputs, warnings);
  }

  const repoPolicy: RepoPolicy = {
    repo_id: profile.repo.id,
    read: [],
    domains,
  };
  const reviewRuleResolution = compileReviewRuleResolution(profile);

  const provenance: PolicyProvenance = {
    schemaVersion: 1,
    projectId: profile.project_id,
    repoId: profile.repo.id,
    profilePath: inputs.profilePath,
    profileVersion: profile.version,
    policyTemplate: { id: tpl.template_id, version: tpl.version },
    commandPresets: [...usedPresetIds]
      .sort()
      .map((id): CatalogRef => ({
        id,
        version: inputs.commandPresets.get(id)?.version ?? 0,
      })),
    contextPackPresets: collectContextPackRefs(inputs),
    domainRegistry: inputs.domainRegistry ?? null,
    generatedAt: inputs.generatedAt,
  };

  return {
    projectId: profile.project_id,
    repoId: profile.repo.id,
    globalPolicy,
    repoPolicy,
    domainRoots,
    domainContextPacks,
    reviewRuleResolution,
    warnings,
    provenance,
  };
}

function compileReviewRuleResolution(
  profile: ProjectProfile,
): ReviewRuleResolution {
  try {
    return resolveEffectiveRule({
      projectId: profile.project_id,
      repoId: profile.repo.id,
      profile,
    });
  } catch (e) {
    if (e instanceof ReviewRuleCompileError) {
      throw new ProjectProfileError(
        `project review rule failed validation: ${e.message}`,
      );
    }
    throw e;
  }
}

interface DomainCompileCtx {
  tpl: PolicyTemplate;
  allRoots: string[];
  rootDeny: string[];
  inputs: CompileInputs;
  warnings: ProjectWarning[];
  usedPresetIds: Set<string>;
}

function compileDomain(
  d: ProjectDomain,
  ctx: DomainCompileCtx,
): DomainPolicy {
  const kindDefault = ctx.tpl.domain_defaults?.[d.kind ?? "other"];
  const otherRoots = ctx.allRoots.filter((r) => r !== d.root);
  const expand = { root: d.root, otherRoots, rootDeny: ctx.rootDeny };

  // explicit profile scopes win; otherwise expand the template defaults.
  const read = uniqSort(
    d.read ??
      expandTemplateGlobs(
        kindDefault?.read ?? ["{root}/**"],
        expand,
        d.id,
        ctx.warnings,
      ),
  );
  const write = uniqSort(
    d.write ??
      expandTemplateGlobs(
        kindDefault?.write ?? ["{root}/**"],
        expand,
        d.id,
        ctx.warnings,
      ),
  );
  // deny_write always includes the other domain roots and the root-deny
  // list, regardless of template, so domain isolation cannot be lost.
  const denyWrite = uniqSort([
    ...(d.deny_write ?? []),
    ...expandTemplateGlobs(
      kindDefault?.deny_write ?? [],
      expand,
      d.id,
      ctx.warnings,
    ),
    ...otherRoots.map((r) => rootSubtreeGlob(r)),
    ...ctx.rootDeny,
  ]);

  const allow = compileDomainCommands(d, ctx);
  const commandDefaults = resolveCommandDefaults(d, ctx);

  const domain: DomainPolicy = { read, write, deny_write: denyWrite };
  if (allow.length > 0 || commandDefaults !== undefined) {
    domain.commands = {
      allow,
      ...(commandDefaults !== undefined ? { defaults: commandDefaults } : {}),
    };
  }
  return domain;
}

interface ExpandCtx {
  root: string;
  otherRoots: string[];
  rootDeny: string[];
}

/**
 * Expand a policy template's placeholder globs into concrete globs.
 * `{root}` substitutes the domain root; `{other_domain_roots}` expands to
 * one entry per sibling root; `{root_deny}` expands to the root-deny list.
 */
function expandTemplateGlobs(
  globs: string[],
  ctx: ExpandCtx,
  domainId: string,
  warnings: ProjectWarning[],
): string[] {
  const out: string[] = [];
  for (const g of globs) {
    if (g === "{root_deny}") {
      out.push(...ctx.rootDeny);
      continue;
    }
    if (g.includes("{other_domain_roots}")) {
      for (const r of ctx.otherRoots) {
        out.push(normalizeRootGlob(g.replaceAll("{other_domain_roots}", r)));
      }
      continue;
    }
    const expanded = normalizeRootGlob(g.replaceAll("{root}", ctx.root));
    if (expanded.includes("{") || expanded.includes("}")) {
      warnings.push({
        domain: domainId,
        message: `policy template glob has an unresolved placeholder: ${g}`,
      });
    }
    out.push(expanded);
  }
  return out;
}

/** The `{root}/**` subtree glob for a domain root, handling `.` (repo root). */
function rootSubtreeGlob(root: string): string {
  return root === "." ? "**" : `${root}/**`;
}

/**
 * Collapse a `.`-rooted expansion: a domain root of `.` makes `{root}/**`
 * expand to `./**`, which minimatch does NOT match against `package.json`.
 * Normalize the leading `./` away so the glob is repo-root-anchored.
 */
function normalizeRootGlob(g: string): string {
  if (g === ".") return "**";
  return g.startsWith("./") ? g.slice(2) : g;
}

function compileDomainCommands(
  d: ProjectDomain,
  ctx: DomainCompileCtx,
): CommandEntry[] {
  const presetIds = uniq([
    ...(ctx.inputs.profile.commands?.presets ?? []),
    ...(d.command_presets ?? []),
  ]);
  const pm = resolvePackageManager(d, ctx.inputs);
  const packageName = resolvePackageName(d, ctx.inputs.repoSignals);

  const compiled: StructuredCommand[] = [];
  for (const presetId of presetIds) {
    const preset = ctx.inputs.commandPresets.get(presetId);
    if (preset === undefined) {
      ctx.warnings.push({
        domain: d.id,
        message: `command preset "${presetId}" was not loaded`,
      });
      continue;
    }
    ctx.usedPresetIds.add(presetId);
    for (const entry of preset.commands) {
      // a package_script command for a script the domain does not declare
      // would just fail at run time — skip it (the presets are named
      // "...-if-script-exists" precisely for this).
      if ("kind" in entry && !packageScriptDeclared(entry, d, ctx.inputs)) {
        ctx.warnings.push({
          domain: d.id,
          message: `package script "${entry.script}" is not declared for ${d.id} — skipping command "${entry.id}"`,
        });
        continue;
      }
      const r = compilePresetCommand(entry, {
        domainRoot: d.root,
        ...(pm !== undefined ? { packageManager: pm } : {}),
        ...(packageName !== undefined ? { packageName } : {}),
      });
      if (r.ok) compiled.push(r.command);
      else ctx.warnings.push({ domain: d.id, message: r.reason });
    }
  }

  // explicit domain commands follow the preset-derived ones.
  const explicit = d.commands?.allow ?? [];
  return dedupeCommandIds([...compiled, ...explicit], d.id, ctx.warnings);
}

function resolveCommandDefaults(
  d: ProjectDomain,
  ctx: DomainCompileCtx,
): CommandDefaults | undefined {
  // explicit domain defaults win; otherwise take the first preset's defaults.
  if (d.commands?.defaults !== undefined) return d.commands.defaults;
  const presetIds = uniq([
    ...(ctx.inputs.profile.commands?.presets ?? []),
    ...(d.command_presets ?? []),
  ]);
  for (const id of presetIds) {
    const defaults = ctx.inputs.commandPresets.get(id)?.defaults;
    if (defaults !== undefined) return defaults;
  }
  return undefined;
}

/**
 * Drop commands whose effective id collides — matching how `resolvePolicy`
 * assigns ids: a string entry becomes `cmd-<index>`, a structured entry
 * keeps its `id`. Because dropping an entry shifts the `cmd-<index>` of
 * later strings, the scan is re-run to a fixpoint.
 */
function dedupeCommandIds(
  entries: CommandEntry[],
  domainId: string,
  warnings: ProjectWarning[],
): CommandEntry[] {
  let current = entries;
  for (;;) {
    const ids = current.map((e, i) =>
      typeof e === "string" ? `cmd-${i}` : e.id,
    );
    const seen = new Set<string>();
    let dupIndex = -1;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string;
      if (seen.has(id)) {
        dupIndex = i;
        break;
      }
      seen.add(id);
    }
    if (dupIndex === -1) return current;
    warnings.push({
      domain: domainId,
      message: `duplicate command id "${ids[dupIndex] as string}" — dropping the later entry`,
    });
    current = [
      ...current.slice(0, dupIndex),
      ...current.slice(dupIndex + 1),
    ];
  }
}

function resolvePackageManager(
  d: ProjectDomain,
  inputs: CompileInputs,
): PackageManagerTool | undefined {
  void d;
  const declared = inputs.profile.repo.package_manager;
  if (isPackageManagerTool(declared)) return declared;
  const detected = inputs.repoSignals?.packageManager;
  if (isPackageManagerTool(detected)) return detected;
  return undefined;
}

function isPackageManagerTool(
  s: string | undefined,
): s is PackageManagerTool {
  return s === "npm" || s === "pnpm" || s === "yarn" || s === "bun";
}

function resolvePackageName(
  d: ProjectDomain,
  signals: RepoSignals | undefined,
): string | undefined {
  const dir = signals?.directories.find((x) => x.path === d.root);
  return dir?.packageName ?? undefined;
}

/**
 * True when the domain (or repo root) declares the package script — or
 * when there are no signals to verify against (compile proceeds, and
 * `project check` re-verifies later).
 */
function packageScriptDeclared(
  entry: PackageScriptCommand,
  d: ProjectDomain,
  inputs: CompileInputs,
): boolean {
  const signals = inputs.repoSignals;
  if (signals === undefined) return true;
  if (entry.package_scope === "root") {
    return signals.rootScripts.includes(entry.script);
  }
  const dir = signals.directories.find((x) => x.path === d.root);
  // dir not scanned (deeper than depth 2) — cannot verify, so emit.
  return dir === undefined || dir.scripts.includes(entry.script);
}

/** Resolve a domain's context pack refs, warning on undefined refs. */
function resolveContextPackRefs(
  d: ProjectDomain,
  profile: ProjectProfile,
  inputs: CompileInputs,
  warnings: ProjectWarning[],
): string[] {
  const refs = uniq(d.context_packs ?? []);
  const inline = new Set(Object.keys(profile.context_packs ?? {}));
  for (const ref of refs) {
    if (!inline.has(ref) && !inputs.contextPackPresets.has(ref)) {
      warnings.push({
        domain: d.id,
        message: `context pack "${ref}" is neither defined inline nor a loaded preset`,
      });
    }
  }
  return refs;
}

function collectContextPackRefs(inputs: CompileInputs): CatalogRef[] {
  return [...inputs.contextPackPresets.values()]
    .map((p): CatalogRef => ({ id: p.pack_id, version: p.version }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function uniqSort(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort();
}

export interface LoadCompileInputsOpts {
  templatesDir: string;
  repoSignals?: RepoSignals;
  domainRegistry?: CatalogRef;
  generatedAt: string;
}

/**
 * Load the catalog inputs a profile references (policy template + command
 * presets + non-inline context pack presets) so `compileProjectPolicy`
 * can run. A profile that references a missing/invalid catalog entry — or
 * declares no `policy.template` — fails loudly here.
 */
export async function loadCompileInputs(
  profile: ProjectProfile,
  profilePath: string,
  opts: LoadCompileInputsOpts,
): Promise<CompileInputs> {
  const templateId = profile.policy?.template;
  if (templateId === undefined) {
    throw new ProjectProfileError(
      `project "${profile.project_id}" must declare policy.template to be compiled`,
    );
  }
  const policyTemplate = await loadPolicyTemplate(opts.templatesDir, templateId);

  const commandPresetIds = uniq([
    ...(profile.commands?.presets ?? []),
    ...profile.domains.flatMap((d) => d.command_presets ?? []),
  ]);
  const commandPresets = new Map<string, CommandPreset>();
  for (const id of commandPresetIds) {
    commandPresets.set(id, await loadCommandPreset(opts.templatesDir, id));
  }

  // a domain context pack ref resolves to an inline profile pack first;
  // anything else must be a catalog preset.
  const inlineNames = new Set(Object.keys(profile.context_packs ?? {}));
  const contextRefIds = uniq(
    profile.domains.flatMap((d) => d.context_packs ?? []),
  ).filter((id) => !inlineNames.has(id));
  const contextPackPresets = new Map<string, ContextPackPreset>();
  for (const id of contextRefIds) {
    contextPackPresets.set(
      id,
      await loadContextPackPreset(opts.templatesDir, id),
    );
  }

  return {
    profile,
    profilePath,
    policyTemplate,
    commandPresets,
    contextPackPresets,
    ...(opts.repoSignals !== undefined ? { repoSignals: opts.repoSignals } : {}),
    ...(opts.domainRegistry !== undefined
      ? { domainRegistry: opts.domainRegistry }
      : {}),
    generatedAt: opts.generatedAt,
  };
}
