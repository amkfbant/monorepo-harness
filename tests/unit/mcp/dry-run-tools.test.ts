import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../../src/mcp/security/config.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { recordProjectProfileRevision } from "../../../src/db/repositories/project-profile-revisions.js";
import { storeArtifactBlob } from "../../../src/db/artifact-blobs.js";

function freshHarness(): { root: string; db: Database.Database; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-dry-"));
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  const repo = mkdtempSync(join(tmpdir(), "harness-mcp-dry-repo-"));
  mkdirSync(join(repo, "apps/web"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
  );
  writeFileSync(join(repo, "package-lock.json"), "{}");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  writeFileSync(join(repo, "docs", "guide.md"), "guide\n");
  writeFileSync(
    join(repo, "apps/web/package.json"),
    JSON.stringify({ name: "@demo/web", scripts: { test: "vitest" } }),
  );

  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  seed(db, repo);
  return { root, db, repo };
}

function server(root: string, config: McpConfig = DEFAULT_MCP_CONFIG): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_dry",
  });
}

async function callTool(
  s: HarnessMcpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const response = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as any;
  return response.result.structuredContent;
}

function seed(db: Database.Database, repo: string): void {
  const profileYaml = [
    "version: 1",
    "project_id: demo",
    "repo:",
    "  id: demo-repo",
    `  path: ${repo}`,
    "  base_branch: main",
    "policy:",
    "  template: strict-monorepo-v1",
    "domains:",
    "  - id: apps/web",
    "    root: apps/web",
    "    kind: app",
    "    command_presets: [node-basic-v1]",
    "    context_packs: [monorepo-docs-v1]",
    "",
  ].join("\n");
  recordProjectProfileRevision(db, {
    projectId: "demo",
    bodyYaml: profileYaml,
    parsed: parseYaml(profileYaml),
    actor: "test",
    now: new Date("2026-05-25T00:00:00Z"),
  });
  db.prepare(
    `UPDATE projects
        SET repo_id = 'demo-repo',
            profile_path = 'projects/demo.yaml',
            profile_version = 1,
            description = 'Demo project',
            repo_path = ?,
            base_branch = 'main',
            package_manager = 'npm',
            created_at = '2026-05-25T00:00:00Z',
            updated_at = '2026-05-25T00:00:00Z'
      WHERE project_id = 'demo'`,
  ).run(repo);
  db.prepare(
    `INSERT INTO projects
       (project_id, repo_id, profile_path, profile_version, repo_path,
        base_branch, package_manager, created_at, updated_at)
     VALUES ('other', 'other-repo', 'projects/other.yaml', 1, '/tmp/other',
             'main', 'npm', '2026-05-25T00:00:00Z',
             '2026-05-25T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO domains
       (domain_key, project_id, repo_id, domain_id, root, kind, title)
     VALUES
       ('demo-repo::apps/web::demo', 'demo', 'demo-repo', 'apps/web',
        'apps/web', 'app', 'Web'),
       ('other-repo::apps/web::other', 'other', 'other-repo', 'apps/web',
        'apps/web', 'app', 'Web')`,
  ).run();
  db.prepare(
    `INSERT INTO runs
       (run_id, repo_id, project_id, repo_path, domain, workflow, base_branch,
        run_branch, status, safety_status, started_at, finished_at,
        source_meta_sha256, updated_at, meta_json)
     VALUES
       ('run-demo', 'demo-repo', 'demo', ?, 'apps/web', 'domain-coding',
        'main', 'harness/run-demo', 'approved', 'clean',
        '2026-05-25T01:00:00Z', '2026-05-25T01:10:00Z', 'sha-demo',
        '2026-05-25T01:10:00Z', '{}'),
       ('run-other', 'other-repo', 'other', '/tmp/other', 'apps/web',
        'domain-coding', 'main', 'harness/run-other', 'approved', 'clean',
        '2026-05-25T02:00:00Z', '2026-05-25T02:10:00Z', 'sha-other',
        '2026-05-25T02:10:00Z', '{}')`,
  ).run(repo);
  db.prepare(
    `INSERT INTO effective_policy_snapshots
       (snapshot_id, project_id, repo_id, domain, generated_policy_yaml,
        generated_policy_sha256, provenance_json, created_at)
     VALUES
       (501, 'demo', 'demo-repo', 'apps/web', 'read:\\n  - apps/web/**\\n',
        'policy-sha', '{"source":"test"}', '2026-05-25T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO domain_locks
       (domain_key, repo_id, domain, holder_run_id, holder_pid,
        holder_hostname, acquired_at, expires_at, heartbeat_at)
     VALUES
       ('demo-repo::apps/web::demo', 'demo-repo', 'apps/web', 'run-demo',
        123, 'host', '2026-05-25T01:00:00Z', '2020-01-01T00:00:00Z',
        '2026-05-25T01:00:00Z'),
       ('other-repo::apps/web::other', 'other-repo', 'apps/web', 'run-other',
        456, 'host', '2026-05-25T02:00:00Z', '2020-01-01T00:00:00Z',
        '2026-05-25T02:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO run_materializations
       (run_id, purpose, path, reason, created_at, expires_at, status,
        metadata_json)
     VALUES
       ('run-demo', 'scratch', '/tmp/run-demo', 'test',
        '2026-05-25T01:00:00Z', '2020-01-01T00:00:00Z', 'active', '{}'),
       ('run-other', 'scratch', '/tmp/run-other', 'test',
        '2026-05-25T02:00:00Z', '2020-01-01T00:00:00Z', 'active', '{}')`,
  ).run();
  const blob = storeArtifactBlob(db, Buffer.from("artifact body"));
  const otherBlob = storeArtifactBlob(db, Buffer.from("other artifact body"));
  db.prepare(
    `INSERT INTO artifacts
       (artifact_id, run_id, kind, relative_path, content_type, bytes,
        sha256, storage, blob_sha256, body_status, created_at, redacted,
        secret_suspect)
     VALUES
       ('run-demo:summary.md', 'run-demo', 'summary', 'summary.md',
        'text/markdown', ?, ?, 'db', ?, 'db_available',
        '2026-05-25T01:05:00Z', 0, 0),
       ('run-other:summary.md', 'run-other', 'summary', 'summary.md',
        'text/markdown', ?, ?, 'db', ?, 'db_available',
        '2026-05-25T02:05:00Z', 0, 0)`,
  ).run(
    blob.bytes,
    blob.sha256,
    blob.sha256,
    otherBlob.bytes,
    otherBlob.sha256,
    otherBlob.sha256,
  );
  db.prepare(
    `INSERT INTO blob_stores
       (store_id, store_type, config_json, created_at, updated_at, status,
        metadata_json)
     VALUES
       ('local-default', 'local', '{"root":"/tmp/blobs"}',
        '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z', 'active', '{}')`,
  ).run();
}

