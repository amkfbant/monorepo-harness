import type { DbHitchTokenUsage } from "../../db/repositories/aggregates.js";
import type { HitchEvidence } from "../../hitch/types.js";

/**
 * `hitch status` extra-line formatters: the renderers that append additional
 * lines below the primary status line (token usage + attached evidence). Both
 * are quiet-when-empty (return `""`) so older hitches without telemetry/evidence
 * render a single line. Split out of helpers.ts (#91 Stage A) to keep that
 * aggregate under the 800-line cap and group the per-line renderers by concern.
 */

/**
 * Render the per-hitch token usage as a second status line (retry-inclusive
 * sum over the hitch's attempts, with the coder/reviewer/evaluator split).
 * Empty string when no usage telemetry is present so older hitches stay quiet.
 */
export function formatHitchTokenUsageLine(usage?: DbHitchTokenUsage): string {
  if (usage === undefined || usage.runsWithUsage === 0) return "";
  const k = usage.byKind;
  return (
    `\ntokens total=${usage.totalTokens} ` +
    `(in=${usage.inputTokens} cached=${usage.cachedInputTokens} ` +
    `out=${usage.outputTokens} reasoning=${usage.reasoningOutputTokens}) ` +
    `runsWithUsage=${usage.runsWithUsage} ` +
    `byKind[coder=${k.coder.totalTokens} reviewer=${k.reviewer.totalTokens} ` +
    `evaluator=${k.evaluator.totalTokens}]`
  );
}

/**
 * Render attached evidence rows as additional `hitch status` lines, one per row.
 * Quiet-when-empty: returns `""` when there are no rows (no header rendered) so
 * older hitches without evidence stay silent.
 *
 * Field order/labels mirror `formatEvidenceRow` in evidence-commands.ts (the
 * Task 4 `hitch evidence list` formatter) — kept byte-identical here so the
 * `hitch status` audit surface matches the standalone list. Dedup between the
 * two formatters is deferred (see #91 final review); do NOT change the output
 * shape without updating both.
 */
export function formatHitchEvidenceLines(evidence?: HitchEvidence[]): string {
  if (evidence === undefined || evidence.length === 0) return "";
  return evidence.map((ev) => "\n" + formatEvidenceStatusRow(ev)).join("");
}

/** Tab-separated single-row rendering for one evidence record. */
function formatEvidenceStatusRow(ev: HitchEvidence): string {
  const shortId = ev.evidenceId.slice(0, 12);
  const fields: string[] = [
    ev.createdAt,
    shortId,
    ev.kind,
    ev.attester,
    ev.label,
  ];
  if (ev.command !== null) fields.push(`cmd=${ev.command}`);
  if (ev.exitCode !== null) fields.push(`exit=${ev.exitCode}`);
  const metricsEntries = Object.entries(ev.summaryMetrics);
  if (metricsEntries.length > 0) {
    fields.push(
      `metrics={${metricsEntries.map(([k, v]) => `${k}:${String(v)}`).join(",")}}`,
    );
  }
  if (ev.redacted) fields.push("[redacted]");
  else if (ev.secretSuspect) fields.push("[secret-suspect]");
  return fields.join("\t");
}
