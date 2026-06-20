// dry-run-tools 公開 MCP tool factory（#125 A15 barrel 分割）。


import { DEFAULT_CHECKS, type DoctorFinding } from "../../db/doctor.js";
import { findRepairFor } from "../../db/repair.js";

import type { HarnessMcpToolResult } from "../schemas/outputs.js";

import type { McpToolContext } from "../registry/tool-registry.js";
import { normalizeLimit, parseJson, tableExists, withReadonlyDb } from "./tool-helpers.js";
import type { DbPreviewArgs } from "./dry-run-types.js";
import { archiveCandidateRuns, blobGcCandidates, blobMigrationCandidates, externalToDbMigrationCandidates } from "./dry-run-helpers.js";
import { filterFindingsByAllowedProjects } from "./dry-run-doctor-projects.js";

export function dbRepairDryRunTool(
  args: DbPreviewArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const findings = filterFindingsByAllowedProjects(
      db,
      DEFAULT_CHECKS.flatMap((check) => check.run(db)),
      context.config.allowedProjects,
    );
    const flagged = findings.filter((f) => f.status === "flagged");
    const repairable = flagged
      .map((finding) => ({ finding, action: findRepairFor(finding) }))
      .filter(
        (entry): entry is { finding: DoctorFinding; action: NonNullable<ReturnType<typeof findRepairFor>> } =>
          entry.action !== null,
      )
      .slice(0, limit);
    const planned = repairable.map(({ finding, action }) => ({
      finding,
      repair: action.apply(db, finding, { dryRun: true }),
    }));
    return {
      status: "dry_run",
      summary: `would repair ${planned.length} DB finding(s)`,
      data: {
        dryRun: true,
        counts: {
          checks: DEFAULT_CHECKS.length,
          flagged: flagged.length,
          repairable: repairable.length,
        },
        plannedRepairs: planned,
      },
      warnings: flagged
        .filter((f) => !f.repairable)
        .slice(0, 10)
        .map((f) => `${f.checkId}: ${f.message}`),
    };
  }) as HarnessMcpToolResult;
}

export function dbArchivePreviewTool(
  args: DbPreviewArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const archiveCatalog = tableExists(db, "archive_catalog")
      ? (db
          .prepare(
            `SELECT archive_id, path, created_at, range_start, range_end,
                    schema_version, sha256, status, metadata_json
               FROM archive_catalog
              ORDER BY created_at DESC, archive_id DESC
              LIMIT ?`,
          )
          .all(limit) as Record<string, unknown>[])
      : [];
    const candidates = archiveCandidateRuns(
      db,
      limit,
      context.config.allowedProjects,
    );
    return {
      status: "dry_run",
      summary: `would consider ${candidates.length} run(s) for archive`,
      data: {
        dryRun: true,
        candidates,
        attachedArchives:
          context.config.allowedProjects.length === 0
            ? archiveCatalog.map((r) => ({
                archiveId: r.archive_id,
                path: r.path,
                createdAt: r.created_at,
                rangeStart: (r.range_start as string | null) ?? null,
                rangeEnd: (r.range_end as string | null) ?? null,
                schemaVersion: r.schema_version,
                sha256: (r.sha256 as string | null) ?? null,
                status: r.status,
                metadata: parseJson(r.metadata_json as string | null, {}),
              }))
            : [],
      },
      warnings:
        context.config.allowedProjects.length === 0
          ? []
          : [
              "archive catalog details omitted because allowedProjects is scoped",
              "global DB archive apply is disabled for project-scoped MCP clients",
            ],
      nextActions:
        context.config.allowedProjects.length === 0
          ? [
              {
                label: "Create archive",
                tool: "harness.db.archive.apply",
                arguments: {
                  before: "<ISO timestamp>",
                  idempotencyKey: "<uuid>",
                },
              },
            ]
          : [],
    };
  }) as HarnessMcpToolResult;
}

export function dbMigrateBlobsPreviewTool(
  args: DbPreviewArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const direction = args.to ?? "external";
    const stores = tableExists(db, "blob_stores")
      ? (db
          .prepare(
            `SELECT store_id, store_type, status, config_json, metadata_json
               FROM blob_stores
              ORDER BY store_id`,
          )
          .all() as Record<string, unknown>[])
      : [];
    const defaultStore =
      stores.find((s) => s.store_id === args.storeId) ??
      stores.find((s) => s.status === "active") ??
      stores[0] ??
      null;
    const candidates =
      direction === "external"
        ? blobMigrationCandidates(db, limit, context.config.allowedProjects)
        : externalToDbMigrationCandidates(
            db,
            defaultStore?.store_id as string | undefined,
            limit,
            context.config.allowedProjects,
          );
    const directionLabel = direction === "external" ? "db-to-external" : "external-to-db";
    return {
      status: "dry_run",
      summary: `would migrate ${candidates.length} artifact blob(s) ${directionLabel}`,
      data: {
        dryRun: true,
        direction: directionLabel,
        defaultStore:
          defaultStore === null
            ? null
            : {
                storeId: defaultStore.store_id,
                storeType: defaultStore.store_type,
                status: defaultStore.status,
                config: parseJson(defaultStore.config_json as string | null, {}),
                metadata: parseJson(defaultStore.metadata_json as string | null, {}),
              },
        candidates,
      },
      warnings:
        defaultStore === null
          ? ["no blob store is configured; apply would require a blob store"]
          : [],
      nextActions: [
        {
          label: "Migrate blobs",
          tool: "harness.db.migrate_blobs.apply",
          arguments: {
            to: direction,
            ...(defaultStore?.store_id !== undefined ? { storeId: defaultStore.store_id } : {}),
            idempotencyKey: "<uuid>",
          },
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function dbGcBlobsPreviewTool(
  args: DbPreviewArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const stores = tableExists(db, "blob_stores")
      ? (db
          .prepare(
            `SELECT store_id, store_type, status, config_json, metadata_json
               FROM blob_stores
              ORDER BY store_id`,
          )
          .all() as Record<string, unknown>[])
      : [];
    const store =
      stores.find((s) => s.store_id === args.storeId) ??
      stores.find((s) => s.status === "active") ??
      stores[0] ??
      null;
    const candidates = blobGcCandidates(db, store?.store_id as string | undefined, limit);
    const scoped = context.config.allowedProjects.length > 0;
    return {
      status: "dry_run",
      summary: `would GC ${candidates.length} external artifact blob(s)`,
      data: {
        dryRun: true,
        operation: "external-blob-gc",
        storeId: store?.store_id ?? args.storeId ?? null,
        deleteObjects: args.deleteObjects === true,
        candidates,
      },
      warnings: [
        ...(args.deleteObjects === true
          ? ["confirmed execution will also delete external blob objects best-effort"]
          : []),
        ...(scoped
          ? [
              "external blob GC is a global maintenance operation",
              "apply is disabled for project-scoped MCP clients",
            ]
          : []),
      ],
      nextActions: scoped
        ? []
        : [
            {
              label: "GC blobs",
              tool: "harness.db.gc_blobs.apply",
              arguments: {
                ...(store?.store_id !== undefined ? { storeId: store.store_id } : {}),
                ...(args.deleteObjects === true ? { deleteObjects: true } : {}),
                idempotencyKey: "<uuid>",
              },
            },
          ],
    };
  }) as HarnessMcpToolResult;
}
