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
 *     (non-empty)). Free-text bodies (notes, before/after) go via `output`;
 *     Stage A does not store a dedicated note/before/after body, so those
 *     inputs are NOT accepted (accept-and-drop would be silent data loss).
 *   - metrics, if present, must be a flat record of string|number values whose
 *     KEYS are non-secret identifiers (a secret-shaped key is rejected — a key
 *     is an identifier, never secret payload)
 *
 * Redaction (mandatory before persistence):
 *   - label, command, output, and each metric string value are scanned via
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
  runId?: string;
  conditionId?: string;
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

// Kind inference operates on the NORMALIZED payload (blank command/output
// already dropped by the caller), so a blank `--command` cannot mislabel a row
// as kind=command.
function inferKind(
  kind: HitchEvidenceKind | undefined,
  hasCommand: boolean,
  hasMetrics: boolean,
): HitchEvidenceKind {
  if (kind !== undefined) return kind;
  if (hasCommand) return "command";
  if (hasMetrics) return "metrics";
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
 *
 * Byte-aware AND character-boundary-aware: a naive `subarray(len-N)` tail can
 * begin mid-multibyte-character, and decoding that emits U+FFFD replacement
 * chars whose re-encoding can push the excerpt OVER the byte cap (e.g. a 3-byte
 * char split yields an 8196-byte excerpt). We advance the start to the next
 * UTF-8 lead byte (skip 0b10xxxxxx continuation bytes), so the kept tail is a
 * valid character sequence of at most `EVIDENCE_EXCERPT_BYTES` bytes.
 */
function makeExcerpt(output: string): string {
  const buf = Buffer.from(output, "utf8");
  if (buf.length <= EVIDENCE_EXCERPT_BYTES) return output;
  let start = buf.length - EVIDENCE_EXCERPT_BYTES;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
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

  // ── 4. metrics shape + key-safety validation (before payload check) ───────
  if (input.metrics !== undefined) {
    for (const [key, val] of Object.entries(input.metrics)) {
      // A metric key is an identifier, never secret payload. Reject a
      // secret-shaped key fail-closed and do NOT echo the key in the error
      // (path/message) so the rejection itself cannot leak it. Benign names
      // such as `api_key_rotations` are not flagged (no token shape / no
      // assignment punctuation). The check precedes the value-type throw below
      // so that throw never echoes a secret key either.
      if (containsLikelySecret(key)) {
        throwValidation(
          "EVIDENCE_METRIC_KEY_SECRET",
          "a metric key looks like a secret; use a non-secret identifier as the key",
          "metrics",
        );
      }
      if (typeof val !== "string" && typeof val !== "number") {
        throwValidation(
          "EVIDENCE_METRICS_INVALID_VALUE",
          `metrics["${key}"] must be a string or number, got ${typeof val}`,
          `metrics.${key}`,
        );
      }
    }
  }

  // ── 5. normalize payload + non-empty gate ─────────────────────────────────
  // A blank (whitespace-only) command/output is NOT payload, so normalize it to
  // "absent" up front. The gate, kind inference, redaction, and storage then
  // all agree — `--output ""` cannot bypass the gate, and a blank `--command`
  // cannot be stored or mislabel the row as kind=command.
  const command =
    input.command !== undefined && input.command.trim() !== ""
      ? input.command
      : undefined;
  const output =
    input.output !== undefined && input.output.trim() !== ""
      ? input.output
      : undefined;
  const hasMetrics =
    input.metrics !== undefined && Object.keys(input.metrics).length > 0;

  if (command === undefined && output === undefined && !hasMetrics) {
    throwValidation(
      "EVIDENCE_PAYLOAD_EMPTY",
      "at least one payload field is required (command, output, or metrics)",
      "payload",
    );
  }

  // ── 6. redaction ──────────────────────────────────────────────────────────
  let secretSuspect = false;
  let redacted = false;

  // `label` is operator-supplied free text surfaced on `evidence list` and
  // `hitch status`, so it gets the same mandatory scan as command/output.
  let safeLabel = input.label;
  {
    const r = redactField(input.label);
    if (r.flagged) {
      safeLabel = r.value;
      secretSuspect = true;
      redacted = true;
    }
  }

  let safeCommand: string | null = null;
  if (command !== undefined) {
    const r = redactField(command);
    safeCommand = r.value;
    if (r.flagged) {
      secretSuspect = true;
      redacted = true;
    }
  }

  let outputExcerpt: string | null = null;
  if (output !== undefined) {
    const r = redactField(output);
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
  const kind = inferKind(input.kind, command !== undefined, hasMetrics);

  // ── 8. build the row (attester is HARDCODED — never from input) ───────────
  const row: HitchEvidence = {
    evidenceId,
    hitchId: input.hitchId,
    runId: input.runId ?? null,
    conditionId: input.conditionId ?? null,
    kind,
    attester: "operator", // HARDCODED — NEVER read from input
    label: safeLabel,
    command: safeCommand,
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
