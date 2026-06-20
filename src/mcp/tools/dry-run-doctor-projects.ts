// doctor finding から関連 project id を解決する層（mutation-tools / db-tools が利用）。

import type Database from "better-sqlite3";

import { type DoctorFinding } from "../../db/doctor.js";

import { tableExists } from "./tool-helpers.js";

export function filterFindingsByAllowedProjects(
  db: Database.Database,
  findings: DoctorFinding[],
  allowedProjects: string[],
): DoctorFinding[] {
  if (allowedProjects.length === 0) return findings;
  return findings.filter((finding) => {
    const projects = projectIdsForDoctorFinding(db, finding);
    return projects.some((projectId) => allowedProjects.includes(projectId));
  });
}

export function projectIdsForDoctorFinding(
  db: Database.Database,
  finding: DoctorFinding,
): string[] {
  const details = finding.details ?? {};
  const out = new Set<string>();
  addProjectFromValue(db, out, details.project_id);
  addProjectFromValue(db, out, details.projectId);
  addRunProjectFromValue(db, out, details.run_id);
  addRunProjectFromValue(db, out, details.runId);
  addRunProjectFromValue(db, out, details.holder_run_id);
  addArtifactProjectFromValue(db, out, details.artifact_id);
  addArtifactProjectFromValue(db, out, details.artifactId);
  addOperationProjectFromValue(db, out, details.operation_id);
  addOperationProjectFromValue(db, out, details.operationId);
  addTargetProjectFromValues(db, out, details.target_type, details.target_id);
  addTargetProjectFromValues(db, out, details.targetType, details.targetId);
  addAssetProjectFromValues(db, out, details.asset_type, details.asset_id);
  addAssetProjectFromValues(db, out, details.assetType, details.assetId);
  return [...out];
}

export function addProjectFromValue(
  _db: Database.Database,
  out: Set<string>,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) out.add(value);
}

export function addRunProjectFromValue(
  db: Database.Database,
  out: Set<string>,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length === 0) return;
  const row = db
    .prepare("SELECT project_id FROM runs WHERE run_id = ?")
    .get(value) as { project_id: string | null } | undefined;
  if (row?.project_id !== null && row?.project_id !== undefined) {
    out.add(row.project_id);
  }
}

export function addArtifactProjectFromValue(
  db: Database.Database,
  out: Set<string>,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length === 0) return;
  const rows = db
    .prepare(
      `SELECT DISTINCT r.project_id
         FROM artifacts a
         INNER JOIN runs r ON r.run_id = a.run_id
        WHERE a.artifact_id = ?
          AND r.project_id IS NOT NULL`,
    )
    .all(value) as { project_id: string }[];
  for (const row of rows) out.add(row.project_id);
}

export function addOperationProjectFromValue(
  db: Database.Database,
  out: Set<string>,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length === 0) return;
  const row = db
    .prepare(
      `SELECT target_type, target_id
         FROM operations
        WHERE operation_id = ?`,
    )
    .get(value) as
    | { target_type: string | null; target_id: string | null }
    | undefined;
  if (row !== undefined) {
    addTargetProjectFromValues(db, out, row.target_type, row.target_id);
  }
}

export function addTargetProjectFromValues(
  db: Database.Database,
  out: Set<string>,
  targetType: unknown,
  targetId: unknown,
): void {
  if (typeof targetType !== "string" || typeof targetId !== "string") return;
  if (targetType === "run") {
    addRunProjectFromValue(db, out, targetId);
    return;
  }
  const table =
    targetType === "backlog_item"
      ? "backlog_items"
      : targetType === "knowledge_entry"
        ? "knowledge_entries"
        : targetType === "knowledge_candidate"
          ? "knowledge_candidates"
          : null;
  const idColumn =
    targetType === "backlog_item"
      ? "item_id"
      : targetType === "knowledge_entry"
        ? "entry_id"
        : targetType === "knowledge_candidate"
          ? "candidate_id"
          : null;
  if (table === null || idColumn === null || !tableExists(db, table)) return;
  const row = db
    .prepare(`SELECT project_id FROM ${table} WHERE ${idColumn} = ?`)
    .get(targetId) as { project_id: string | null } | undefined;
  if (row?.project_id !== null && row?.project_id !== undefined) {
    out.add(row.project_id);
  }
}

export function addAssetProjectFromValues(
  _db: Database.Database,
  out: Set<string>,
  assetType: unknown,
  assetId: unknown,
): void {
  if (assetType === "project_profile" && typeof assetId === "string") {
    out.add(assetId);
  }
}
