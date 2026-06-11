import type { HitchConvergenceResult } from "../hitch/types.js";

/**
 * phase が "ready-to-close" かを live convergence から純粋に判定する（stored しない）。
 * 全 linked hitch が close_ready/closed、かつ独立 SQL 集計の derived open in-scope
 * P0/P1 がゼロ、かつ hitch が 1 つ以上。derived P0/P1 の再チェックは close_ready が
 * 既に内包するため論理冗長だが、独立集計による defense-in-depth として保持する。
 */
export function derivePhaseReadiness(input: {
  hitchConvergences: HitchConvergenceResult[];
  derivedOpenP0: number;
  derivedOpenP1: number;
}): boolean {
  if (input.hitchConvergences.length === 0) return false;
  const allReady = input.hitchConvergences.every(
    (c) => c.decision === "close_ready" || c.decision === "closed",
  );
  return allReady && input.derivedOpenP0 === 0 && input.derivedOpenP1 === 0;
}
