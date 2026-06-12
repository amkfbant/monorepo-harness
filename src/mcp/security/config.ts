import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type McpMode = "read-only" | "dry-run" | "guarded-mutation";
export type ArtifactBodyMode = "disabled" | "summary-only" | "small-text" | "full";

export interface McpClientConfig {
  id: string;
  names: string[];
  mode: McpMode;
}

export interface McpLimitsConfig {
  maxRunsPerHour: number;
  maxConcurrentRuns: number;
  maxToolCallsPerMinute: number;
  maxMutationOperationsPerHour: number;
  maxArtifactBytesPerToolResult: number;
}

export interface McpResourcesConfig {
  artifactBody: ArtifactBodyMode;
  maxResourceBytes: number;
  includeSecretSuspect: boolean;
}

export interface McpConfirmationConfig {
  ttlSeconds: number;
}

export interface McpAuditConfig {
  recordReadTools: boolean;
  recordDryRuns: boolean;
  recordMutations: boolean;
}

export interface McpConfig {
  enabled: boolean;
  defaultMode: McpMode;
  clients: McpClientConfig[];
  allowedProjects: string[];
  allowedOperations: string[];
  requireConfirmation: string[];
  deniedOperations: string[];
  limits: McpLimitsConfig;
  resources: McpResourcesConfig;
  confirmation: McpConfirmationConfig;
  audit: McpAuditConfig;
}

export interface LoadMcpConfigOptions {
  harnessRoot: string;
  configPath?: string;
}

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

const modeSchema = z.enum(["read-only", "dry-run", "guarded-mutation"]);
const artifactBodySchema = z.enum([
  "disabled",
  "summary-only",
  "small-text",
  "full",
]);

