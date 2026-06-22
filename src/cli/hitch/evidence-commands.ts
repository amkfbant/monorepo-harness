import process from "node:process";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { attachHitchEvidence } from "../../hitch/evidence-write.js";
import { HITCH_EVIDENCE_KINDS, type HitchEvidence, type HitchEvidenceKind } from "../../hitch/types.js";
import {
  HitchCliError,
  parseChoice,
  type RegisterHitchCommandsOptions,
  withHitchErrorExit,
  withHitchRepo,
  writeOutput,
} from "./helpers.js";

/**
 * Format a single `HitchEvidence` row as a human-readable tab-separated line.
 * Shows: created_at, short evidence_id, kind, attester, label, command (if
 * any), exit_code (if any), metrics (inline), and `[redacted]` /
 * `[secret-suspect]` markers when those flags are set.
 * Mirrors `formatHitchFindingList` style (hitch/helpers.ts).
 */
function formatEvidenceRow(ev: HitchEvidence): string {
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

function formatEvidenceList(evidence: HitchEvidence[]): string {
  if (evidence.length === 0) return "";
  return evidence.map(formatEvidenceRow).join("\n") + "\n";
}

/**
 * `harness hitch evidence` (add / list / show) — operator CLI surface for
 * #91 Stage A. Thin command layer over `attachHitchEvidence` (write) and
 * the `HitchRepository` facades `listEvidence` / `getEvidence` (read).
 *
 * Invariants preserved here (enforced by types + runtime):
 *   - NO `--attester` flag: `attester='operator'` is hardcoded inside
 *     `attachHitchEvidence`; the CLI never touches it.
 *   - NO `--status` flag: evidence rows have no mutable status field.
 *   - All writes go through `attachHitchEvidence` so redaction and
 *     validation always apply (no direct DB writes from this layer).
 */
export function registerHitchEvidenceCommands(
  hitchCmd: Command,
  opts: RegisterHitchCommandsOptions,
): void {
  const evidenceCmd = hitchCmd
    .command("evidence")
    .description("operator evidence attached to a hitch");

  // ── evidence add ────────────────────────────────────────────────────────
  evidenceCmd
    .command("add")
    .description("attach operator evidence to a hitch")
    .argument("<hitch-id>", "hitch id")
    .requiredOption("--label <text>", "evidence label (required, non-empty)")
    .option("--command <text>", "command that was run")
    .option(
      "--output <text>",
      "command output text (mutually exclusive with --output-file)",
    )
    .option(
      "--output-file <path>",
      "read command output from a file (mutually exclusive with --output)",
    )
    .option(
      "--metric <k=v>",
      "metric key=value pair (repeatable)",
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option("--before <text>", "state before the action (for before_after kind)")
    .option("--after <text>", "state after the action (for before_after kind)")
    .option("--note <text>", "free-text note")
    .option(
      "--kind <kind>",
      `evidence kind: ${HITCH_EVIDENCE_KINDS.join(" | ")}`,
    )
    .option("--condition <id>", "close-condition id this evidence satisfies")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        // --output-file and --output are mutually exclusive
        if (
          raw.outputFile !== undefined &&
          raw.output !== undefined
        ) {
          throw new HitchCliError(
            "--output and --output-file are mutually exclusive",
          );
        }

        let outputValue: string | undefined;
        if (typeof raw.output === "string") {
          outputValue = raw.output;
        } else if (typeof raw.outputFile === "string") {
          outputValue = readFileSync(raw.outputFile, "utf8");
        }

        // Parse --metric k=v pairs into a flat object
        const metrics: Record<string, string> = {};
        const rawMetrics = raw.metric as string[];
        if (rawMetrics.length > 0) {
          for (const entry of rawMetrics) {
            const eqIdx = entry.indexOf("=");
            const key = eqIdx >= 1 ? entry.slice(0, eqIdx) : "";
            const val = eqIdx >= 1 ? entry.slice(eqIdx + 1) : "";
            // Fail-closed: require a non-empty key AND a non-empty (after-trim)
            // value. Rejects `no-equals`, `=v`, and `k=` (empty value) alike.
            if (eqIdx < 1 || val.trim() === "") {
              throw new HitchCliError(
                `--metric must be in k=v format with a non-empty value (got ${JSON.stringify(entry)})`,
              );
            }
            metrics[key] = val;
          }
        }

        const kind =
          raw.kind !== undefined
            ? (parseChoice(
                raw.kind,
                HITCH_EVIDENCE_KINDS,
                "--kind",
              ) as HitchEvidenceKind)
            : undefined;

        const evidence = withHitchRepo(opts, ({ repo }) =>
          attachHitchEvidence(repo, {
            hitchId,
            label: String(raw.label),
            ...(kind !== undefined ? { kind } : {}),
            ...(raw.command !== undefined
              ? { command: String(raw.command) }
              : {}),
            ...(outputValue !== undefined ? { output: outputValue } : {}),
            ...(rawMetrics.length > 0 ? { metrics } : {}),
            ...(raw.before !== undefined ? { before: String(raw.before) } : {}),
            ...(raw.after !== undefined ? { after: String(raw.after) } : {}),
            ...(raw.note !== undefined ? { note: String(raw.note) } : {}),
            ...(raw.condition !== undefined
              ? { conditionId: String(raw.condition) }
              : {}),
          }),
        );

        writeOutput(
          raw,
          evidence,
          `evidence=${evidence.evidenceId} attester=${evidence.attester} kind=${evidence.kind} label=${evidence.label}\n`,
        );
      });
    });

  // ── evidence list ────────────────────────────────────────────────────────
  evidenceCmd
    .command("list")
    .description("list evidence for a hitch")
    .argument("<hitch-id>", "hitch id")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const evidence = withHitchRepo(opts, ({ repo }) => {
          repo.requireSession(hitchId);
          return repo.listEvidence(hitchId);
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ evidence }, null, 2)}\n`);
        } else {
          process.stdout.write(formatEvidenceList(evidence));
        }
      });
    });

  // ── evidence show ────────────────────────────────────────────────────────
  evidenceCmd
    .command("show")
    .description("show a single evidence record by evidence id")
    .argument("<evidence-id>", "evidence id")
    .option("--json", "emit JSON", false)
    .action((evidenceId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const evidence = withHitchRepo(opts, ({ repo }) =>
          repo.getEvidence(evidenceId),
        );
        if (evidence === null) {
          throw new HitchCliError(`evidence not found: ${evidenceId}`);
        }
        writeOutput(
          raw,
          evidence,
          formatEvidenceRow(evidence) + "\n",
        );
      });
    });
}
