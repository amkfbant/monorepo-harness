import type { RepoPolicy } from "../policy/schema.js";

/**
 * Command checker (Phase 5-6).
 *
 * An independent re-check of a *generated* repo policy's commands — it
 * does not trust the compiler. It catches duplicate command ids the way
 * `resolvePolicy` computes them (string entry → `cmd-<index>`), which
 * would otherwise make `resolvePolicy` throw at run time.
 */

export interface CommandCheckFinding {
  level: "error" | "warn";
  domain: string;
  message: string;
}

export function checkGeneratedCommands(
  repoPolicy: RepoPolicy,
): CommandCheckFinding[] {
  const findings: CommandCheckFinding[] = [];
  for (const [domain, d] of Object.entries(repoPolicy.domains)) {
    const allow = d.commands?.allow ?? [];
    const seen = new Set<string>();
    allow.forEach((entry, i) => {
      const id = typeof entry === "string" ? `cmd-${i}` : entry.id;
      if (seen.has(id)) {
        findings.push({
          level: "error",
          domain,
          message: `duplicate command id "${id}" — resolvePolicy would reject this domain`,
        });
      }
      seen.add(id);
      if (typeof entry !== "string" && entry.cmd.trim() === "") {
        findings.push({
          level: "error",
          domain,
          message: `command "${entry.id}" has an empty cmd`,
        });
      }
    });
  }
  return findings;
}
