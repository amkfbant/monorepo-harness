import { stringify as stringifyYaml } from "yaml";
import { harnessPaths } from "../config/paths.js";
import type { RepoPolicy } from "../policy/schema.js";
import { serializeProvenance } from "./provenance.js";
import type { ProjectPolicyCompileResult } from "./policy-compiler.js";

/**
 * Policy proposal (Phase 5-4).
 *
 * Turns a compile result into the concrete artifacts `project init` would
 * write — the repo policy YAML and the provenance sidecar JSON — plus a
 * per-domain summary. Pure and deterministic (the only time-dependent
 * field is `provenance.generatedAt`, supplied by the caller).
 */

export interface DomainProposalSummary {
  id: string;
  root: string;
  readCount: number;
  writeCount: number;
  denyWriteCount: number;
  commandCount: number;
  contextPacks: string[];
}

export interface PolicyProposal {
  result: ProjectPolicyCompileResult;
  /** where the repo policy YAML would be written */
  repoPolicyPath: string;
  /** where the provenance sidecar JSON would be written */
  provenancePath: string;
  repoPolicyYaml: string;
  provenanceJson: string;
  domains: DomainProposalSummary[];
}

export function buildPolicyProposal(
  result: ProjectPolicyCompileResult,
  harnessRoot: string,
): PolicyProposal {
  const repoPolicyPath = harnessPaths(harnessRoot).repoPolicyPath(
    result.repoId,
  );
  return {
    result,
    repoPolicyPath,
    provenancePath: provenanceSidecarPath(repoPolicyPath),
    repoPolicyYaml: serializeRepoPolicyYaml(result.repoPolicy),
    provenanceJson: serializeProvenance(result.provenance),
    domains: summarizeDomains(result),
  };
}

/** `policies/repos/<id>.yaml` → `policies/repos/<id>.generated.json`. */
export function provenanceSidecarPath(repoPolicyPath: string): string {
  return repoPolicyPath.replace(/\.yaml$/, ".generated.json");
}

/** Serialize a RepoPolicy to YAML deterministically. */
export function serializeRepoPolicyYaml(repoPolicy: RepoPolicy): string {
  return stringifyYaml(repoPolicy, { sortMapEntries: false });
}

function summarizeDomains(
  result: ProjectPolicyCompileResult,
): DomainProposalSummary[] {
  return Object.entries(result.repoPolicy.domains).map(([id, d]) => ({
    id,
    root: result.domainRoots[id] ?? id,
    readCount: d.read.length,
    writeCount: d.write.length,
    denyWriteCount: d.deny_write.length,
    commandCount: d.commands?.allow.length ?? 0,
    contextPacks: result.domainContextPacks[id] ?? [],
  }));
}
