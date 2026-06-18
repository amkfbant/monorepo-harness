import type { HitchCloseCondition, HitchScope } from "./types.js";

export function isScopeWidening(
  previous: HitchScope,
  next: HitchScope,
): boolean {
  if (targetFilesWiden(previous.targetFiles, next.targetFiles)) return true;
  if (arrayFieldWidens(previous.targetOperations, next.targetOperations)) {
    return true;
  }
  if (
    arrayFieldWidens(
      previous.allowedFindingCategories,
      next.allowedFindingCategories,
    )
  ) {
    return true;
  }
  if (
    excludedCategoriesWiden(
      previous.excludedCategories,
      next.excludedCategories,
    )
  ) {
    return true;
  }
  return (previous.targetSummary ?? null) !== (next.targetSummary ?? null);
}

export function arrayFieldWidens(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): boolean {
  // `targetOperations` / `allowedFindingCategories` are positive in-scope
  // matchers (classification.ts): widening means the next set is not a subset
  // of the previous one.
  const nextArr = next ?? [];
  if (nextArr.length === 0) return false;
  const previousSet = new Set(previous ?? []);
  return nextArr.some((value) => !previousSet.has(value));
}

export function targetFilesWiden(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): boolean {
  // `targetFiles` gates outside-pattern findings to out_of_scope, so removing
  // the gate or adding a new admitted pattern can both widen the scope.
  const prev = previous ?? [];
  const nxt = next ?? [];
  if (prev.length === 0 && nxt.length === 0) return false;
  if (nxt.length === 0 || prev.length === 0) return true;
  const previousSet = new Set(prev);
  return nxt.some((value) => !previousSet.has(value));
}

export function excludedCategoriesWiden(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): boolean {
  if (previous === undefined) return false;
  if (next === undefined) return true;
  const nextSet = new Set(next);
  return previous.some((value) => !nextSet.has(value));
}

export function closeConditionsLoosenGate(
  previous: readonly HitchCloseCondition[],
  next: readonly HitchCloseCondition[],
): boolean {
  const nextById = new Map(next.map((condition) => [condition.id, condition]));
  for (const condition of previous) {
    if (!condition.required) continue;
    const replacement = nextById.get(condition.id);
    if (replacement === undefined) return true;
    if (!replacement.required) return true;
    if (
      conditionGateFingerprint(condition) !==
      conditionGateFingerprint(replacement)
    ) {
      return true;
    }
  }
  return false;
}

export function conditionGateFingerprint(
  condition: HitchCloseCondition,
): string {
  return JSON.stringify({
    kind: condition.kind,
    command: condition.command ?? null,
    rule: condition.rule ?? null,
    metadata: condition.metadata ?? null,
  });
}
