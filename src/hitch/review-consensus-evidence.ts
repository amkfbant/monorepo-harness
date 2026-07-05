import type { HitchEvidence } from "./types.js";

const TRANSCRIPT_EXCERPT_BYTES = 8192;
const MAX_COMPLETE_TRANSCRIPT_BYTES = TRANSCRIPT_EXCERPT_BYTES - 4;
const P0_KEYS = ["openInScopeP0", "open_in_scope_p0", "p0", "P0"] as const;
const P1_KEYS = ["openInScopeP1", "open_in_scope_p1", "p1", "P1"] as const;

export type ReviewConsensusEvidenceEvaluation =
  | { status: "passed"; evidenceId: string }
  | { status: "blocked"; evidenceId: string; reason: string }
  | { status: "missing" };

type RowDecision =
  | { status: "passed" }
  | { status: "blocked"; reason: string }
  | { status: "none" };

type JsonCandidateDecision =
  | { status: "passed" }
  | { status: "blocked"; reason: string }
  | { status: "none" };

type ReviewFindingRowsDecision =
  | { status: "passed"; rows: readonly unknown[] }
  | { status: "blocked"; reason: string };

export function evaluateReviewConsensusEvidenceRows(
  conditionId: string,
  freshAfter: string | null,
  evidenceRows: readonly HitchEvidence[],
): ReviewConsensusEvidenceEvaluation {
  const candidates = evidenceRows
    .filter(
      (row) =>
        row.attester === "operator" &&
        row.conditionId === conditionId &&
        (freshAfter === null || row.createdAt >= freshAfter),
    )
    .sort(newestEvidenceFirst);

  for (const row of candidates) {
    const decision = reviewConsensusEvidenceDecision(row);
    if (decision.status === "none") continue;
    if (decision.status === "passed") {
      return { status: "passed", evidenceId: row.evidenceId };
    }
    return {
      status: "blocked",
      evidenceId: row.evidenceId,
      reason: decision.reason,
    };
  }
  return { status: "missing" };
}

function newestEvidenceFirst(a: HitchEvidence, b: HitchEvidence): number {
  const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return b.evidenceId.localeCompare(a.evidenceId);
}

function reviewConsensusEvidenceDecision(row: HitchEvidence): RowDecision {
  if (row.kind === "metrics") {
    return reviewConsensusMetricsDecision(row.summaryMetrics);
  }
  if (row.kind === "transcript") {
    return reviewConsensusTranscriptDecision(row.outputExcerpt);
  }
  return { status: "none" };
}

function reviewConsensusMetricsDecision(
  metrics: Record<string, unknown>,
): RowDecision {
  const p0 = metricZero(metrics, P0_KEYS, "P0");
  if (p0.status === "blocked") return p0;
  const p1 = metricZero(metrics, P1_KEYS, "P1");
  if (p1.status === "blocked") return p1;
  return { status: "passed" };
}

function metricZero(
  metrics: Record<string, unknown>,
  keys: readonly string[],
  label: "P0" | "P1",
): RowDecision {
  let found = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(metrics, key)) continue;
    found = true;
    const value = metrics[key];
    if (value === 0) continue;
    if (typeof value === "string" && value.trim() === "0") continue;
    return {
      status: "blocked",
      reason: `${label} metric ${key} is non-zero or unparseable`,
    };
  }
  return found
    ? { status: "passed" }
    : { status: "blocked", reason: `${label} metric is missing` };
}

function reviewConsensusTranscriptDecision(
  outputExcerpt: string | null,
): RowDecision {
  if (outputExcerpt === null) return { status: "none" };
  if (Buffer.byteLength(outputExcerpt, "utf8") > MAX_COMPLETE_TRANSCRIPT_BYTES) {
    return {
      status: "blocked",
      reason: "transcript evidence is at or near the excerpt cap; attach a shorter complete transcript",
    };
  }

  const json = reviewJsonDecision(outputExcerpt);
  if (json.status !== "none") return json;

  const normalized = outputExcerpt.toLowerCase();
  if (normalized.includes("didn't find any major issues")) {
    return { status: "passed" };
  }
  if (normalized.includes("did not find any major issues")) {
    return { status: "passed" };
  }
  return { status: "none" };
}

