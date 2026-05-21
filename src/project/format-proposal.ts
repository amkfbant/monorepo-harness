import { relative } from "node:path";
import type { PolicyProposal } from "./policy-proposal.js";

/**
 * Render a policy proposal as Markdown for `project init --dry-run`
 * (Phase 5-4). Deterministic given the proposal.
 */
export function formatProposalMarkdown(
  proposal: PolicyProposal,
  harnessRoot: string,
): string {
  const { result } = proposal;
  const prov = result.provenance;
  const lines: string[] = [];

  lines.push(`# Project policy proposal: ${result.projectId}`);
  lines.push("");
  lines.push(`- repo id: \`${result.repoId}\``);
  lines.push(
    `- policy template: \`${prov.policyTemplate?.id ?? "(none)"}\`` +
      (prov.policyTemplate ? ` (v${prov.policyTemplate.version})` : ""),
  );
  if (prov.commandPresets.length > 0) {
    lines.push(
      `- command presets: ${prov.commandPresets.map((p) => `\`${p.id}\``).join(", ")}`,
    );
  }
  if (prov.contextPackPresets.length > 0) {
    lines.push(
      `- context pack presets: ${prov.contextPackPresets.map((p) => `\`${p.id}\``).join(", ")}`,
    );
  }
  lines.push(`- generated at: ${prov.generatedAt}`);
  lines.push("");

  lines.push(`## Domains (${proposal.domains.length})`);
  lines.push("");
  lines.push("| domain | root | read | write | deny_write | commands | context packs |");
  lines.push("|--------|------|-----:|------:|-----------:|---------:|---------------|");
  for (const d of proposal.domains) {
    lines.push(
      `| ${cell(d.id)} | ${cell(d.root)} | ${d.readCount} | ${d.writeCount} | ${d.denyWriteCount} | ${d.commandCount} | ${cell(d.contextPacks.join(", ")) || "—"} |`,
    );
  }
  lines.push("");

  lines.push(`## Warnings (${result.warnings.length})`);
  lines.push("");
  if (result.warnings.length === 0) {
    lines.push("None.");
  } else {
    for (const w of result.warnings) {
      lines.push(
        `- ${w.domain ? `[${oneLine(w.domain)}] ` : ""}${oneLine(w.message)}`,
      );
    }
  }
  lines.push("");

  lines.push("## Files (proposed — not written by --dry-run)");
  lines.push("");
  lines.push(`- \`${rel(harnessRoot, proposal.repoPolicyPath)}\``);
  lines.push(`- \`${rel(harnessRoot, proposal.provenancePath)}\``);
  lines.push("");

  lines.push("## Generated repo policy");
  lines.push("");
  lines.push("```yaml");
  lines.push(proposal.repoPolicyYaml.trimEnd());
  lines.push("```");
  lines.push("");

  lines.push("## Next");
  lines.push("");
  lines.push(
    `Run \`harness project check --project ${result.projectId}\` to validate, ` +
      `or re-run \`project init\` with \`--write\` to create these files.`,
  );
  lines.push("");
  return lines.join("\n");
}

function rel(harnessRoot: string, path: string): string {
  const r = relative(harnessRoot, path);
  return r === "" || r.startsWith("..") ? path : r;
}

/** Escape a value for a Markdown table cell (`|` and newlines break it). */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** Collapse newlines so a value stays on one Markdown list line. */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}
