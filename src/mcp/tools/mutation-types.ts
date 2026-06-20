// mutation-tools の引数 shape 型 + 小 util（leaf）。

export interface MutationBaseArgs {
  idempotencyKey: string;
  actorNote?: string;
}

export interface RunStartArgs extends MutationBaseArgs {
  projectId: string;
  domain: string;
  goal: string;
  contextPack?: string;
  hitchId?: string;
}

export interface RunArgs extends MutationBaseArgs {
  runId: string;
  hitchId?: string;
}

export interface OrchestrateHitchArgs extends MutationBaseArgs {
  hitchId: string;
  maxSteps?: number;
}

export interface ReviewAutoArgs extends RunArgs {
  reviewer?: string;
}

export function defaultMcpReviewerId(clientName: string): string {
  const suffix = clientName
    .replaceAll(/[^A-Za-z0-9._-]/g, "-")
    .replaceAll(/\.+/g, ".")
    .replaceAll(/-+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 124);
  return `mcp-${suffix || "client"}`;
}

export interface BacklogCreateArgs extends MutationBaseArgs {
  projectId?: string;
  repoId?: string;
  domain: string;
  title: string;
  goal: string;
  priority?: "high" | "medium" | "low";
  tags?: string[];
}

export interface BacklogRunArgs extends MutationBaseArgs {
  itemId: string;
  workflow?: "run" | "reviewed-run";
}

export interface BacklogUpdateArgs extends MutationBaseArgs {
  itemId: string;
  status?: "open" | "doing" | "done" | "deferred";
  title?: string;
  goal?: string;
}

export interface KnowledgeDecisionArgs extends MutationBaseArgs {
  candidateId: string;
  reason?: string;
}

export interface OpsKnowledgeRecordArgs extends MutationBaseArgs {
  title: string;
  body: string;
  key: string;
  kind?: string;
  tags?: string[];
  projectId?: string;
  repoId?: string;
  domain?: string;
  reason?: string;
}

export interface OpsKnowledgeDeprecateArgs extends MutationBaseArgs {
  entryId: string;
  reason?: string;
}

export interface ReviewProcessArgs extends RunArgs {
  decision: "approved" | "changes_requested" | "rejected";
  proposalId?: number;
  sourceSha256?: string;
}

export interface DbRepairApplyArgs extends MutationBaseArgs {
  findingId: number;
}

export interface DbArchiveApplyArgs extends MutationBaseArgs {
  before: string;
  out?: string;
  archiveId?: string;
}

export interface DbMigrateBlobsApplyArgs extends MutationBaseArgs {
  to: "external" | "db";
  storeId?: string;
  limit?: number;
}

export interface DbGcBlobsApplyArgs extends MutationBaseArgs {
  storeId?: string;
  deleteObjects?: boolean;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
