// read-tools の引数/行 shape 型（leaf）。tool module と helpers が共有する語彙。
// 値を持たない純粋な型 leaf ゆえ循環の起点にならない。
import type { RunDetail } from "../../db/repositories/runs.js";

export interface ListArgs {
  limit?: number;
  cursor?: string | null;
}

export interface RunListArgs extends ListArgs {
  projectId?: string;
  domain?: string;
  statuses?: string[];
}

export interface RunGetArgs {
  runId: string;
  includeArtifacts?: boolean;
  includeTimeline?: boolean;
}

export interface ArtifactGetArgs {
  runId?: string;
  artifactId: string;
}

export interface ProjectGetArgs {
  projectId: string;
}

export interface DomainListArgs {
  projectId?: string;
}

export interface PolicyEffectiveArgs {
  projectId: string;
  domain: string;
}

export interface PolicySnapshotArgs {
  snapshotId: number;
}

export interface BacklogListArgs extends ListArgs {
  projectId?: string;
  repoId?: string;
  status?: "open" | "doing" | "done" | "deferred";
}

export interface BacklogGetArgs {
  itemId: string;
}

export interface KnowledgeSearchArgs {
  query: string;
  projectId?: string;
  domain?: string;
  limit?: number;
}

export interface KnowledgeGetArgs {
  entryId: string;
  includeBody?: boolean;
  maxBytes?: number;
}

export interface OperationListArgs {
  targetType?: string;
  targetId?: string;
  status?: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  limit?: number;
  cursor?: string | null;
}

export interface OperationGetArgs {
  operationId: string;
}

export interface ArtifactRow {
  artifact_id: string;
  run_id: string | null;
  kind: string;
  relative_path: string | null;
  content_type: string | null;
  bytes: number;
  sha256: string;
  storage: string;
  blob_sha256: string | null;
  body_status: string | null;
  created_at: string | null;
  redacted: number;
  secret_suspect: number;
  original_bytes: number | null;
  original_sha256: string | null;
}

export interface RunSource {
  run: RunDetail;
  archived: boolean;
  archivePath?: string;
}

export interface ArtifactSource {
  artifact: ArtifactRow;
  archived: boolean;
  archivePath?: string;
}