const rawConfigSchema = z.object({
  version: z.literal(1).optional(),
  mcp: z
    .object({
      enabled: z.boolean().optional(),
      defaultMode: modeSchema.optional(),
      clients: z
        .array(
          z.object({
            id: z.string().min(1),
            names: z.array(z.string().min(1)).default([]),
            mode: modeSchema.optional(),
          }),
        )
        .optional(),
      allowedProjects: z.array(z.string().min(1)).optional(),
      allowedOperations: z.array(z.string().min(1)).optional(),
      requireConfirmation: z.array(z.string().min(1)).optional(),
      deniedOperations: z.array(z.string().min(1)).optional(),
      limits: z
        .object({
          maxRunsPerHour: z.number().int().min(1).optional(),
          maxConcurrentRuns: z.number().int().min(1).optional(),
          maxToolCallsPerMinute: z.number().int().min(1).optional(),
          maxMutationOperationsPerHour: z.number().int().min(1).optional(),
          maxArtifactBytesPerToolResult: z.number().int().min(0).optional(),
        })
        .optional(),
      resources: z
        .object({
          artifactBody: artifactBodySchema.optional(),
          maxResourceBytes: z.number().int().min(0).optional(),
          includeSecretSuspect: z.boolean().optional(),
        })
        .optional(),
      confirmation: z
        .object({
          ttlSeconds: z.number().int().min(1).optional(),
        })
        .optional(),
      audit: z
        .object({
          recordReadTools: z.boolean().optional(),
          recordDryRuns: z.boolean().optional(),
          recordMutations: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
type RawMcpSection = z.infer<typeof rawConfigSchema>["mcp"];

const fullConfigSchema: z.ZodType<McpConfig> = z
  .object({
    enabled: z.boolean(),
    defaultMode: modeSchema,
    clients: z.array(
      z.object({
        id: z.string().min(1),
        names: z.array(z.string().min(1)),
        mode: modeSchema,
      }),
    ),
    allowedProjects: z.array(z.string().min(1)),
    allowedOperations: z.array(z.string().min(1)),
    requireConfirmation: z.array(z.string().min(1)),
    deniedOperations: z.array(z.string().min(1)),
    limits: z.object({
      maxRunsPerHour: z.number().int().min(1),
      maxConcurrentRuns: z.number().int().min(1),
      maxToolCallsPerMinute: z.number().int().min(1),
      maxMutationOperationsPerHour: z.number().int().min(1),
      maxArtifactBytesPerToolResult: z.number().int().min(0),
    }),
    resources: z.object({
      artifactBody: artifactBodySchema,
      maxResourceBytes: z.number().int().min(0),
      includeSecretSuspect: z.boolean(),
    }),
    confirmation: z.object({
      ttlSeconds: z.number().int().min(1),
    }),
    audit: z.object({
      recordReadTools: z.boolean(),
      recordDryRuns: z.boolean(),
      recordMutations: z.boolean(),
    }),
  })
  .strict();

export const DEFAULT_MCP_CONFIG: McpConfig = {
  enabled: true,
  defaultMode: "dry-run",
  clients: [],
  allowedProjects: [],
  allowedOperations: [],
  requireConfirmation: [
    "review.process",
    "cleanup.apply",
    "pr.create",
    "hitch.close",
    "hitch.cancel",
    "hitch.expand_scope",
    "db.repair.apply",
    "db.archive.apply",
    "db.migrate_blobs.apply",
    "db.gc_blobs.apply",
  ],
  deniedOperations: ["db.restore", "db.vacuum", "shell.exec"],
  limits: {
    maxRunsPerHour: 3,
    maxConcurrentRuns: 1,
    maxToolCallsPerMinute: 60,
    maxMutationOperationsPerHour: 10,
    maxArtifactBytesPerToolResult: 131_072,
  },
  resources: {
    artifactBody: "summary-only",
    maxResourceBytes: 262_144,
    includeSecretSuspect: false,
  },
  confirmation: {
    ttlSeconds: 900,
  },
  audit: {
    recordReadTools: false,
    recordDryRuns: true,
    recordMutations: true,
  },
};

export function defaultMcpConfigPath(harnessRoot: string): string {
  return join(harnessRoot, ".harness", "mcp.yaml");
}

/**
 * Fail-closed guard for the goal→hitch rename (SP-0): a config still listing a
 * `goal.*` operation is a stale, pre-rename file that would silently allow/deny
 * the wrong (now nonexistent) operation. Refuse to load it. NOT applied to the
 * snapshot parser, which re-verifies past `goal.*` confirmation snapshots.
 */
export function assertNoRenamedGoalOps(cfg: {
  allowedOperations?: string[] | undefined;
  requireConfirmation?: string[] | undefined;
  deniedOperations?: string[] | undefined;
}): void {
  const stale = [
    ...(cfg.allowedOperations ?? []),
    ...(cfg.requireConfirmation ?? []),
    ...(cfg.deniedOperations ?? []),
  ].filter((op) => op.startsWith("goal."));
  if (stale.length > 0) {
    throw new McpConfigError(
      `MCP config uses renamed operations [${stale.join(", ")}] — "goal.*" was renamed to "hitch.*". Update .harness/mcp.yaml.`,
    );
  }
}

export function loadMcpConfig(opts: LoadMcpConfigOptions): McpConfig {
  if (opts.configPath !== undefined) {
    if (!existsSync(opts.configPath)) {
      throw new McpConfigError(`MCP config not found: ${opts.configPath}`);
    }
    return loadMcpConfigFile(opts.configPath) as McpConfig;
  }
  const path = defaultMcpConfigPath(opts.harnessRoot);
  if (existsSync(path)) {
    return loadMcpConfigFile(path) ?? cloneMcpConfig(DEFAULT_MCP_CONFIG);
  }
  return loadProjectProfileMcpConfig(opts.harnessRoot) ?? cloneMcpConfig(DEFAULT_MCP_CONFIG);
}

function loadMcpConfigFile(path: string): McpConfig | undefined {
  if (!existsSync(path)) return undefined;
  const rawText = readFileSync(path, "utf8");
  const parsedYaml = parseYaml(rawText) as unknown;
  const parsed = rawConfigSchema.parse(parsedYaml);
  if (parsed.mcp !== undefined) assertNoRenamedGoalOps(parsed.mcp);
  return mergeMcpConfig(DEFAULT_MCP_CONFIG, parsed.mcp);
}

function loadProjectProfileMcpConfig(harnessRoot: string): McpConfig | undefined {
  const projectsDir = join(harnessRoot, "projects");
  if (!existsSync(projectsDir)) return undefined;
  let config: McpConfig | undefined;
  const files = readdirSync(projectsDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const path = join(projectsDir, file);
    const rawText = readFileSync(path, "utf8");
    const raw = parseYaml(rawText) as unknown;
    if (raw === null || typeof raw !== "object" || !("mcp" in raw)) continue;
    const rawRecord = raw as { version?: unknown; mcp?: unknown };
    const parsed = rawConfigSchema.parse({
      ...(rawRecord.version !== undefined ? { version: rawRecord.version } : {}),
      mcp: rawRecord.mcp,
    });
    if (parsed.mcp !== undefined) assertNoRenamedGoalOps(parsed.mcp);
    config = mergeMcpConfig(config ?? DEFAULT_MCP_CONFIG, parsed.mcp);
  }
  return config;
}

function mergeMcpConfig(base: McpConfig, mcp: RawMcpSection): McpConfig {
  if (mcp === undefined) return cloneMcpConfig(base);
  const limits = mcp.limits ?? {};
  const resources = mcp.resources ?? {};
  const confirmation = mcp.confirmation ?? {};
  const audit = mcp.audit ?? {};
  const defaultMode = mcp.defaultMode ?? base.defaultMode;

  return {
    enabled: mcp.enabled ?? base.enabled,
    defaultMode,
    clients:
      mcp.clients?.map((c) => ({
        id: c.id,
        names: c.names,
        mode: c.mode ?? defaultMode,
      })) ?? base.clients.map((c) => ({ ...c, names: [...c.names] })),
    allowedProjects: mcp.allowedProjects ?? [...base.allowedProjects],
    allowedOperations: mcp.allowedOperations ?? [...base.allowedOperations],
    requireConfirmation:
      mcp.requireConfirmation ?? [...base.requireConfirmation],
    deniedOperations: mcp.deniedOperations ?? [...base.deniedOperations],
    limits: {
      maxRunsPerHour:
        limits.maxRunsPerHour ?? base.limits.maxRunsPerHour,
      maxConcurrentRuns:
        limits.maxConcurrentRuns ?? base.limits.maxConcurrentRuns,
      maxToolCallsPerMinute:
        limits.maxToolCallsPerMinute ?? base.limits.maxToolCallsPerMinute,
      maxMutationOperationsPerHour:
        limits.maxMutationOperationsPerHour ??
        base.limits.maxMutationOperationsPerHour,
      maxArtifactBytesPerToolResult:
        limits.maxArtifactBytesPerToolResult ??
        base.limits.maxArtifactBytesPerToolResult,
    },
    resources: {
      artifactBody:
        resources.artifactBody ?? base.resources.artifactBody,
      maxResourceBytes:
        resources.maxResourceBytes ?? base.resources.maxResourceBytes,
      includeSecretSuspect:
        resources.includeSecretSuspect ?? base.resources.includeSecretSuspect,
    },
    confirmation: {
      ttlSeconds:
        confirmation.ttlSeconds ?? base.confirmation.ttlSeconds,
    },
    audit: {
      recordReadTools:
        audit.recordReadTools ?? base.audit.recordReadTools,
      recordDryRuns:
        audit.recordDryRuns ?? base.audit.recordDryRuns,
      recordMutations:
        audit.recordMutations ?? base.audit.recordMutations,
    },
  };
}

function cloneMcpConfig(config: McpConfig): McpConfig {
  return mergeMcpConfig(config, {});
}

export function parseMcpConfigSnapshotJson(text: string): McpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    throw new McpConfigError(`invalid MCP permission snapshot JSON: ${(e as Error).message}`);
  }
  const result = fullConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new McpConfigError("invalid MCP permission snapshot");
  }
  return cloneMcpConfig(result.data);
}
