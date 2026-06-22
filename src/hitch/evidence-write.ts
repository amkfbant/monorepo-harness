import { randomUUID } from "node:crypto";
import { containsLikelySecret } from "../reporter/secret-scan.js";
import type { HitchEvidence, HitchEvidenceKind } from "./types.js";
import { HitchValidationError } from "./types.js";
import type { HitchRepository } from "./repository.js";

/**
 * #91 Stage A — THE ONLY writer of `attester='operator'` evidence rows.
 *
 * `attester` is hardcoded `'operator'` inside this function and NEVER read
 * from any input argument. The input type intentionally omits the field so the
 * invariant is enforced at the type level AND at runtime (the value written
 * is always the literal string `'operator'`).
 *
 * Safety contract (fail-closed — every branch throws on violation):
 *   - hitch must exist
 *   - hitch must be non-terminal (open/in_progress/close_ready/diverging)
 *   - label must be non-empty after trim
 *   - at least one payload field must be supplied (command/output/metrics
 *     (non-empty)/before/after/note)
 *   - metrics, if present, must be a flat record of string|number values
 *
 * Redaction (mandatory before persistence):
 *   - command, output, and each metric string value are scanned via
 *     `containsLikelySecret`; any suspicious value is replaced with
 *     `"[redacted]"` and `secretSuspect`/`redacted` flags are set to `true`.
 *
 * See `docs/specs/` for the broader Stage A spec and `finding-write.ts` for
 * the structural precedent this mirrors.
 */

/** Caller-visible input — no `attester`, no `status`, no generated fields. */
export interface AttachHitchEvidenceInput {
  hitchId: string;
  label: string;
  kind?: HitchEvidenceKind;
  command?: string;
  output?: string;
  /** Flat record of string|number values only. */
  metrics?: Record<string, string | number>;
  before?: string;
  after?: string;
  note?: string;
  runId?: string;
  conditionId?: string;
  attesterLabel?: string;
}

/** Optional test / deterministic overrides. */
export interface AttachHitchEvidenceOptions {
  /** ISO-8601 timestamp to use for `created_at`. Defaults to `new Date().toISOString()`. */
  now?: string;
}

// Tail-cap for `outputExcerpt` — matches the existing close-check constant.
const EVIDENCE_EXCERPT_BYTES = 8192;

// Field-level redaction marker — matches the marker used by the close-check
// runner (`orchestrator-close-check-runner.ts`) and `coder-goal-context.ts`.
const REDACTED = "[redacted]";

// Terminal statuses for a hitch — mirrors the set in `terminalDecision`
// (convergence.ts). Writing evidence onto a terminal hitch is disallowed
// because the operator close-gate reads evidence rows to verify provenance,
// and a terminal hitch must not accumulate post-close evidence silently.
const TERMINAL_HITCH_STATUSES = new Set([
  "closed",
  "cancelled",
  "budget_exhausted",
  "escalated",
]);

function throwValidation(code: string, message: string, path: string): never {
  throw new HitchValidationError(message, [
    { severity: "hard", code, message, path },
  ]);
}

function inferKind(
  input: AttachHitchEvidenceInput,
): HitchEvidenceKind {
  if (input.kind !== undefined) return input.kind;
  if (input.command !== undefined) return "command";
  if (input.metrics !== undefined) return "metrics";
  return "note";
}

/**
 * Scan a string value through `containsLikelySecret`.
 * Returns `{ value, flagged }` where `flagged=true` means the field was
 * replaced with the redaction marker.
 */
function redactField(raw: string): { value: string; flagged: boolean } {
  if (containsLikelySecret(raw)) {
    return { value: REDACTED, flagged: true };
  }
  return { value: raw, flagged: false };
}

/**
 * Tail-clip `output` to `EVIDENCE_EXCERPT_BYTES` AFTER redaction.
 * Clipping is byte-aware (UTF-8) to match the close-check runner's approach.
 */
function makeExcerpt(output: string): string {
  const buf = Buffer.from(output, "utf8");
  if (buf.length <= EVIDENCE_EXCERPT_BYTES) return output;
  return buf
    .subarray(buf.length - EVIDENCE_EXCERPT_BYTES)
    .toString("utf8");
}

/**
 * Attach an operator-attested evidence row to a hitch.
 *
 * @param repo   - The aggregate `HitchRepository` (provides session lookup
 *                 and evidence insertion as facades).
 * @param input  - Evidence payload; must NOT contain `attester` or `status`.
 * @param opts   - Optional overrides (clock injection for tests).
 * @returns The inserted `HitchEvidence` row (deserialized, boolean fields).
 */
