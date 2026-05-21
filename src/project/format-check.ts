import type { ProjectCheckReport } from "./checker.js";

/**
 * Formatters for `project check` (Phase 5-6) — a human-readable text
 * report and a CI-friendly JSON form.
 */

export function formatCheckText(report: ProjectCheckReport): string {
  const lines: string[] = [];
  lines.push(`Project check: ${report.projectId}`);
  lines.push(`status: ${report.status}`);
  lines.push("");
  lines.push("checks:");
  for (const item of report.items) {
    const detail = item.detail !== undefined ? `: ${item.detail}` : "";
    lines.push(`  [${item.level}] ${item.label}${detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatCheckJson(report: ProjectCheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
