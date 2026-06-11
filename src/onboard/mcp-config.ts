import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface StarterOptIn {
  /** the client name the agent connects as (e.g. "codex"); becomes a guarded-mutation client */
  clientName: string;
  /** the mutation operations to allowlist (e.g. ["goal.start", "run.start"]) */
  operations: string[];
}

export interface MergeMcpInput {
  projectId: string;
  /** all known project ids (from the `projects` table) — used to seed an enumeration */
  existingProjectIds: string[];
  /** null = decline (stay read-only); else opt into a guarded-mutation client + ops */
  starter: StarterOptIn | null;
  /** what to do when the existing config is allow-all (allowedProjects empty/absent). default "keep". */
  allowAll?: "keep" | "enumerate";
}

export interface MergeMcpReport {
  /** true when the config was allow-all and we kept it that way (did not narrow) */
  allowAllPreserved: boolean;
  /** true when a guarded-mutation client + ops were written */
  mutationsEnabled: boolean;
}

export interface MergeMcpResult {
  yaml: string;
  report: MergeMcpReport;
}

interface RawMcp {
  version?: number;
  mcp?: Record<string, unknown>;
}

/**
 * Merge a project into `.harness/mcp.yaml` (pure). Encodes the two safety rules:
 *  - mutations need a guarded-mutation CLIENT + an allowlisted operation, so the
 *    starter opt-in writes BOTH (otherwise the allowlist silently never applies).
 *  - an empty OR absent `allowedProjects` means allow-all; appending one project
 *    would narrow it and break other projects, so we never do that silently.
 */
export function mergeMcpConfig(
  existingText: string | null,
  input: MergeMcpInput,
): MergeMcpResult {
  const root: RawMcp =
    existingText !== null && existingText.trim() !== ""
      ? (parseYaml(existingText) as RawMcp) ?? {}
      : {};
  const mcp: Record<string, unknown> = { ...(root.mcp ?? {}) };

  if (mcp.defaultMode === undefined) mcp.defaultMode = "dry-run";

  const currentProjects = Array.isArray(mcp.allowedProjects)
    ? (mcp.allowedProjects as string[])
    : [];
  let allowAllPreserved = false;
  // An existing config whose EFFECTIVE allowedProjects is empty is allow-all —
  // whether the key is present-and-empty OR absent entirely. Do NOT narrow it.
  if (existingText !== null && currentProjects.length === 0) {
    if ((input.allowAll ?? "keep") === "enumerate") {
      mcp.allowedProjects = unique(input.existingProjectIds);
    } else {
      mcp.allowedProjects = []; // keep allow-all
      allowAllPreserved = true;
    }
  } else {
    mcp.allowedProjects = unique([...currentProjects, input.projectId]);
  }

  let mutationsEnabled = false;
  if (input.starter !== null) {
    const clients = Array.isArray(mcp.clients) ? [...(mcp.clients as unknown[])] : [];
    const has = clients.some(
      (c) => (c as { names?: string[] }).names?.includes(input.starter!.clientName),
    );
    if (!has) {
      clients.push({
        id: input.starter.clientName,
        names: [input.starter.clientName],
        mode: "guarded-mutation",
      });
    }
    mcp.clients = clients;
    const ops = Array.isArray(mcp.allowedOperations)
      ? (mcp.allowedOperations as string[])
      : [];
    mcp.allowedOperations = unique([...ops, ...input.starter.operations]);
    mutationsEnabled = true;
  }

  const out: RawMcp = { version: root.version ?? 1, mcp };
  return {
    yaml: stringifyYaml(out),
    report: { allowAllPreserved, mutationsEnabled },
  };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
