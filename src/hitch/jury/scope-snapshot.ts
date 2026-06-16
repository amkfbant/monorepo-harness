import type { HitchSession } from "../types.js";

/**
 * #230 FIX 1 (codex#254 ROUND-3 P1) — the READ-ONLY frozen hitch scope snapshot
 * threaded into every jury prompt (proposer / critique / refuter).
 *
 * WHY: the jury classifies whether a finding is "in scope for THIS change". The
 * definition of "in scope" lives in the hitch session's frozen scope (goal /
 * target operations / target files / categories / close conditions) — NOT in the
 * finding text. Without this snapshot a unanimous jury could `auto_confirm`
 * in_scope/out_of_scope WITHOUT ever seeing the session scope, so a blocker could
 * be misclassified instead of failing closed. Threading the snapshot makes every
 * lens classify AGAINST the actual scope.
 *
 * Safety boundary: this snapshot is READ-ONLY prompt CONTEXT. It never feeds a
 * state transition and the LLM cannot mutate it. When the scope is genuinely
 * unavailable the caller fails closed (escalate / inconclusive); it is never a
 * silent auto_confirm.
 */

/** A frozen, read-only projection of the hitch scope for jury prompt context. */
export interface HitchScopeSnapshot {
  /** The change's goal (session title, optionally with description). */
  goal: string;
  domain?: string;
  targetSummary?: string;
  targetFiles?: string[];
  targetOperations?: string[];
  allowedFindingCategories?: string[];
  excludedCategories?: string[];
  notes?: string;
  /** Human-readable close conditions (id/kind/description), advisory context. */
  closeConditions?: string[];
}

/** Drop empty-string / whitespace-only entries; return undefined when none remain. */
function nonEmptyList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const cleaned = values.map((v) => v.trim()).filter((v) => v !== "");
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Render one close condition into a single human-readable line. */
function renderCloseCondition(c: HitchSession["closeConditions"][number]): string {
  const parts = [
    c.id,
    `(${c.kind}${c.required ? ", required" : ""})`,
    c.description?.trim() ? `— ${c.description.trim()}` : "",
  ].filter((p) => p !== "");
  return parts.join(" ");
}

/**
 * Build the READ-ONLY scope snapshot from a hitch session (the same session the
 * classify runner already loads READ-ONLY in Phase 1). Pure projection — no IO,
 * no mutation. `goal` always carries at least the session title.
 */
export function snapshotFromSession(session: HitchSession): HitchScopeSnapshot {
  const description = session.description?.trim();
  const goal =
    description !== undefined && description !== ""
      ? `${session.title.trim()} — ${description}`
      : session.title.trim();
  const domain =
    session.domain !== null && session.domain.trim() !== ""
      ? session.domain.trim()
      : undefined;
  const targetSummary =
    session.scope.targetSummary !== undefined &&
    session.scope.targetSummary.trim() !== ""
      ? session.scope.targetSummary.trim()
      : undefined;
  const notes =
    session.scope.notes !== undefined && session.scope.notes.trim() !== ""
      ? session.scope.notes.trim()
      : undefined;
  const targetFiles = nonEmptyList(session.scope.targetFiles);
  const targetOperations = nonEmptyList(session.scope.targetOperations);
  const allowedFindingCategories = nonEmptyList(
    session.scope.allowedFindingCategories,
  );
  const excludedCategories = nonEmptyList(session.scope.excludedCategories);
  const closeConditions = nonEmptyList(
    session.closeConditions.map(renderCloseCondition),
  );
  return {
    goal,
    ...(domain !== undefined ? { domain } : {}),
    ...(targetSummary !== undefined ? { targetSummary } : {}),
    ...(targetFiles !== undefined ? { targetFiles } : {}),
    ...(targetOperations !== undefined ? { targetOperations } : {}),
    ...(allowedFindingCategories !== undefined
      ? { allowedFindingCategories }
      : {}),
    ...(excludedCategories !== undefined ? { excludedCategories } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(closeConditions !== undefined ? { closeConditions } : {}),
  };
}

/**
 * Render the scope snapshot into deterministic prompt-text lines. Every lens
 * (proposer / critique / refuter) embeds this block so it classifies AGAINST the
 * frozen scope, not just the finding text. Lists are rendered as comma-joined
 * values; absent fields are omitted (the goal line is always present).
 */
export function renderScopeSnapshot(snapshot: HitchScopeSnapshot): string {
  const list = (label: string, values: string[] | undefined): string =>
    values !== undefined && values.length > 0
      ? `- ${label}: ${values.join(", ")}`
      : "";
  return [
    "Frozen hitch scope (READ-ONLY) — classify the finding AGAINST this scope:",
    `- goal: ${snapshot.goal}`,
    snapshot.domain !== undefined ? `- domain: ${snapshot.domain}` : "",
    snapshot.targetSummary !== undefined
      ? `- targetSummary: ${snapshot.targetSummary}`
      : "",
    list("targetFiles", snapshot.targetFiles),
    list("targetOperations", snapshot.targetOperations),
    list("allowedFindingCategories", snapshot.allowedFindingCategories),
    list("excludedCategories", snapshot.excludedCategories),
    snapshot.notes !== undefined ? `- notes: ${snapshot.notes}` : "",
    snapshot.closeConditions !== undefined && snapshot.closeConditions.length > 0
      ? [
          "- closeConditions:",
          ...snapshot.closeConditions.map((c) => `    - ${c}`),
        ].join("\n")
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
