import type { HitchFinding } from "./types.js";
import type { EvaluatedCloseCondition } from "./close-checks.js";
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
    `- ${clipField(failure.conditionId)}${description} [${failure.conditionKind}]`,
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

function stringEvidence(
  evidence: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = evidence[key];
  return typeof value === "string" ? value : undefined;
}

function numberEvidence(
  evidence: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanEvidence(
  evidence: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = evidence[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A FAILED required condition the coder must address: any failure with a
 * recorded check row, or a `facet_red_test` failure (the evidence-INDEPENDENT
 * fail-open shape that has no recorded row — #279 P2).
 */
function isCoderDrivenFacetFailure(
  evaluated: EvaluatedCloseCondition,
): boolean {
  return (
    evaluated.status === "failed" &&
    (evaluated.check !== null ||
      evaluated.condition.kind === "facet_red_test")
  );
}

/**
 * A code-recoverable PENDING `facet_red_test` (#308 P2-2): convergence routes it
 * to the coder (needs_fix), so its actionable message must reach the rerun goal.
 * Strictly gated on `facetPendingDisposition === "code_recoverable"` so an
 * evidence-recoverable pending (→ ask_human) is never injected.
 */
function isCodeRecoverableFacetPending(
  evaluated: EvaluatedCloseCondition,
): boolean {
  return (
    evaluated.status === "pending" &&
    evaluated.condition.kind === "facet_red_test" &&
    evaluated.facetPendingDisposition === "code_recoverable"
  );
}

/**
 * Project failed REQUIRED close-condition evaluations into the coder-rerun
 * failure context. Pure (no DB). A `command`/finding failure carries its
 * recorded evidence (exitCode, output tails, log paths). A `facet_red_test`
 * fail-open-shape failure is evidence-INDEPENDENT (it has no recorded check row,
 * #279 P2): include it anyway and carry the deterministic evaluator `message`
 * (which names the uncovered facet / production glob) so the next coder pass
 * knows the production surface changed with no covering test instead of looping
 * blind. Other failed kinds still require a recorded check row (a bare failure
 * with no row carries no actionable detail).
 *
 * #308 P2-2: a code-recoverable PENDING `facet_red_test` (a facet with no
 * covering test present → evidence alone can never clear it; convergence routes
 * it to the CODER, not ask_human) is ALSO included so the rerun goal carries the
 * "add a RED covering test" instruction. Evidence-recoverable pendings (route to
 * ask_human) and every other pending kind are NOT included — they are not driven
 * by the coder, so injecting them would mislead the rerun.
 */
export function closeCheckFailureContexts(
  conditions: readonly EvaluatedCloseCondition[],
): CloseCheckFailureContext[] {
  return conditions
    .filter(
      (evaluated) =>
        evaluated.condition.required &&
        (isCoderDrivenFacetFailure(evaluated) ||
          isCodeRecoverableFacetPending(evaluated)),
    )
    .map((evaluated) => {
      const evidence = evaluated.check?.evidence ?? {};
      const description = evaluated.condition.description;
      const command = stringEvidence(evidence, "command");
      const exitCode = numberEvidence(evidence, "exitCode");
      const timedOut = booleanEvidence(evidence, "timedOut");
      // #308 P2: for ANY `facet_red_test` condition (a FAILED fail-open shape OR
      // a code-recoverable pending) the actionable feedback is the evaluator's
      // CURRENT message. `evaluateFacetRedTest` RE-DERIVES that message from the
      // current run_changed_files + evidence on every evaluation, so it is always
      // correctly routed (fail-open / code-recoverable → "no covering test"; the
      // evidence-recoverable case → "record fresh RED evidence" — and the latter
      // is never injected into the coder goal). A facet `check.message`, by
      // contrast, is a PRIOR recording that can be stale/misleading (e.g. an old
      // "record fresh RED evidence" or a stale "passed"), which would misdirect
      // the coder to record evidence that can never satisfy it. For NON-facet
      // conditions the recorded `check.message` is still the right feedback (a
      // real failure detail), so keep it preferred there.
      const message =
        evaluated.condition.kind === "facet_red_test"
          ? (evaluated.message ?? undefined)
          : (evaluated.check?.message ?? evaluated.message ?? undefined);
      const stdout =
        stringEvidence(evidence, "stdoutTail") ??
        stringEvidence(evidence, "stdout");
      const stderr =
        stringEvidence(evidence, "stderrTail") ??
        stringEvidence(evidence, "stderr");
      const stdoutPath = stringEvidence(evidence, "stdoutPath");
      const stderrPath = stringEvidence(evidence, "stderrPath");
      return {
        conditionId: evaluated.condition.id,
        conditionKind: evaluated.condition.kind,
        ...(description !== undefined ? { description } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(timedOut !== undefined ? { timedOut } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(stdout !== undefined ? { stdout } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
        ...(stdoutPath !== undefined ? { stdoutPath } : {}),
        ...(stderrPath !== undefined ? { stderrPath } : {}),
      };
    });
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