function reviewJsonDecision(text: string): JsonCandidateDecision {
  let sawPassingJson = false;
  for (const candidate of reviewJsonCandidates(text)) {
    const decision = reviewJsonCandidateDecision(candidate);
    if (decision.status === "blocked") return decision;
    if (decision.status === "passed") sawPassingJson = true;
  }
  return sawPassingJson ? { status: "passed" } : { status: "none" };
}

function reviewJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  const stripped = stripWrappingFence(trimmed);
  if (stripped !== trimmed || isBracedObject(stripped)) candidates.push(stripped);

  const fence = /```([A-Za-z0-9_-]*)?\s*([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const language = (match[1] ?? "").toLowerCase();
    const body = (match[2] ?? "").trim();
    if (
      language === "json" ||
      isBracedObject(body) ||
      looksLikeReviewJson(body)
    ) {
      candidates.push(body);
    }
  }

  for (const candidate of extractReviewObjectCandidates(text)) {
    candidates.push(candidate);
  }

  return [...new Set(candidates)];
}

function extractReviewObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "{") continue;
    const end = findMatchingBrace(text, index);
    if (end === null) {
      const tail = text.slice(index).trim();
      if (looksLikeReviewJson(tail)) candidates.push(tail);
      continue;
    }
    const candidate = text.slice(index, end + 1);
    if (looksLikeReviewJson(candidate)) candidates.push(candidate);
    index = end;
  }
  return candidates;
}

function findMatchingBrace(text: string, start: number): number | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return null;
}

function stripWrappingFence(text: string): string {
  if (!text.startsWith("```") || !text.endsWith("```")) return text;
  const inner = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return inner.includes("```") ? text : inner;
}

function isBracedObject(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function reviewJsonCandidateDecision(candidate: string): JsonCandidateDecision {
  const trimmed = candidate.trim();
  if (!isBracedObject(trimmed)) {
    return looksLikeReviewJson(trimmed)
      ? { status: "blocked", reason: "review JSON is malformed" }
      : { status: "none" };
  }
  try {
    return reviewConsensusJsonDecision(JSON.parse(trimmed) as unknown);
  } catch {
    return looksLikeReviewJson(trimmed)
      ? { status: "blocked", reason: "review JSON is malformed" }
      : { status: "none" };
  }
}

function looksLikeReviewJson(text: string): boolean {
  return /(?:^|[,{]\s*)["']?(?:ready_to_merge|readyToMerge|verdict|findings|issues)["']?\s*:/.test(
    text,
  );
}

function reviewConsensusJsonDecision(parsed: unknown): JsonCandidateDecision {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "none" };
  }
  const obj = parsed as Record<string, unknown>;
  if (!hasReviewJsonFields(obj)) return { status: "none" };
  const ready = reviewReadyDecision(obj);
  if (ready.status === "blocked") return ready;
  const findings = reviewFindingRows(obj);
  if (findings.status === "blocked") return findings;
  return noBlockingReviewFindings(findings.rows)
    ? { status: "passed" }
    : { status: "blocked", reason: "review JSON contains blocking findings" };
}

function reviewReadyDecision(obj: Record<string, unknown>): RowDecision {
  const values: Array<"ready" | "not_ready"> = [];
  for (const key of ["ready_to_merge", "readyToMerge"] as const) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    if (value === true) values.push("ready");
    else if (value === false) values.push("not_ready");
    else return { status: "blocked", reason: `${key} is not boolean` };
  }
  if (Object.prototype.hasOwnProperty.call(obj, "verdict")) {
    if (obj.verdict === "ready_to_merge") values.push("ready");
    else values.push("not_ready");
  }
  if (values.length === 0) {
    return {
      status: "blocked",
      reason: "review JSON is missing a ready verdict",
    };
  }
  const unique = new Set(values);
  if (unique.size > 1) {
    return {
      status: "blocked",
      reason: "review JSON has conflicting ready verdict aliases",
    };
  }
  return values[0] === "ready"
    ? { status: "passed" }
    : { status: "blocked", reason: "review JSON is not ready_to_merge" };
}

