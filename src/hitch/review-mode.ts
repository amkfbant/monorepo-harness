import type {
  HitchReviewCycle,
  HitchReviewMode,
  HitchSession,
} from "./types.js";

export function nextReviewMode(
  session: HitchSession,
  cycles: HitchReviewCycle[],
): HitchReviewMode {
  const sequence = session.policy.reviewModeSequence;
  if (sequence.length === 0) return "manual";
  const completedOrStarted = cycles.length;
  return sequence[Math.min(completedOrStarted, sequence.length - 1)] ?? "manual";
}

export function reviewModePurpose(mode: HitchReviewMode): string {
  switch (mode) {
    case "initial":
      return "review the full frozen hitch scope against close conditions";
    case "delta":
      return "verify previous fixes and changed files; default unrelated findings out of scope";
    case "close":
      return "decide whether original close conditions are satisfied";
    case "regression":
      return "check safety boundaries, tests, and policy gates";
    case "manual":
      return "operator-selected review mode";
  }
}
