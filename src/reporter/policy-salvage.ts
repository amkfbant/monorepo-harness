import type { PolicySalvageInfo } from "../logging/run-log.js";

export function pushPolicySalvageSection(
  lines: string[],
  salvage: PolicySalvageInfo | undefined,
): void {
  if (salvage === undefined) return;
  lines.push("");
  lines.push("## Policy salvage");
  lines.push(`- Allowed paths: ${salvage.allowedPaths.length}`);
  for (const p of salvage.allowedPaths) lines.push(`  - ${p}`);
  lines.push(`- Denied paths: ${salvage.deniedPaths.length}`);
  for (const p of salvage.deniedPaths) lines.push(`  - ${p}`);
  if (salvage.available && salvage.patchArtifact !== undefined) {
    lines.push(`- Allowed-only patch: ${salvage.patchArtifact}`);
  } else {
    lines.push("- Allowed-only patch: (none)");
  }
  lines.push(`- Recommended next action: ${salvage.recommendedNextAction}`);
}
