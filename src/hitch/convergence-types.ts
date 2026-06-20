// convergence の close-check 定数 + pending routing 型（leaf）。

import type { HitchCloseCondition } from "./types.js";

export const CLOSE_CHECK_ATTEMPT_TYPE = "close-check";
export const ADVISORY_FINDING_ID_LIMIT = 200;
export const RUNNABLE_CLOSE_CHECK_STATUSES = new Set([
  "pending",
  "skipped",
  "unknown",
]);

export interface PendingCloseCheckRouting {
  hasRunnableCommand: boolean;
  externalEvidenceConditions: PendingExternalEvidenceCondition[];
  /**
   * #308 P2-2: pending facet_red_test conditions whose disposition is
   * code-recoverable (no covering test present → evidence alone can never clear
   * them). These route to a coder rerun (needs_fix), NOT ask_human.
   */
  codeRecoverableFacetConditionIds: string[];
}

export interface PendingExternalEvidenceCondition {
  conditionId: string;
  kind: HitchCloseCondition["kind"];
  description: string | null;
  pendingCycles: number;
}
