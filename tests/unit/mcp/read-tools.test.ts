import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG, type McpConfig } from "../../../src/mcp/security/config.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  appendOperationEvent,
  startOperation,
  succeedOperation,
} from "../../../src/db/repositories/operations.js";
import { storeArtifactBlob } from "../../../src/db/artifact-blobs.js";

function freshHarness(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-read-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  seed(db);
  return { root, db };
}

function server(root: string, config: McpConfig = DEFAULT_MCP_CONFIG): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_read",
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

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO projects
       (project_id, repo_id, profile_path, profile_version, description,
        repo_path, base_branch, package_manager, created_at, updated_at)
     VALUES
       ('demo', 'demo-repo', 'projects/demo.yaml', 1, 'Demo project',
        '/tmp/demo', 'main', 'pnpm', '2026-05-25T00:00:00Z',
        '2026-05-25T00:00:00Z'),
       ('other', 'other-repo', 'projects/other.yaml', 1, 'Other project',
        '/tmp/other', 'main', 'npm', '2026-05-25T00:00:00Z',
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
       (run_id, repo_id, project_id, domain, workflow, base_branch, status,
        safety_status, started_at, source_meta_sha256, updated_at, meta_json)
     VALUES
       ('run-demo-2', 'demo-repo', 'demo', 'apps/web', 'domain-coding',
        'main', 'needs_review', 'clean', '2026-05-25T02:00:00Z', 's2',
        '2026-05-25T02:00:00Z', '{}'),
       ('run-demo-1', 'demo-repo', 'demo', 'apps/web', 'domain-coding',
        'main', 'approved', 'clean', '2026-05-25T01:00:00Z', 's1',
        '2026-05-25T01:00:00Z', '{}'),
       ('run-other-1', 'other-repo', 'other', 'apps/web', 'domain-coding',
        'main', 'needs_review', 'clean', '2026-05-25T03:00:00Z', 's3',
        '2026-05-25T03:00:00Z', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
     VALUES ('run-demo-2', 1, 'run_started', '2026-05-25T02:00:00Z',
             '{"type":"run_started"}')`,
  ).run();
  db.prepare(
    `INSERT INTO artifacts
       (artifact_id, run_id, kind, relative_path, content_type, bytes,
        sha256, storage, blob_sha256, body_status, created_at, redacted,
        secret_suspect)
     VALUES
       ('run-demo-2:summary.md', 'run-demo-2', 'summary', 'summary.md',
        'text/markdown', 12, 'sha-summary', 'file', NULL, 'legacy_file',
        '2026-05-25T02:01:00Z', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO backlog_items
       (item_id, project_id, repo_id, domain, title, goal, status, priority,
        tags_json, created_at, updated_at)
     VALUES
       ('item-20260525-001', 'demo', 'demo-repo', 'apps/web', 'Fix UI',
        'Make UI work', 'open', 'medium', '["ui"]',
        '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO knowledge_entries
       (entry_id, project_id, repo_id, domain, kind, path, title, body,
        frontmatter_json, created_at, source_candidate_id)
     VALUES
       ('knowledge/demo.md', 'demo', 'demo-repo', 'apps/web', 'note',
        'docs/knowledge/demo.md', 'Search filters', 'Body mentions filters',
        '{}', '2026-05-25T00:00:00Z', NULL)`,
  ).run();
  startOperation(db, {
    operationId: "op-demo",
    operationType: "run.dry_run",
    targetType: "run",
    targetId: "run-demo-2",
    actor: "test",
    dryRun: true,
    input: { x: 1 },
  });
  succeedOperation(db, "op-demo", { ok: true });
  db.prepare(
    `UPDATE operations
        SET created_at = '2026-05-25T03:00:00Z'
      WHERE operation_id = 'op-demo'`,
  ).run();
  startOperation(db, {
    operationId: "op-other",
    operationType: "run.dry_run",
    targetType: "run",
    targetId: "run-other-1",
    actor: "test",
    dryRun: true,
    input: { x: 2 },
  });
  succeedOperation(db, "op-other", { ok: true });
  db.prepare(
    `UPDATE operations
        SET created_at = '2026-05-25T04:00:00Z'
      WHERE operation_id = 'op-other'`,
  ).run();
  db.prepare(
    `INSERT INTO effective_policy_snapshots
       (snapshot_id, project_id, repo_id, domain, generated_policy_yaml,
        generated_policy_sha256, provenance_json, created_at)
     VALUES
       (101, 'demo', 'demo-repo', 'apps/web', 'read:\\n  - apps/web/**\\n',
        'policy-sha', '{"source":"test"}', '2026-05-25T00:00:00Z')`,
  ).run();
}

function attachArchive(root: string, db: Database.Database): void {
  const archivePath = join(root, ".harness", "archive.sqlite");
  mkdirSync(join(root, ".harness"), { recursive: true });
  const archiveDb = openDb(archivePath);
  try {
    runMigrations(archiveDb);
    archiveDb
      .prepare(
        `INSERT INTO runs
           (run_id, repo_id, project_id, domain, workflow, base_branch, status,
            started_at, source_meta_sha256, updated_at, meta_json)
         VALUES
           ('run-archived', 'demo-repo', 'demo', 'apps/web', 'domain-coding',
            'main', 'approved', '2026-05-20T00:00:00Z', 'arch',
            '2026-05-20T00:00:00Z', '{}')`,
      )
      .run();
    archiveDb
      .prepare(
        `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
         VALUES ('run-archived', 1, 'run_started', '2026-05-20T00:00:00Z',
                 '{"type":"run_started","archived":true}')`,
      )
      .run();
    const body = Buffer.from("archived body");
    const blob = storeArtifactBlob(archiveDb, body);
    archiveDb
      .prepare(
        `INSERT INTO artifacts
           (artifact_id, run_id, kind, relative_path, content_type, bytes,
            sha256, storage, blob_sha256, body_status, created_at, redacted,
            secret_suspect)
         VALUES
           ('run-archived:summary.md', 'run-archived', 'summary', 'summary.md',
            'text/markdown', ?, ?, 'db', ?, 'db_available',
            '2026-05-20T00:01:00Z', 0, 0)`,
      )
      .run(blob.bytes, blob.sha256, blob.sha256);
  } finally {
    archiveDb.close();
  }
  db.prepare(
    `INSERT INTO archive_catalog
       (archive_id, path, created_at, schema_version, status, metadata_json)
     VALUES
       ('archive-test', ?, '2026-05-25T00:00:00Z', 12, 'attached', '{}')`,
  ).run(archivePath);
}

describe("MCP read tools", () => {
  it("reads project and run data from the canonical DB with pagination", async () => {
    const { root, db } = freshHarness();
    try {
      const s = server(root);
      const projects = await callTool(s, "harness.project.list");
      expect(projects.status).toBe("ok");
      expect(projects.data.projects.map((p: any) => p.projectId)).toEqual([
        "demo",
        "other",
      ]);

      const runs = await callTool(s, "harness.run.list", {
        projectId: "demo",
        limit: 1,
      });
      expect(runs.status).toBe("ok");
      expect(runs.data.runs).toHaveLength(1);
      expect(runs.data.runs[0].runId).toBe("run-demo-2");
      expect(runs.data.page.nextCursor).toEqual(expect.any(String));
    } finally {
      db.close();
    }
  });

  it("returns run detail links and artifact metadata without embedding file bodies", async () => {
    const { root, db } = freshHarness();
    try {
      const detail = await callTool(server(root), "harness.run.get", {
        runId: "run-demo-2",
        includeTimeline: true,
        includeArtifacts: true,
      });
      expect(detail.status).toBe("ok");
      expect(detail.data.timeline).toHaveLength(1);
      expect(detail.data.artifacts[0]).toMatchObject({
        artifactId: "run-demo-2:summary.md",
        bodyPreview: {
          omitted: true,
        },
      });
      expect(detail.resourceLinks.map((l: any) => l.uri)).toContain(
        "harness://run/run-demo-2/timeline",
      );
    } finally {
      db.close();
    }
  });

  it("omits knowledge bodies by default and caps included bodies", async () => {
    const { root, db } = freshHarness();
    try {
      db.prepare("UPDATE knowledge_entries SET body = ? WHERE entry_id = ?").run(
        "abcdef",
        "knowledge/demo.md",
      );
      const s = server(root);
      const omitted = await callTool(s, "harness.knowledge.get", {
        entryId: "knowledge/demo.md",
      });
      expect(omitted.status).toBe("ok");
      expect(omitted.data.entry.body).toBeUndefined();
      expect(omitted.data.entry.bodyPreview).toMatchObject({ omitted: true });

      const capped = await callTool(s, "harness.knowledge.get", {
        entryId: "knowledge/demo.md",
        includeBody: true,
        maxBytes: 3,
      });
      expect(capped.data.entry.body).toBeUndefined();
      expect(capped.data.entry.bodyPreview).toMatchObject({
        capped: true,
        text: "abc",
        bytes: 6,
        maxBytes: 3,
      });
    } finally {
      db.close();
    }
  });

  it("enforces project allowlist for run-id and list tools", async () => {
    const { root, db } = freshHarness();
    try {
      const cfg: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo"],
      };
      const s = server(root, cfg);
      const projects = await callTool(s, "harness.project.list");
      expect(projects.data.projects.map((p: any) => p.projectId)).toEqual([
        "demo",
      ]);
      const runs = await callTool(s, "harness.run.list", {
        limit: 1,
      });
      expect(runs.data.runs.map((r: any) => r.runId)).toEqual(["run-demo-2"]);
      const denied = await callTool(s, "harness.run.get", {
        runId: "run-other-1",
      });
      expect(denied.status).toBe("permission_denied");
    } finally {
      db.close();
    }
  });

  it("reads backlog, knowledge, and operation rows", async () => {
    const { root, db } = freshHarness();
    try {
      const s = server(root);
      const backlog = await callTool(s, "harness.backlog.get", {
        itemId: "item-20260525-001",
      });
      expect(backlog.data.item.title).toBe("Fix UI");

      const knowledge = await callTool(s, "harness.knowledge.search", {
        query: "filters",
      });
      expect(knowledge.data.entries[0].entryId).toBe("knowledge/demo.md");

      const operation = await callTool(s, "harness.operation.get", {
        operationId: "op-demo",
      });
      expect(operation.data.operation.status).toBe("succeeded");
      expect(operation.data.events.map((e: any) => e.eventType)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("redacts operation input, result, metadata, events, and idempotency keys", async () => {
    const { root, db } = freshHarness();
    try {
      startOperation(db, {
        operationId: "op-secret",
        operationType: "backlog.create",
        targetType: "backlog_domain",
        targetId: "demo",
        actor: "mcp:unit-test",
        idempotencyKey: "idem-secret",
        dryRun: false,
        input: {
          projectId: "demo",
          accessToken: "plain-token-value",
          note: "sk-proj-ABCDEFGHIJKLMNOPQRST",
        },
        metadata: {
          actorNote: "sk-proj-QRSTUVWXYZABCDEFGHIJ",
          idempotencyKey: "metadata-key",
        },
      });
      succeedOperation(db, "op-secret", {
        apiKey: "result-key",
        nested: { note: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890" },
      });
      appendOperationEvent(db, "op-secret", "diagnostic", "sk-proj-1234567890ABCDEFGHIJ", {
        secret: "event-secret",
        note: "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      });

      const operation = await callTool(server(root), "harness.operation.get", {
        operationId: "op-secret",
      });
      expect(operation.data.operation).toMatchObject({
        idempotencyKey: "[redacted]",
        input: {
          projectId: "demo",
          accessToken: "[redacted]",
          note: "[redacted]",
        },
        result: {
          apiKey: "[redacted]",
          nested: { note: "[redacted]" },
        },
        metadata: {
          actorNote: "[redacted]",
          idempotencyKey: "[redacted]",
        },
      });
      expect(operation.data.events.at(-1)).toMatchObject({
        message: "[redacted]",
        data: {
          secret: "[redacted]",
          note: "[redacted]",
        },
      });

      const list = await callTool(server(root), "harness.operation.list", {
        targetId: "demo",
      });
      expect(list.data.operations[0]).toMatchObject({
        operationId: "op-secret",
        idempotencyKey: "[redacted]",
        metadata: {
          actorNote: "[redacted]",
          idempotencyKey: "[redacted]",
        },
      });
    } finally {
      db.close();
    }
  });

  it("reads effective policy from DB snapshots only", async () => {
    const { root, db } = freshHarness();
    try {
      const policy = await callTool(server(root), "harness.policy.get_effective", {
        projectId: "demo",
        domain: "apps/web",
      });
      expect(policy.status).toBe("ok");
      expect(policy.data.snapshot.snapshotId).toBe(101);
      expect(policy.data.snapshot.generatedPolicyYaml).toContain("apps/web");

      const missing = await callTool(server(root), "harness.policy.get_effective", {
        projectId: "demo",
        domain: "apps/api",
      });
      expect(missing.status).toBe("error");
    } finally {
      db.close();
    }
  });

  it("paginates operation.list after applying project allowlist", async () => {
    const { root, db } = freshHarness();
    try {
      startOperation(db, {
        operationId: "op-project-domain",
        operationType: "run.start",
        targetType: "project_domain",
        targetId: "demo:apps/web",
        actor: "mcp:unit-test",
        idempotencyKey: "op-project-domain-key",
        dryRun: false,
        input: { projectId: "demo", domain: "apps/web" },
      });
      succeedOperation(db, "op-project-domain", { ok: true });
      db.prepare(
        `UPDATE operations
            SET created_at = '2026-05-25T05:00:00Z'
          WHERE operation_id = 'op-project-domain'`,
      ).run();
      startOperation(db, {
        operationId: "op-backlog-domain",
        operationType: "backlog.create",
        targetType: "backlog_domain",
        targetId: "demo",
        actor: "mcp:unit-test",
        idempotencyKey: "op-backlog-domain-key",
        dryRun: false,
        input: { projectId: "demo", domain: "apps/web" },
      });
      succeedOperation(db, "op-backlog-domain", { ok: true });
      db.prepare(
        `UPDATE operations
            SET created_at = '2026-05-25T06:00:00Z'
          WHERE operation_id = 'op-backlog-domain'`,
      ).run();
      const cfg: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo", "missing-allowed"],
      };
      const operations = await callTool(server(root, cfg), "harness.operation.list", {
        limit: 10,
      });
      expect(operations.status).toBe("ok");
      expect(operations.data.operations.map((op: any) => op.operationId)).toEqual([
        "op-backlog-domain",
        "op-project-domain",
        "op-demo",
      ]);
      expect(operations.data.page.total).toBe(3);
      expect(operations.data.page.nextCursor).toBeNull();

      const projectDomain = await callTool(server(root, cfg), "harness.operation.get", {
        operationId: "op-project-domain",
      });
      expect(projectDomain.status).toBe("ok");
      const backlogDomain = await callTool(server(root, cfg), "harness.operation.get", {
        operationId: "op-backlog-domain",
      });
      expect(backlogDomain.status).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("uses live archive DB handles for archived run artifacts and previews", async () => {
    const { root, db } = freshHarness();
    try {
      attachArchive(root, db);
      const cfg: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        resources: {
          ...DEFAULT_MCP_CONFIG.resources,
          artifactBody: "small-text",
        },
      };
      const detail = await callTool(server(root, cfg), "harness.run.get", {
        runId: "run-archived",
        includeTimeline: true,
        includeArtifacts: true,
      });
      expect(detail.status).toBe("ok");
      expect(detail.data.archived).toBe(true);
      expect(detail.data.timeline[0].payload.archived).toBe(true);
      expect(detail.data.artifacts[0].bodyPreview).toMatchObject({
        mode: "small-text",
        text: "archived body",
      });
    } finally {
      db.close();
    }
  });
});
