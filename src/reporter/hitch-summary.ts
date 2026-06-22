// Pure renderer + safe-input contract for `harness hitch summary` (#84 Stage A).
//
// SAFETY MODEL (read before editing — see docs/specs/cli.md "hitch summary"):
// This module renders a course-scoped digest of hitch sessions for operators.
// Hitch findings carry LLM/codex-authored free text (summary, detail, …) that
// MUST NOT leak verbatim into an audit/report artifact. The defence is split:
//
//   1. STRUCTURAL fail-closed (this file): the renderer accepts ONLY the
//      `SafeCourseSummary` projection. Every free-text field is typed
//      `RedactedText` — a brand constructible ONLY via `redactFreeText`. A raw
//      finding/session string is therefore NOT assignable into the projection,
//      and a NEW free-text column added to a DB row cannot reach the renderer
//      unless someone routes it through the gate. The aggregate layer
//      (src/cli/hitch/summary-aggregate.ts) maps named fields explicitly — it
//      never spreads a raw row — so the allowlist is enforced at the type level.
//
//   2. CONTENT fail-closed (`redactFreeText`): the gate withholds the WHOLE
//      field when it looks secret-shaped (containsLikelySecret) and otherwise
//      collapses newlines (noteForMarkdownLine) so free text cannot inject a
//      Markdown heading/block. Structural headings are emitted by THIS renderer
//      only; free text always appears mid-line after a `- Label:` prefix.
//
// The renderer itself does NO redaction and touches NO DB — by the time data
// arrives here it is already gated. Keep it that way.

import { containsLikelySecret } from "./secret-scan.js";
import { noteForMarkdownLine } from "./markdown-line.js";
import type { HitchFindingSummaryCounts } from "../hitch/repositories/finding-helpers.js";
import type {
  HitchConvergenceDecision,
  HitchFindingSeverity,
  HitchFindingSource,
  HitchLifecycleStatus,
  HitchScopeStatus,
  HitchStatus,
} from "../hitch/types.js";
import type { CourseStatus, PhaseStatus } from "../roadmap/types.js";

declare const redactedBrand: unique symbol;

/**
 * A string that has passed the free-text safety gate. The brand is private
 * (`unique symbol`), so the ONLY way to obtain a `RedactedText` is
 * {@link redactFreeText}; a plain string is not assignable. This is what makes
 * the projection an allowlist at the type level.
 */
export type RedactedText = string & { readonly [redactedBrand]: true };

/** Whole-field replacement when free text is withheld (secret-shaped). */
export const REDACTED_PLACEHOLDER = "[redacted]" as RedactedText;

/**
 * The SOLE constructor of {@link RedactedText}. Fail-closed: a secret-shaped
 * input yields the placeholder (whole field withheld — never partial, so a clip
 * cannot sever a token); otherwise newlines collapse to one line. The secret
 * check runs on the RAW input (multi-line aware) before collapsing.
 */
export function redactFreeText(raw: string): RedactedText {
  if (containsLikelySecret(raw)) return REDACTED_PLACEHOLDER;
  return noteForMarkdownLine(raw) as RedactedText;
}

export interface InterventionCounts {
  reopened: number;
  prAdopted: number;
  divergingRecovered: number;
  updated: number;
}

export interface SafeFindingLine {
  findingId: string;
  source: HitchFindingSource;
  severity: HitchFindingSeverity;
  scopeStatus: HitchScopeStatus;
  lifecycleStatus: HitchLifecycleStatus;
  category: RedactedText;
  summary: RedactedText;
  firstSeenAt: string;
}

export interface SafeHitchLine {
  hitchId: string;
  title: RedactedText;
  status: HitchStatus;
  /** Latest PERSISTED convergence decision (enum only) — never `evaluate()`. */
  latestDecision: HitchConvergenceDecision | null;
  findingCounts: HitchFindingSummaryCounts;
  escalated: boolean;
  interventionCounts: InterventionCounts;
  pr: { number: number | null; url: string | null } | null;
  findings: readonly SafeFindingLine[];
}

export interface SafePhaseGroup {
  phaseId: string;
  title: RedactedText;
  status: PhaseStatus;
  hitches: readonly SafeHitchLine[];
}