function reviewFindingRows(
  obj: Record<string, unknown>,
): ReviewFindingRowsDecision {
  const rows: unknown[] = [];
  let sawFindingSource = false;
  for (const key of ["findings", "issues"] as const) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    sawFindingSource = true;
    const value = obj[key];
    if (!Array.isArray(value)) {
      return {
        status: "blocked",
        reason: `review JSON ${key} is not an array`,
      };
    }
    rows.push(...value);
  }
  if (!sawFindingSource) {
    return {
      status: "blocked",
      reason: "review JSON is missing a findings or issues array",
    };
  }
  return { status: "passed", rows };
}

function hasReviewJsonFields(obj: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(obj, "ready_to_merge") ||
    Object.prototype.hasOwnProperty.call(obj, "readyToMerge") ||
    Object.prototype.hasOwnProperty.call(obj, "verdict") ||
    Object.prototype.hasOwnProperty.call(obj, "findings") ||
    Object.prototype.hasOwnProperty.call(obj, "issues")
  );
}

function noBlockingReviewFindings(findings: readonly unknown[]): boolean {
  for (const finding of findings) {
    if (typeof finding !== "object" || finding === null) return false;
    const record = finding as Record<string, unknown>;
    const severity = parseReviewFindingSeverity(record);
    const scope = parseReviewFindingScope(record);
    if (severity === null || scope === null) return false;
    if (
      (severity === "P0" || severity === "P1") &&
      scope !== "out_of_scope" &&
      scope !== "duplicate"
    ) {
      return false;
    }
  }
  return true;
}

function parseReviewFindingSeverity(
  finding: Record<string, unknown>,
): "P0" | "P1" | "P2" | "P3" | "INFO" | null {
  const explicit = ["severity", "priority"]
    .filter((key) => Object.prototype.hasOwnProperty.call(finding, key))
    .map((key) => finding[key]);
  if (explicit.length > 0) {
    const parsed = explicit.map((value) =>
      typeof value === "string" ? normalizeReviewSeverity(value) : null,
    );
    if (parsed.some((value) => value === null)) return null;
    const unique = new Set(parsed);
    const first = parsed[0];
    return unique.size === 1 && first !== undefined ? first : null;
  }
  if (typeof finding.title === "string") {
    const m = finding.title.match(/\b(P[0-3]|info)\b/i);
    if (m?.[1] !== undefined) return normalizeReviewSeverity(m[1]);
  }
  return null;
}

function normalizeReviewSeverity(
  raw: string,
): "P0" | "P1" | "P2" | "P3" | "INFO" | null {
  const normalized = raw.trim().toUpperCase();
  if (
    normalized === "P0" ||
    normalized === "P1" ||
    normalized === "P2" ||
    normalized === "P3" ||
    normalized === "INFO"
  ) {
    return normalized;
  }
  return null;
}

function parseReviewFindingScope(
  finding: Record<string, unknown>,
): "in_scope" | "out_of_scope" | "unknown" | "duplicate" | null {
  const explicit = ["scopeStatus", "scope_status"]
    .filter((key) => Object.prototype.hasOwnProperty.call(finding, key))
    .map((key) => finding[key]);
  if (explicit.length === 0) return "in_scope";
  const parsed = explicit.map((raw) => {
    if (typeof raw !== "string") return null;
    return normalizeReviewScope(raw);
  });
  if (parsed.some((value) => value === null)) return null;
  const unique = new Set(parsed);
  const first = parsed[0];
  return unique.size === 1 && first !== undefined ? first : null;
}

function normalizeReviewScope(
  raw: string,
): "in_scope" | "out_of_scope" | "unknown" | "duplicate" | null {
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
  if (
    normalized === "in_scope" ||
    normalized === "out_of_scope" ||
    normalized === "unknown" ||
    normalized === "duplicate"
  ) {
    return normalized;
  }
  return null;
}
