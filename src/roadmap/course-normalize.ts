export const DEFAULT_MAX_DRIVEN_HITCHES = 3;
export const MAX_DRIVEN_HITCHES = 10;
export const DEFAULT_MAX_STEPS_PER_HITCH = 20;
export const MAX_STEPS_PER_HITCH = 50;

export function normalizeBoundedPositiveInt(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  const requested =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : defaultValue;
  if (requested <= 0) return defaultValue;
  return Math.min(maxValue, requested);
}

export function normalizeCourseMaxDrivenHitches(value: number | undefined): number {
  return normalizeBoundedPositiveInt(
    value,
    DEFAULT_MAX_DRIVEN_HITCHES,
    MAX_DRIVEN_HITCHES,
  );
}

export function normalizeCourseMaxStepsPerHitch(value: number | undefined): number {
  return normalizeBoundedPositiveInt(
    value,
    DEFAULT_MAX_STEPS_PER_HITCH,
    MAX_STEPS_PER_HITCH,
  );
}