export function attachHitchEvidence(
  repo: HitchRepository,
  input: AttachHitchEvidenceInput,
  opts: AttachHitchEvidenceOptions = {},
): HitchEvidence {
  // ── 1. hitch exists? ──────────────────────────────────────────────────────
  const session = repo.getSession(input.hitchId);
  if (session === null) {
    throwValidation(
      "EVIDENCE_HITCH_NOT_FOUND",
      `hitch not found: ${input.hitchId}`,
      "hitchId",
    );
  }

  // ── 2. hitch is non-terminal? ─────────────────────────────────────────────
  if (TERMINAL_HITCH_STATUSES.has(session.status)) {
    throwValidation(
      "EVIDENCE_HITCH_TERMINAL",
      `hitch ${input.hitchId} is terminal (status="${session.status}"); cannot attach evidence`,
      "hitchId",
    );
  }

  // ── 3. label non-empty ────────────────────────────────────────────────────
  if (input.label.trim() === "") {
    throwValidation(
      "EVIDENCE_LABEL_EMPTY",
      "label must be non-empty after trim",
      "label",
    );
  }

  // ── 4. metrics shape validation (before payload check) ───────────────────
  if (input.metrics !== undefined) {
    for (const [key, val] of Object.entries(input.metrics)) {
      if (typeof val !== "string" && typeof val !== "number") {
        throwValidation(
          "EVIDENCE_METRICS_INVALID_VALUE",
          `metrics["${key}"] must be a string or number, got ${typeof val}`,
          `metrics.${key}`,
        );
      }
    }
  }

  // ── 5. payload non-empty ──────────────────────────────────────────────────
  const hasMetrics =
    input.metrics !== undefined && Object.keys(input.metrics).length > 0;
  const hasPayload =
    input.command !== undefined ||
    input.output !== undefined ||
    hasMetrics ||
    input.before !== undefined ||
    input.after !== undefined ||
    input.note !== undefined;

  if (!hasPayload) {
    throwValidation(
      "EVIDENCE_PAYLOAD_EMPTY",
      "at least one payload field is required (command, output, metrics, before, after, or note)",
      "payload",
    );
  }

  // ── 6. redaction ──────────────────────────────────────────────────────────
  let secretSuspect = false;
  let redacted = false;

  let safeCommand: string | undefined = input.command;
  if (input.command !== undefined) {
    const r = redactField(input.command);
    safeCommand = r.value;
    if (r.flagged) {
      secretSuspect = true;
      redacted = true;
    }
  }

  let outputExcerpt: string | null = null;
  if (input.output !== undefined) {
    const r = redactField(input.output);
    if (r.flagged) {
      secretSuspect = true;
      redacted = true;
      outputExcerpt = REDACTED;
    } else {
      outputExcerpt = makeExcerpt(r.value);
    }
  }

  const safeMetrics: Record<string, string | number> = {};
  if (input.metrics !== undefined) {
    for (const [key, val] of Object.entries(input.metrics)) {
      if (typeof val === "string") {
        const r = redactField(val);
        safeMetrics[key] = r.value;
        if (r.flagged) {
          secretSuspect = true;
          redacted = true;
        }
      } else {
        safeMetrics[key] = val;
      }
    }
  }

  // ── 7. derive remaining fields ────────────────────────────────────────────
  const evidenceId = `ev-${randomUUID()}`;
  const createdAt = opts.now ?? new Date().toISOString();
  const kind = inferKind(input);

  // ── 8. build the row (attester is HARDCODED — never from input) ───────────
  const row: HitchEvidence = {
    evidenceId,
    hitchId: input.hitchId,
    runId: input.runId ?? null,
    conditionId: input.conditionId ?? null,
    kind,
    attester: "operator", // HARDCODED — NEVER read from input
    attesterLabel: input.attesterLabel ?? "",
    label: input.label,
    command: safeCommand ?? null,
    exitCode: null,
    summaryMetrics: safeMetrics,
    metricsSchema: 1,
    outputExcerpt,
    secretSuspect,
    redacted,
    createdAt,
  };

  // ── 9. persist via repository facade ─────────────────────────────────────
  repo.insertEvidence(row);

  // ── 10. return the canonical inserted row ────────────────────────────────
  const inserted = repo.getEvidence(evidenceId);
  if (inserted === null) {
    // Should never happen — insert just succeeded.
    throw new Error(`evidence ${evidenceId} not found after insert`);
  }
  return inserted;
}