export interface SafeCourseSummary {
  courseId: string;
  title: RedactedText;
  description: RedactedText | null;
  status: CourseStatus;
  /**
   * Active time-window filter as canonical ISO (a null bound = open-ended).
   * Present ONLY when `--since`/`--until` was supplied (#84 Stage B); strings
   * are derived from validated epoch-ms via toISOString(), so they are
   * structurally injection-safe (no newlines) — not operator free text.
   */
  window?: { sinceIso: string | null; untilIso: string | null };
  /** Rolled up by summing per-hitch counts — NOT via rollupCourse (which runs
   * a per-hitch convergence.evaluate(); see the aggregate layer). */
  openInScopeP0: number;
  openInScopeP1: number;
  phases: readonly SafePhaseGroup[];
}

// IDs and PR URLs are NOT secret-redacted free text, but hitch/course/phase IDs
// are operator-supplied and NOT charset-validated at write time (`hitch start
// --hitch-id <arbitrary>`), so a newline-bearing identifier could otherwise
// break out of its line and inject a Markdown heading. Collapse every raw plain
// string the renderer interpolates. RedactedText fields are already collapsed.
function inline(s: string): string {
  return noteForMarkdownLine(s);
}

function renderFinding(f: SafeFindingLine): string {
  return (
    `  - [${f.severity}/${f.scopeStatus}/${f.lifecycleStatus}] ${f.summary}` +
    ` (source=${f.source}, category=${f.category}, id=${inline(f.findingId)})`
  );
}

function renderHitch(h: SafeHitchLine): string[] {
  const c = h.findingCounts;
  const lines: string[] = [
    `### ${inline(h.hitchId)} — status: ${h.status}`,
    `- Title: ${h.title}`,
    `- Convergence: ${h.latestDecision ?? "(none)"}`,
    `- Findings: P0=${c.openInScopeP0} P1=${c.openInScopeP1}` +
      ` P2=${c.openInScopeP2} unknown=${c.openUnknownScope}` +
      ` outOfScope=${c.openOutOfScope}`,
  ];
  if (h.escalated) lines.push(`- Escalated: yes`);
  const iv = h.interventionCounts;
  if (iv.reopened + iv.prAdopted + iv.divergingRecovered + iv.updated > 0) {
    lines.push(
      `- Interventions: reopened=${iv.reopened} pr_adopted=${iv.prAdopted}` +
        ` diverging_recovered=${iv.divergingRecovered} updated=${iv.updated}`,
    );
  }
  if (h.pr !== null && (h.pr.number !== null || h.pr.url !== null)) {
    const num = h.pr.number !== null ? `#${h.pr.number}` : "(no number)";
    const url = h.pr.url !== null ? ` ${inline(h.pr.url)}` : "";
    lines.push(`- PR: ${num}${url}`);
  }
  if (h.findings.length > 0) {
    lines.push(`- Findings:`);
    for (const f of h.findings) lines.push(renderFinding(f));
  }
  lines.push("");
  return lines;
}

function renderPhase(p: SafePhaseGroup): string[] {
  const lines: string[] = [`## Phase: ${p.title}  (${inline(p.phaseId)})  — status: ${p.status}`, ""];
  if (p.hitches.length === 0) {
    lines.push("_(no hitches)_", "");
    return lines;
  }
  for (const h of p.hitches) lines.push(...renderHitch(h));
  return lines;
}

/** Render an already-gated {@link SafeCourseSummary} to deterministic Markdown. */
export function renderHitchSummary(summary: SafeCourseSummary): string {
  const lines: string[] = [`# Hitch Summary: ${summary.title}`, ""];
  lines.push(`- Course: ${inline(summary.courseId)}`);
  lines.push(`- Status: ${summary.status}`);
  if (summary.window !== undefined) {
    const since = summary.window.sinceIso !== null ? inline(summary.window.sinceIso) : "(open)";
    const until = summary.window.untilIso !== null ? inline(summary.window.untilIso) : "(open)";
    lines.push(`- Window (session updatedAt): since=${since} until=${until}`);
  }
  if (summary.description !== null) {
    lines.push(`- Description: ${summary.description}`);
  }
  lines.push(`- Open P0 (in-scope): ${summary.openInScopeP0}`);
  lines.push(`- Open P1 (in-scope): ${summary.openInScopeP1}`);
  lines.push("");
  if (summary.phases.length === 0) {
    lines.push("_(no phases)_", "");
  } else {
    for (const p of summary.phases) lines.push(...renderPhase(p));
  }
  return lines.join("\n");
}
