import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { harnessPaths } from "../config/paths.js";
import { resolvePolicy } from "./resolver.js";
import {
  GlobalPolicySchema,
  RepoPolicySchema,
  type GlobalPolicy,
  type RepoPolicy,
  type ResolvedPolicy,
} from "./schema.js";

export async function loadGlobalPolicy(path: string): Promise<GlobalPolicy> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return GlobalPolicySchema.parse(parsed ?? {});
}

export async function loadRepoPolicy(path: string): Promise<RepoPolicy> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return RepoPolicySchema.parse(parsed);
}

/**
 * Resolve the codex defaults (incl. #191 coder backend) for a repo-id-mode run
 * that has NO project profile — the global+repo policy resolved by domain. Used
 * by the project-less hitch + repo-id rerun coder construction so they honour
 * `policy.codex.backend` consistently with the project-profile paths (which get
 * it from prepareProjectRun's resolvedPolicy).
 */
export async function resolveRepoCodexDefaults(
  harnessRoot: string,
  repoId: string,
  domain: string,
): Promise<ResolvedPolicy["codex"]> {
  const paths = harnessPaths(harnessRoot);
  const global = await loadGlobalPolicy(paths.globalPolicyPath);
  const repo = await loadRepoPolicy(paths.repoPolicyPath(repoId));
  return resolvePolicy(global, repo, domain).codex;
}
