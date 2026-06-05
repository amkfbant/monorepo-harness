import type { GoalFinding } from "./types.js";

/** Default cap on findings injected into a coder rerun goal (keeps the prompt bounded). */
const DEFAULT_MAX_INJECTED_FINDINGS = 25;

function renderFinding(finding: GoalFinding): string {
  const where =
    finding.filePath !== null && finding.filePath !== ""
      ? ` [${finding.filePath}${finding.symbol ? `:${finding.symbol}` : ""}]`
      : "";
  const fix =
    finding.suggestedFix !== null && finding.suggestedFix.trim() !== ""
      ? ` (suggested fix: ${finding.suggestedFix.trim()})`
      : "";
  return `- (${finding.severity}) ${finding.summary}${where}${fix}`;
}

/**
 * Append an "open in-scope findings to address" block to the coder goal so a
 * rerun carries the specific findings review raised — the goal-mode analogue of
 * the `required_changes` injection in `core/rerun.ts`. Without this, a rerun
 * re-codes against the original goal text alone with no idea which findings to
 * fix. Returns the goal unchanged when there are no findings (the first
 * `implement` pass). Pure: never mutates its inputs.
 */
export function augmentGoalWithOpenFindings(
  goal: string,
  findings: readonly GoalFinding[],
  maxFindings: number = DEFAULT_MAX_INJECTED_FINDINGS,
): string {
  if (findings.length === 0) return goal;
  const shown = findings.slice(0, maxFindings);
  const bullets = shown.map(renderFinding);
  if (findings.length > shown.length) {
    // Surface the truncation rather than silently dropping findings.
    bullets.push(
      `- …and ${findings.length - shown.length} more open in-scope finding(s) not shown`,
    );
  }
  return [
    goal,
    "",
    "## Open in-scope findings to address",
    "",
    "Apply fixes for these specific findings raised by review on top of the previous attempt:",
    bullets.join("\n"),
  ].join("\n");
}
