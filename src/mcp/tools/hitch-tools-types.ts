// hitch-tools の引数 shape 型 + MCP finding/text の上限定数（leaf）。

import type { HitchCloseCheckStatus, HitchCloseCondition, HitchFindingSeverity, HitchFindingSource, HitchPolicy, HitchScope, HitchScopeStatus, HitchStatus } from "../../hitch/types.js";

export const MAX_FINDINGS_PER_CALL = 50;
export const MAX_MCP_FINDINGS = 100;
export const MAX_MCP_FINDING_TEXT_CHARS = 1000;

export interface MutationBaseArgs {
  idempotencyKey: string;
  actorNote?: string;
}

export interface HitchListArgs {
  status?: HitchStatus;
  projectId?: string;
  repoId?: string;
  domain?: string;
  limit?: number;
}

export interface HitchIdArgs {
  hitchId: string;
}

export interface HitchStartArgs extends MutationBaseArgs {
  hitchId?: string;
  title: string;
  description?: string;
  projectId?: string;
  repoId?: string;
  domain?: string;
  backlogItemId?: string;
  scope?: HitchScope;
  closeConditions?: HitchCloseCondition[];
  policy?: HitchPolicy;
  maxIterations?: number;
  maxReviewCycles?: number;
  maxReruns?: number;
  maxTotalNewFindings?: number;
}

export interface HitchFindingInput {
  severity: HitchFindingSeverity;
  category: string;
  summary: string;
  detail?: string;
  filePath?: string;
  symbol?: string;
  suggestedFix?: string;
  source?: HitchFindingSource;
  sourceRef?: string;
  sourceAttemptId?: string;
  sourceCycleId?: string;
  scopeStatus?: HitchScopeStatus;
}

export interface HitchRecordFindingsArgs extends MutationBaseArgs {
  hitchId: string;
  findings: HitchFindingInput[];
}

export interface HitchClassifyFindingArgs extends MutationBaseArgs {
  findingId: string;
  scopeStatus: HitchScopeStatus;
  reason: string;
  duplicateOf?: string;
}

export interface HitchMarkFindingFixedArgs extends MutationBaseArgs {
  findingId: string;
  note?: string;
}

export interface HitchDeferFindingArgs extends MutationBaseArgs {
  findingId: string;
  reason: string;
  createBacklogItem?: boolean;
}

export interface HitchRecordCloseCheckArgs extends MutationBaseArgs {
  hitchId: string;
  conditionId: string;
  status: HitchCloseCheckStatus;
  checkedBy?: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

export interface HitchCheckConvergenceArgs extends MutationBaseArgs {
  hitchId: string;
  /** When false, record the decision but do not sync hitch_sessions.status
   *  (parity with the CLI `convergence --no-status-update`). */
  updateStatus?: boolean;
}

export interface HitchCloseArgs extends MutationBaseArgs {
  hitchId: string;
  summary: string;
  force?: boolean;
}

export interface HitchCancelArgs extends MutationBaseArgs {
  hitchId: string;
  reason: string;
}

export interface HitchExpandScopeArgs extends MutationBaseArgs {
  hitchId: string;
  scope: HitchScope;
  reason: string;
}