function auditCounts(db: Database.Database): Record<string, number> {
  const tables = [
    "doctor_runs",
    "doctor_findings",
    "repair_actions",
    "blob_migration_jobs",
    "operations",
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
}

describe("MCP dry-run tools", () => {
  it("previews project and run execution without recording audit rows", async () => {
    const { root, db } = freshHarness();
    try {
      const before = auditCounts(db);
      const s = server(root);

      const inspected = await callTool(s, "harness.project.inspect", {
        projectId: "demo",
      });
      expect(inspected.status).toBe("ok");
      expect(inspected.data.inspection.candidates.map((c: any) => c.id)).toContain(
        "apps/web",
      );

      const checked = await callTool(s, "harness.project.check", {
        projectId: "demo",
      });
      expect(checked.status).toBe("dry_run");
      expect(checked.data.report.projectId).toBe("demo");

      const dryRun = await callTool(s, "harness.run.dry_run", {
        projectId: "demo",
        domain: "apps/web",
        goal: "change the page",
      });
      expect(dryRun.status).toBe("dry_run");
      expect(dryRun.data.effectivePolicySnapshot.snapshotId).toBe(501);
      expect(dryRun.data.candidateCommands.map((c: any) => c.id)).toContain(
        "node-version",
      );
      expect(dryRun.data.contextPacks.includedFileCount).toBeGreaterThan(0);

      expect(auditCounts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("previews cleanup, PR, repair, archive, and blob migration without mutation", async () => {
    const { root, db } = freshHarness();
    try {
      const before = auditCounts(db);
      const s = server(root);

      const cleanup = await callTool(s, "harness.cleanup.dry_run", {
        runId: "run-demo",
      });
      expect(cleanup.status).toBe("dry_run");
      expect(cleanup.data.plannedActions.map((a: any) => a.action)).toEqual([
        "mark_materialization_cleaned",
        "release_domain_lock",
      ]);

      const pr = await callTool(s, "harness.pr.preview", { runId: "run-demo" });
      expect(pr.status).toBe("dry_run");
      expect(pr.data.plannedPullRequest.branch).toBe("harness/run-demo");

      const repair = await callTool(s, "harness.db.repair.dry_run", {
        limit: 5,
      });
      expect(repair.status).toBe("dry_run");
      expect(repair.data.plannedRepairs.length).toBeGreaterThan(0);

      const archive = await callTool(s, "harness.db.archive.preview", {
        limit: 5,
      });
      expect(archive.status).toBe("dry_run");
      expect(archive.data.candidates.map((r: any) => r.runId)).toContain(
        "run-demo",
      );

      const blobs = await callTool(s, "harness.db.migrate_blobs.preview", {
        limit: 5,
      });
      expect(blobs.status).toBe("dry_run");
      expect(blobs.data.defaultStore.storeId).toBe("local-default");
      expect(blobs.data.candidates).toHaveLength(2);

      expect(auditCounts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("enforces project allowlist for run-scoped dry-run previews", async () => {
    const { root, db } = freshHarness();
    try {
      const cfg: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo"],
      };
      const deniedCleanup = await callTool(server(root, cfg), "harness.cleanup.dry_run", {
        runId: "run-other",
      });
      expect(deniedCleanup.status).toBe("permission_denied");

      const deniedPr = await callTool(server(root, cfg), "harness.pr.preview", {
        runId: "run-other",
      });
      expect(deniedPr.status).toBe("permission_denied");

      const archive = await callTool(server(root, cfg), "harness.db.archive.preview", {
        limit: 10,
      });
      expect(archive.status).toBe("dry_run");
      expect(archive.data.candidates.map((r: any) => r.runId)).toEqual([
        "run-demo",
      ]);
      expect(JSON.stringify(archive)).not.toContain("run-other");

      const blobs = await callTool(server(root, cfg), "harness.db.migrate_blobs.preview", {
        limit: 10,
      });
      expect(blobs.status).toBe("dry_run");
      expect(blobs.data.candidates).toHaveLength(1);
      expect(JSON.stringify(blobs)).not.toContain("other artifact");

      const repair = await callTool(server(root, cfg), "harness.db.repair.dry_run", {
        limit: 10,
      });
      expect(repair.status).toBe("dry_run");
      expect(JSON.stringify(repair)).toContain("run-demo");
      expect(JSON.stringify(repair)).not.toContain("run-other");
    } finally {
      db.close();
    }
  });
});
