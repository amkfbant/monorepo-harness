import type { HitchFinding } from "./types.js";
import { containsLikelySecret } from "../reporter/secret-scan.js";

/** Default cap on findings injected into a coder rerun goal (keeps the prompt bounded). */
const DEFAULT_MAX_INJECTED_FINDINGS = 25;
const DEFAULT_MAX_INJECTED_CLOSE_CHECKS = 10;
const DEFAULT_MAX_CLOSE_CHECK_OUTPUT_CHARS = 4000;

export interface CloseCheckFailureContext {
  conditionId: string;
  conditionKind: string;
  description?: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
  message?: string;
  stdout?: string;
  stderr?: string;
  stdoutPath?: string;
  stderrPath?: string;
}

function renderFinding(finding: HitchFinding): string {
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
  findings: readonly HitchFinding[],
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

const SECRET_WITHHELD =
  "[redacted: secret-shaped content detected; close-check output withheld]";
const FIELD_WITHHELD = "[redacted]";

// An allowlisted close-check command can print tokens/keys, and this output does
// NOT pass through the run's codex-events redaction — so scrub it before it lands
// in the next Codex prompt. Fail-closed and WHOLE-stream:
//   - scan the FULL output BEFORE clipping, so a tail-clip window cannot sever a
//     token's prefix (e.g. `ghp_`) and let the suffix evade detection;
//   - scan as one blob (not per line), so a multi-line secret (PEM private key
//     block) is caught even though only its BEGIN line matches a line pattern;
//   - on ANY match, withhold the entire stream rather than risk a partial leak.
// `containsLikelySecret` is the SAME definition the source (`readLogExcerpt`)
// uses, so the source clip and this injection layer cannot drift.
// Secrets in typecheck/vitest output are rare, so the lost detail is an
// acceptable price for not leaking a key into the coder prompt.
function clipOutput(value: string): string {
  if (containsLikelySecret(value)) return SECRET_WITHHELD;
  if (value.length <= DEFAULT_MAX_CLOSE_CHECK_OUTPUT_CHARS) return value;
  return value.slice(value.length - DEFAULT_MAX_CLOSE_CHECK_OUTPUT_CHARS);
}

// Any free-text field (command, message, description, log paths) can also carry
// a secret into the prompt. stdout/stderr are NOT the only attack surface, so
// gate every injected free-text field with the same fail-closed guard and
// withhold the WHOLE field value on a match.
function clipField(value: string): string {
  return containsLikelySecret(value) ? FIELD_WITHHELD : value;
}

function renderCloseCheckFailure(failure: CloseCheckFailureContext): string {
  const description =
    failure.description !== undefined && failure.description.trim() !== ""
      ? ` (${clipField(failure.description.trim())})`
      : "";
  const parts = [
    `- ${failure.conditionId}${description} [${failure.conditionKind}]`,
  ];
  if (failure.command !== undefined && failure.command.trim() !== "") {
    parts.push(`  command: ${clipField(failure.command.trim())}`);
  }
  if (failure.exitCode !== undefined || failure.timedOut !== undefined) {
    parts.push(
      `  result: exitCode=${failure.exitCode ?? "(unknown)"}, ` +
        `timedOut=${failure.timedOut ?? "(unknown)"}`,
    );
  }
  if (failure.message !== undefined && failure.message.trim() !== "") {
    parts.push(`  message: ${clipField(failure.message.trim())}`);
  }
  if (failure.stdoutPath !== undefined && failure.stdoutPath.trim() !== "") {
    parts.push(`  stdoutPath: ${clipField(failure.stdoutPath.trim())}`);
  }
  if (failure.stderrPath !== undefined && failure.stderrPath.trim() !== "") {
    parts.push(`  stderrPath: ${clipField(failure.stderrPath.trim())}`);
  }
  if (failure.stdout !== undefined && failure.stdout.trim() !== "") {
    parts.push(["  stdout:", clipOutput(failure.stdout).trimEnd()].join("\n"));
  }
  if (failure.stderr !== undefined && failure.stderr.trim() !== "") {
    parts.push(["  stderr:", clipOutput(failure.stderr).trimEnd()].join("\n"));
  }
  return parts.join("\n");
}

/**
 * Append failed close-check command evidence to the coder goal. This carries the
 * deterministic command result into the next rerun without trusting an LLM
 * summary or requiring the coder to discover logs outside the repo.
 */
export function augmentGoalWithFailedCloseChecks(
  goal: string,
  failures: readonly CloseCheckFailureContext[],
  maxFailures: number = DEFAULT_MAX_INJECTED_CLOSE_CHECKS,
): string {
  if (failures.length === 0) return goal;
  const shown = failures.slice(0, maxFailures);
  const blocks = shown.map(renderCloseCheckFailure);
  if (failures.length > shown.length) {
    blocks.push(
      `- and ${failures.length - shown.length} more failed close-check(s) not shown`,
    );
  }
  return [
    goal,
    "",
    "## Failed close-check evidence to address",
    "",
    "Fix the cause of these required close-check failures before rerunning the checks:",
    blocks.join("\n"),
  ].join("\n");
}

/**
 * Append a "previous attempt failed" note to the coder goal when the prior
 * coding run failed before review (e.g. `failed-command` / `failed-codex`), so
 * a recovery rerun knows it is fixing a failure rather than starting fresh.
 * Returns the goal unchanged when there is no failure to report. Pure.
 */
export function augmentGoalWithFailedRun(
  goal: string,
  runStatus: string,
): string {
  if (runStatus.trim() === "") return goal;
  return [
    goal,
    "",
    "## Previous attempt failed",
    "",
    `The previous coder run did not reach review — it finished with status ` +
      `\`${runStatus.trim()}\` (e.g. a failing allowed command, a policy ` +
      `violation, or a codex error). Diagnose and fix the cause so this ` +
      `attempt can pass.`,
  ].join("\n");
}
