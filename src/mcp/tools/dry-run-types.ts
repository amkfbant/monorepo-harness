// dry-run-tools の引数/行 shape 型（leaf）。

export interface ProjectArgs {
  projectId: string;
}

export interface RunDryRunArgs {
  projectId: string;
  domain: string;
  goal: string;
  contextPack?: string;
}

export interface RunArgs {
  runId: string;
}

export interface DbPreviewArgs {
  limit?: number;
  to?: "external" | "db";
  storeId?: string;
  deleteObjects?: boolean;
}

export interface RunRow {
  run_id: string;
  repo_id: string;
  project_id: string | null;
  repo_path: string | null;
  domain: string;
  workflow: string;
  base_branch: string;
  base_sha: string | null;
  run_branch: string | null;
  status: string;
  safety_status: string | null;
  pr_url: string | null;
  pr_number: number | null;
  started_at: string | null;
  finished_at: string | null;
  state_version?: number;
}
