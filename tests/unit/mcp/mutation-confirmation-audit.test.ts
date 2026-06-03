import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import { MCP_TOOL_DEFINITIONS } from "../../../src/mcp/registry/tool-registry.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../../src/mcp/security/config.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { confirmMcpRequest, rejectMcpRequest } from "../../../src/mcp/confirmation-runner.js";
import {
  getMcpConfirmationRequest,
  listMcpConfirmationRequests,
} from "../../../src/mcp/security/confirmation.js";
import { processReviewDecision } from "../../../src/core/review-processor.js";
import { GoalRepository } from "../../../src/goal/repository.js";

function freshRoot(seed: (db: Database.Database, root: string) => void = () => {}): string {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-mut-"));
  mkdirSync(join(root, "backlog", "open"), { recursive: true });
  mkdirSync(join(root, "backlog", "doing"), { recursive: true });
  mkdirSync(join(root, "backlog", "done"), { recursive: true });
  mkdirSync(join(root, "backlog", "deferred"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    seed(db, root);
  } finally {
    db.close();
  }
  return root;
}

function server(root: string, config: McpConfig): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_mut",
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

function readDb<T>(root: string, read: (db: Database.Database) => T): T {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function seedProject(db: Database.Database, projectId = "demo"): void {
  db.prepare(
    `INSERT INTO projects
       (project_id, repo_id, profile_path, profile_version, repo_path,
        base_branch, package_manager, created_at, updated_at)
     VALUES (?, ?, ?, 1, '/tmp/demo', 'main', 'npm',
             '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z')`,
  ).run(projectId, `${projectId}-repo`, `projects/${projectId}.yaml`);
}

function seedBacklogItem(db: Database.Database, itemId: string, projectId = "demo"): void {
  db.prepare(
    `INSERT INTO backlog_items
       (item_id, project_id, repo_id, domain, title, goal, status, priority,
        tags_json, created_at, updated_at, source_mode)
     VALUES (?, ?, ?, 'apps/web', 'Backlog item', 'Do work', 'open', 'medium',
             '[]', '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z',
             'db-first')`,
  ).run(itemId, projectId, `${projectId}-repo`);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function seedLocalBlobStore(db: Database.Database, root: string): void {
  db.prepare(
    `INSERT INTO blob_stores
       (store_id, store_type, config_json, created_at, updated_at,
        status, metadata_json)
     VALUES ('local-main', 'local', ?, '2026-05-25T00:00:00Z',
             '2026-05-25T00:00:00Z', 'active', '{}')`,
  ).run(JSON.stringify({ root }));
}

function seedRun(db: Database.Database, runId: string, projectId: string): void {
  db.prepare(
    `INSERT INTO runs
       (run_id, repo_id, project_id, repo_path, domain, workflow,
        base_branch, run_branch, status, safety_status, started_at,
        source_meta_sha256, updated_at, meta_json)
     VALUES
       (?, ?, ?, '/tmp/demo', 'apps/web', 'domain-coding', 'main',
        ?, 'approved', 'clean', '2026-05-25T00:00:00Z', 'sha',
        '2026-05-25T00:00:00Z', '{}')`,
  ).run(runId, `${projectId}-repo`, projectId, `harness/${runId}`);
}

function reviewDecisionYaml(input: {
  runId: string;
  domain?: string;
  decision?: "approved" | "changes_requested" | "rejected";
  reviewer?: string;
  requiredChanges?: string[];
}): string {
  return [
    `runId: ${JSON.stringify(input.runId)}`,
    `domain: ${JSON.stringify(input.domain ?? "apps/web")}`,
    `decision: ${input.decision ?? "approved"}`,
    `required_changes: ${JSON.stringify(input.requiredChanges ?? [])}`,
    `non_blocking_comments: []`,
    `out_of_scope_suggestions: []`,
    `reviewer: ${JSON.stringify(input.reviewer ?? "codex-reviewer")}`,
    `reviewed_at: "2026-05-25T01:00:00Z"`,
    "",
  ].join("\n");
}

function seedReviewableRun(
  db: Database.Database,
  root: string,
  input: {
    runId: string;
    projectId?: string;
    baseBranch?: string;
    decision?: "approved" | "changes_requested" | "rejected";
  },
): { proposalId: number; sourceSha256: string } {
  const projectId = input.projectId ?? "demo";
  const runDir = join(root, "runs", input.runId);
  mkdirSync(runDir, { recursive: true });
  const meta = {
    runId: input.runId,
    repoId: `${projectId}-repo`,
    repoPath: "/tmp/demo",
    domain: "apps/web",
    workflow: "domain-coding",
    baseBranch: input.baseBranch ?? "main",
    baseSha: "sha",
    runBranch: `harness/${input.runId}`,
    status: "needs_review",
    safetyStatus: "clean",
    startedAt: "2026-05-25T00:00:00Z",
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(join(runDir, "events.jsonl"), "");
  const yaml = reviewDecisionYaml({
    runId: input.runId,
    decision: input.decision ?? "approved",
  });
  writeFileSync(join(runDir, "review-decision.yaml"), yaml);
  const sourceSha256 = sha256Text(yaml);
  db.prepare(
    `INSERT INTO runs
       (run_id, repo_id, project_id, repo_path, domain, workflow,
        base_branch, run_branch, status, safety_status, started_at,
        source_meta_sha256, updated_at, source_mode, db_revision, meta_json)
     VALUES
       (?, ?, ?, '/tmp/demo', 'apps/web', 'domain-coding', ?,
        ?, 'needs_review', 'clean', '2026-05-25T00:00:00Z', 'sha',
        '2026-05-25T00:00:00Z', 'db-first', 1, ?)`,
  ).run(
    input.runId,
    `${projectId}-repo`,
    projectId,
    input.baseBranch ?? "main",
    `harness/${input.runId}`,
    JSON.stringify(meta, null, 2),
  );
  const inserted = db.prepare(
    `INSERT INTO review_proposals
       (run_id, reviewer, decision, required_changes_json,
        non_blocking_comments_json, out_of_scope_suggestions_json,
        reviewed_at, source_yaml, source_sha256, created_at)
     VALUES (?, 'codex-reviewer', ?, '[]', '[]', '[]',
             '2026-05-25T01:00:00Z', ?, ?, '2026-05-25T01:00:00Z')`,
  ).run(input.runId, input.decision ?? "approved", yaml, sourceSha256);
  return { proposalId: Number(inserted.lastInsertRowid), sourceSha256 };
}

function seedDbBlob(db: Database.Database, sha: string, body: Buffer): void {
  db.prepare(
    `INSERT INTO artifact_blobs
       (sha256, bytes, content_encoding, stored_bytes, chunk_count, created_at)
     VALUES (?, ?, 'identity', ?, 1, '2026-05-25T00:00:00Z')`,
  ).run(sha, body.length, body.length);
  db.prepare(
    `INSERT INTO artifact_blob_chunks (sha256, chunk_index, content)
     VALUES (?, 0, ?)`,
  ).run(sha, body);
}

function writeLocalBlob(root: string, sha: string, body: Buffer): void {
  const dir = join(root, "sha256", sha.slice(0, 2), sha.slice(2, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sha), body);
}

describe("MCP mutation, confirmation, and audit", () => {
  it("runs allowlisted safe mutations through OperationRunner and replays idempotency", async () => {
    const root = freshRoot((db) => {
      db.prepare(
        `INSERT INTO projects
           (project_id, repo_id, profile_path, profile_version, repo_path,
            base_branch, package_manager, created_at, updated_at)
         VALUES ('demo', 'demo-repo', 'projects/demo.yaml', 1, '/tmp/demo',
                 'main', 'npm', '2026-05-25T00:00:00Z',
                 '2026-05-25T00:00:00Z')`,
      ).run();
    });
    const config: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["demo"],
      allowedOperations: ["backlog.create"],
    };
    const s = server(root, config);
    await s.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "unit-test", version: "1" } },
    });

    const first = await callTool(s, "harness.backlog.create", {
      projectId: "demo",
      domain: "apps/web",
      title: "Add search",
      goal: "Implement search",
      idempotencyKey: "idem-1",
    });
    expect(first.status).toBe("operation_started");
    expect(first.operationId).toMatch(/^op-/);
    expect(first.data.replayed).toBe(false);
    expect(first.data.result.item.id).toMatch(/^item-/);

    const second = await callTool(s, "harness.backlog.create", {
      projectId: "demo",
      domain: "apps/web",
      title: "Different title is ignored by replay",
      goal: "Different goal",
      idempotencyKey: "idem-1",
    });
    expect(second.status).toBe("operation_started");
    expect(second.operationId).toBe(first.operationId);
    expect(second.data.replayed).toBe(true);

    const audit = readDb(root, (db) => ({
      operations: db.prepare("SELECT * FROM operations").all() as any[],
      invocations: db.prepare("SELECT * FROM mcp_tool_invocations").all() as any[],
    }));
    expect(audit.operations).toHaveLength(1);
    expect(audit.operations[0].actor).toBe("mcp:unit-test");
    expect(JSON.parse(audit.operations[0].metadata_json).toolName).toBe(
      "harness.backlog.create",
    );
    expect(audit.invocations).toHaveLength(2);
    expect(audit.invocations[0].operation_id).toBe(first.operationId);
    expect(JSON.parse(audit.invocations[0].arguments_redacted_json).idempotencyKey).toBe(
      "[redacted]",
    );
    });

    it("requires out-of-band confirmation for safe mutations configured with requireConfirmation", async () => {
      const root = freshRoot((db) => {
        db.prepare(
          `INSERT INTO projects
             (project_id, repo_id, profile_path, profile_version, repo_path,
              base_branch, package_manager, created_at, updated_at)
           VALUES ('demo', 'demo-repo', 'projects/demo.yaml', 1, '/tmp/demo',
                   'main', 'npm', '2026-05-25T00:00:00Z',
                   '2026-05-25T00:00:00Z')`,
        ).run();
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["backlog.create"],
        requireConfirmation: ["backlog.create"],
      };
      const s = server(root, config);

      const pending = await callTool(s, "harness.backlog.create", {
        projectId: "demo",
        domain: "apps/web",
        title: "Add search",
        goal: "Implement search",
        idempotencyKey: "confirm-safe-1",
      });
      expect(pending.status).toBe("confirmation_required");
      expect(pending.confirmationId).toMatch(/^mcpconf-/);
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM operations").get() as { n: number }).n,
        ),
      ).toBe(0);
      expect(
        readDb(root, (db) =>
          db
            .prepare(
              `SELECT result_status, confirmation_id
                 FROM mcp_tool_invocations
                WHERE tool_name = 'harness.backlog.create'`,
            )
            .get() as any,
        ),
      ).toMatchObject({
        result_status: "confirmation_required",
        confirmation_id: pending.confirmationId,
      });

      const confirmed = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: pending.confirmationId,
        confirmedBy: "human",
        config,
      });
      expect(confirmed.status).toBe("operation_started");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM backlog_items").get() as { n: number }).n,
        ),
      ).toBe(1);
    });

    it("redacts secret-shaped values in MCP invocation audit and confirmation listings", async () => {
      const root = freshRoot((db) => {
        seedProject(db);
      });
      const secret = `sk-${"a".repeat(40)}`;
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["backlog.create"],
        requireConfirmation: ["backlog.create"],
      };

      const pending = await callTool(server(root, config), "harness.backlog.create", {
        projectId: "demo",
        domain: "apps/web",
        title: "Add search",
        goal: `do not leak ${secret}`,
        idempotencyKey: "secret-redact-1",
      });
      expect(pending.status).toBe("confirmation_required");

      const invocationArgs = readDb(root, (db) =>
        (db
          .prepare(
            `SELECT arguments_redacted_json
               FROM mcp_tool_invocations
              WHERE tool_name = 'harness.backlog.create'`,
          )
          .get() as { arguments_redacted_json: string }).arguments_redacted_json,
      );
      expect(invocationArgs).not.toContain(secret);
      expect(JSON.parse(invocationArgs).goal).toBe("[redacted]");

      const confirmations = listMcpConfirmationRequests(root, { limit: 10 });
      expect(confirmations).toHaveLength(1);
      expect(JSON.stringify(confirmations)).not.toContain(secret);
      expect(JSON.parse(confirmations[0].inputJson).goal).toBe("[redacted]");
      expect(JSON.parse(confirmations[0].previewJson).data.preview).toBeUndefined();
      expect(JSON.parse(confirmations[0].previewJson).data.arguments.goal).toBe("[redacted]");

      const confirmed = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: pending.confirmationId,
        confirmedBy: "human",
        config,
      });
      expect(confirmed.status).toBe("operation_started");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT goal FROM backlog_items").get() as { goal: string }).goal,
        ),
      ).toContain(secret);
    });

    it("completes audited invocations when a handler throws", async () => {
      const root = freshRoot();
      const tool = MCP_TOOL_DEFINITIONS.find(
        (definition) => definition.name === "harness.db.repair.dry_run",
      );
      expect(tool).toBeDefined();
      const originalHandler = tool!.handler;
      const secret = `sk-${"b".repeat(40)}`;
      tool!.handler = () => {
        throw new Error(`handler leaked ${secret}`);
      };
      try {
        const s = server(root, DEFAULT_MCP_CONFIG);
        await s.handleMessage({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { clientInfo: { name: "unit-test" } },
        });
        const result = await callTool(s, "harness.db.repair.dry_run", { limit: 1 });
        expect(result.status).toBe("error");
        const row = readDb(root, (db) =>
          db
            .prepare(
              `SELECT result_status, completed_at, error_message
                 FROM mcp_tool_invocations
                WHERE tool_name = 'harness.db.repair.dry_run'`,
            )
            .get() as any,
        );
        expect(row.result_status).toBe("error");
        expect(row.completed_at).not.toBeNull();
        expect(row.error_message).toBe("[redacted]");
      } finally {
        tool!.handler = originalHandler;
      }
    });

    it("binds dangerous blob confirmation previews to the requested action", async () => {
      const root = freshRoot((db, harnessRoot) => {
        const storeRoot = join(harnessRoot, "blob-store");
        mkdirSync(storeRoot, { recursive: true });
        seedLocalBlobStore(db, storeRoot);
        seedRun(db, "run-blob", "demo");
        const dbOnlySha = "a".repeat(64);
        const externalSha = "b".repeat(64);
        const orphanSha = "c".repeat(64);
        db.prepare(
          `INSERT INTO artifact_blobs
             (sha256, bytes, content_encoding, stored_bytes, chunk_count, created_at)
           VALUES (?, 4, 'identity', 4, 1, '2026-05-25T00:00:00Z')`,
        ).run(dbOnlySha);
        db.prepare(
          `INSERT INTO artifacts
             (artifact_id, run_id, kind, relative_path, content_type, bytes,
              sha256, storage, blob_sha256, body_status, created_at)
           VALUES
             ('artifact-db', 'run-blob', 'log', 'a.txt', 'text/plain',
              4, ?, 'db', ?, 'db_available', '2026-05-25T00:00:00Z'),
             ('artifact-ext', 'run-blob', 'log', 'b.txt', 'text/plain',
              4, ?, 'external', ?, 'external_available',
              '2026-05-25T00:00:00Z')`,
        ).run(dbOnlySha, dbOnlySha, externalSha, externalSha);
        for (const sha of [externalSha, orphanSha]) {
          db.prepare(
            `INSERT INTO external_artifact_blobs
               (sha256, store_id, uri, bytes, stored_bytes, content_encoding,
                uploaded_at, status, metadata_json)
             VALUES (?, 'local-main', ?, 4, 4, 'identity',
                     '2026-05-25T00:00:00Z', 'available', '{}')`,
          ).run(sha, `file://${sha}`);
        }
      });
      const s = server(root, DEFAULT_MCP_CONFIG);

      const toExternal = await callTool(s, "harness.db.migrate_blobs.apply", {
        to: "external",
        storeId: "local-main",
        idempotencyKey: "migrate-ext-preview",
      });
      expect(toExternal.status).toBe("confirmation_required");
      expect(toExternal.data.preview.data.direction).toBe("db-to-external");

      const toDb = await callTool(s, "harness.db.migrate_blobs.apply", {
        to: "db",
        storeId: "local-main",
        idempotencyKey: "migrate-db-preview",
      });
      expect(toDb.status).toBe("confirmation_required");
      expect(toDb.data.preview.data.direction).toBe("external-to-db");

      const gc = await callTool(s, "harness.db.gc_blobs.apply", {
        storeId: "local-main",
        deleteObjects: true,
        idempotencyKey: "gc-preview",
      });
      expect(gc.status).toBe("confirmation_required");
      expect(gc.data.preview.data.operation).toBe("external-blob-gc");
      expect(gc.data.preview.data.deleteObjects).toBe(true);
      expect(gc.data.preview.data.candidates.map((c: any) => c.sha256)).toEqual(["c".repeat(64)]);
    });

    it("confirmed blob migration mutates only stored preview candidates", async () => {
      const root = freshRoot((db, harnessRoot) => {
        const storeRoot = join(harnessRoot, "blob-store");
        mkdirSync(storeRoot, { recursive: true });
        seedLocalBlobStore(db, storeRoot);
        seedRun(db, "run-demo", "demo");
        seedRun(db, "run-other", "other");

        const demoBody = Buffer.from("demo db blob");
        const demoSha = sha256Text(demoBody.toString("utf8"));
        const otherBody = Buffer.from("other db blob");
        const otherSha = sha256Text(otherBody.toString("utf8"));
        seedDbBlob(db, demoSha, demoBody);
        seedDbBlob(db, otherSha, otherBody);
        db.prepare(
          `INSERT INTO artifacts
             (artifact_id, run_id, kind, relative_path, content_type, bytes,
              sha256, storage, blob_sha256, body_status, created_at)
           VALUES
             ('artifact-demo-db', 'run-demo', 'log', 'demo.txt', 'text/plain',
              ?, ?, 'db', ?, 'db_available', '2026-05-25T00:00:00Z'),
             ('artifact-other-db', 'run-other', 'log', 'other.txt', 'text/plain',
              ?, ?, 'db', ?, 'db_available', '2026-05-25T00:00:00Z')`,
        ).run(demoBody.length, demoSha, demoSha, otherBody.length, otherSha, otherSha);
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo"],
      };
      const pending = await callTool(server(root, config), "harness.db.migrate_blobs.apply", {
        to: "external",
        storeId: "local-main",
        idempotencyKey: "migrate-scoped-1",
      });
      expect(pending.status).toBe("confirmation_required");
      expect(pending.data.preview.data.candidates).toHaveLength(1);

      const confirmed = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: pending.confirmationId,
        confirmedBy: "human",
        config,
      });
      expect(confirmed.status).toBe("operation_started");
      expect(
        readDb(root, (db) =>
          (db
            .prepare("SELECT artifact_id, storage FROM artifacts ORDER BY artifact_id")
            .all() as any[]).map((r) => [r.artifact_id, r.storage]),
        ),
      ).toEqual([
        ["artifact-demo-db", "external"],
        ["artifact-other-db", "db"],
      ]);
    });

    it("confirmed db-to-external migration honors the stored preview limit", async () => {
      const root = freshRoot((db, harnessRoot) => {
        const storeRoot = join(harnessRoot, "blob-store");
        mkdirSync(storeRoot, { recursive: true });
        seedLocalBlobStore(db, storeRoot);
        seedRun(db, "run-demo", "demo");

        for (const [artifactId, text] of [
          ["artifact-db-1", "db blob one"],
          ["artifact-db-2", "db blob two with more bytes"],
        ] as const) {
          const body = Buffer.from(text);
          const sha = sha256Text(text);
          seedDbBlob(db, sha, body);
          db.prepare(
            `INSERT INTO artifacts
               (artifact_id, run_id, kind, relative_path, content_type, bytes,
                sha256, storage, blob_sha256, body_status, created_at)
             VALUES (?, 'run-demo', 'log', ?, 'text/plain', ?, ?, 'db',
                     ?, 'db_available', '2026-05-25T00:00:00Z')`,
          ).run(artifactId, `${artifactId}.txt`, body.length, sha, sha);
        }
      });

      const pending = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.db.migrate_blobs.apply", {
        to: "external",
        storeId: "local-main",
        limit: 1,
        idempotencyKey: "migrate-ext-limit-1",
      });
      expect(pending.status).toBe("confirmation_required");
      expect(pending.data.preview.data.candidates).toHaveLength(1);

      const confirmed = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: pending.confirmationId,
        confirmedBy: "human",
      });
      expect(confirmed.status).toBe("operation_started");
      const rows = readDb(root, (db) =>
        db
          .prepare("SELECT artifact_id, storage FROM artifacts ORDER BY artifact_id")
          .all() as any[],
      );
      expect(rows.filter((r) => r.storage === "external")).toHaveLength(1);
      expect(rows.filter((r) => r.storage === "db")).toHaveLength(1);
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM external_artifact_blobs").get() as { n: number }).n,
        ),
      ).toBe(1);
    });

    it("confirmed external-to-db migration respects allowedProjects", async () => {
      const root = freshRoot((db, harnessRoot) => {
        const storeRoot = join(harnessRoot, "blob-store");
        mkdirSync(storeRoot, { recursive: true });
        seedLocalBlobStore(db, storeRoot);
        seedRun(db, "run-demo", "demo");
        seedRun(db, "run-other", "other");

        for (const [artifactId, runId, text] of [
          ["artifact-demo-ext", "run-demo", "demo external blob"],
          ["artifact-other-ext", "run-other", "other external blob"],
        ] as const) {
          const body = Buffer.from(text);
          const sha = sha256Text(text);
          writeLocalBlob(storeRoot, sha, body);
          db.prepare(
            `INSERT INTO external_artifact_blobs
               (sha256, store_id, uri, bytes, stored_bytes, content_encoding,
                uploaded_at, status, metadata_json)
             VALUES (?, 'local-main', ?, ?, ?, 'identity',
                     '2026-05-25T00:00:00Z', 'available', '{}')`,
          ).run(sha, `file://${sha}`, body.length, body.length);
          db.prepare(
            `INSERT INTO artifacts
               (artifact_id, run_id, kind, relative_path, content_type, bytes,
                sha256, storage, blob_sha256, body_status, created_at)
             VALUES (?, ?, 'log', ?, 'text/plain', ?, ?, 'external',
                     ?, 'external_available', '2026-05-25T00:00:00Z')`,
          ).run(artifactId, runId, `${artifactId}.txt`, body.length, sha, sha);
        }
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo"],
      };

      const pending = await callTool(server(root, config), "harness.db.migrate_blobs.apply", {
        to: "db",
        storeId: "local-main",
        idempotencyKey: "migrate-db-scoped-1",
      });
      expect(pending.status).toBe("confirmation_required");
      expect(pending.data.preview.data.candidates.map((c: any) => c.artifactId)).toEqual([
        "artifact-demo-ext",
      ]);

      const confirmed = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: pending.confirmationId,
        confirmedBy: "human",
        config,
      });
      expect(confirmed.status).toBe("operation_started");
      expect(
        readDb(root, (db) =>
          (db
            .prepare("SELECT artifact_id, storage FROM artifacts ORDER BY artifact_id")
            .all() as any[]).map((r) => [r.artifact_id, r.storage]),
        ),
      ).toEqual([
        ["artifact-demo-ext", "db"],
        ["artifact-other-ext", "external"],
      ]);
    });

    it("confirmed external-to-db migration and GC honor preview limits", async () => {
      const root = freshRoot((db, harnessRoot) => {
        const storeRoot = join(harnessRoot, "blob-store");
        mkdirSync(storeRoot, { recursive: true });
        seedLocalBlobStore(db, storeRoot);
        seedRun(db, "run-blob", "demo");
        for (const [artifactId, text] of [
          ["artifact-ext-1", "external one"],
          ["artifact-ext-2", "external two"],
        ] as const) {
          const body = Buffer.from(text);
          const sha = sha256Text(text);
          writeLocalBlob(storeRoot, sha, body);
          db.prepare(
            `INSERT INTO external_artifact_blobs
               (sha256, store_id, uri, bytes, stored_bytes, content_encoding,
                uploaded_at, status, metadata_json)
             VALUES (?, 'local-main', ?, ?, ?, 'identity',
                     '2026-05-25T00:00:00Z', 'available', '{}')`,
          ).run(sha, `file://${sha}`, body.length, body.length);
          db.prepare(
            `INSERT INTO artifacts
               (artifact_id, run_id, kind, relative_path, content_type, bytes,
                sha256, storage, blob_sha256, body_status, created_at)
             VALUES (?, 'run-blob', 'log', ?, 'text/plain', ?, ?, 'external',
                     ?, 'external_available', '2026-05-25T00:00:00Z')`,
          ).run(artifactId, `${artifactId}.txt`, body.length, sha, sha);
        }
        for (let i = 0; i < 101; i++) {
          const sha = (i + 1).toString(16).padStart(64, "0");
          db.prepare(
            `INSERT INTO external_artifact_blobs
               (sha256, store_id, uri, bytes, stored_bytes, content_encoding,
                uploaded_at, status, metadata_json)
             VALUES (?, 'local-main', ?, 1, 1, 'identity',
                     '2026-05-25T00:00:00Z', 'available', '{}')`,
          ).run(sha, `file://${sha}`);
        }
      });

      const toDb = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.db.migrate_blobs.apply", {
        to: "db",
        storeId: "local-main",
        limit: 1,
        idempotencyKey: "migrate-db-limit-1",
      });
      expect(toDb.status).toBe("confirmation_required");
      expect(toDb.data.preview.data.candidates).toHaveLength(1);
      const migrated = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: toDb.confirmationId,
        confirmedBy: "human",
      });
      expect(migrated.status).toBe("operation_started");
      expect(
        readDb(root, (db) =>
          (db
            .prepare("SELECT storage FROM artifacts WHERE artifact_id LIKE 'artifact-ext-%'")
            .all() as any[]).filter((r) => r.storage === "db").length,
        ),
      ).toBe(1);

      const gc = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.db.gc_blobs.apply", {
        storeId: "local-main",
        idempotencyKey: "gc-limit-1",
      });
      expect(gc.status).toBe("confirmation_required");
      expect(gc.data.preview.data.candidates).toHaveLength(100);
      const collected = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: gc.confirmationId,
        confirmedBy: "human",
      });
      expect(collected.status).toBe("operation_started");
      expect(collected.data.result.removed).toHaveLength(100);
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM external_artifact_blobs").get() as { n: number }).n,
        ),
      ).toBe(3);
    });

    it("enforces DB-backed mutation rate limits without blocking idempotent replay", async () => {
      const root = freshRoot((db) => {
        db.prepare(
          `INSERT INTO projects
             (project_id, repo_id, profile_path, profile_version, repo_path,
              base_branch, package_manager, created_at, updated_at)
           VALUES ('demo', 'demo-repo', 'projects/demo.yaml', 1, '/tmp/demo',
                   'main', 'npm', '2026-05-25T00:00:00Z',
                   '2026-05-25T00:00:00Z')`,
        ).run();
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["backlog.create"],
        limits: {
          ...DEFAULT_MCP_CONFIG.limits,
          maxMutationOperationsPerHour: 1,
        },
      };
      const s = server(root, config);
      const args = {
        projectId: "demo",
        domain: "apps/web",
        title: "Add search",
        goal: "Implement search",
        idempotencyKey: "rate-1",
      };

      const first = await callTool(s, "harness.backlog.create", args);
      expect(first.status).toBe("operation_started");

      const replay = await callTool(s, "harness.backlog.create", args);
      expect(replay.status).toBe("operation_started");
      expect(replay.operationId).toBe(first.operationId);
      expect(replay.data.replayed).toBe(true);

      const denied = await callTool(s, "harness.backlog.create", {
        ...args,
        title: "Another item",
        idempotencyKey: "rate-2",
      });
      expect(denied.status).toBe("permission_denied");
      expect(denied.data.limit).toBe("maxMutationOperationsPerHour");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM operations").get() as { n: number }).n,
        ),
      ).toBe(1);
    });

    it("enforces run budgets while preserving idempotent pending replay", async () => {
      const root = freshRoot((db) => {
        seedProject(db);
        seedBacklogItem(db, "item-20260525-001");
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["backlog.run"],
        limits: {
          ...DEFAULT_MCP_CONFIG.limits,
          maxRunsPerHour: 1,
        },
      };
      const s = server(root, config);
      const args = {
        itemId: "item-20260525-001",
        idempotencyKey: "run-rate-1",
      };

      const first = await callTool(s, "harness.backlog.run", args);
      expect(first.status).toBe("queued");

      const replay = await callTool(s, "harness.backlog.run", args);
      expect(replay.status).toBe("queued");
      expect(replay.operationId).toBe(first.operationId);
      expect(replay.data.replayed).toBe(true);

      const denied = await callTool(s, "harness.backlog.run", {
        itemId: "item-20260525-001",
        idempotencyKey: "run-rate-2",
      });
      expect(denied.status).toBe("permission_denied");
      expect(denied.data.limit).toBe("maxRunsPerHour");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM operations").get() as { n: number }).n,
        ),
      ).toBe(1);
    });

    it("denies concurrent run budget without creating a new operation row", async () => {
      const root = freshRoot((db) => {
        seedProject(db);
        seedBacklogItem(db, "item-20260525-001");
        db.prepare(
          `INSERT INTO operations
             (operation_id, command, scope_type, scope_id, result_json, created_at,
              operation_type, target_type, target_id, actor, idempotency_key,
              dry_run, status, input_json, started_at, metadata_json)
           VALUES
             ('op-existing-pending', 'backlog.run', 'backlog_item',
              'item-20260525-001', '{"accepted":true}',
              '2026-05-25T00:00:00Z', 'backlog.run', 'backlog_item',
              'item-20260525-001', 'mcp:unit-test', 'concurrent-1',
              0, 'pending', '{}', '2026-05-25T00:00:00Z', '{}')`,
        ).run();
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["backlog.run"],
        limits: {
          ...DEFAULT_MCP_CONFIG.limits,
          maxConcurrentRuns: 1,
        },
      };
      const s = server(root, config);

      const replay = await callTool(s, "harness.backlog.run", {
        itemId: "item-20260525-001",
        idempotencyKey: "concurrent-1",
      });
      expect(replay.status).toBe("queued");
      expect(replay.operationId).toBe("op-existing-pending");
      expect(replay.data.replayed).toBe(true);

      const denied = await callTool(s, "harness.backlog.run", {
        itemId: "item-20260525-001",
        idempotencyKey: "concurrent-2",
      });
      expect(denied.status).toBe("permission_denied");
      expect(denied.data.limit).toBe("maxConcurrentRuns");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM operations").get() as { n: number }).n,
        ),
      ).toBe(1);
    });

    it("replays prior failed mutation idempotency without creating a second row", async () => {
      const root = freshRoot((db) => {
        seedProject(db);
        db.prepare(
          `INSERT INTO operations
             (operation_id, command, scope_type, scope_id, result_json, created_at,
              operation_type, target_type, target_id, actor, idempotency_key,
              dry_run, status, input_json, error_code, error_message, started_at,
              completed_at, metadata_json)
           VALUES
             ('op-prior-failed', 'backlog.create', 'backlog_domain', 'demo',
              NULL, '2026-05-25T00:00:00Z', 'backlog.create',
              'backlog_domain', 'demo', 'mcp:unit-test', 'failed-replay-1',
              0, 'failed', '{}', 'boom', 'prior failed',
              '2026-05-25T00:00:00Z', '2026-05-25T00:00:01Z', '{}')`,
        ).run();
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["backlog.create"],
      };
      const result = await callTool(server(root, config), "harness.backlog.create", {
        projectId: "demo",
        domain: "apps/web",
        title: "Retry item",
        goal: "Retry work",
        idempotencyKey: "failed-replay-1",
      });

      expect(result.status).toBe("error");
      expect(result.data.reason).toBe("idempotency_replayed_failure");
      expect(result.data.operationId).toBe("op-prior-failed");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM operations").get() as { n: number }).n,
        ),
      ).toBe(1);
    });

    it("denies scoped knowledge decisions when the candidate row is absent", async () => {
      const root = freshRoot((db, harnessRoot) => {
        const runDir = join(harnessRoot, "runs", "run-knowledge");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, "meta.json"),
          JSON.stringify({ project: { projectId: "demo" }, repoId: "demo-repo" }),
        );
        writeFileSync(
          join(runDir, "knowledge-candidates.yaml"),
          [
            "candidates:",
            "  - kind: policy_improvement",
            "    domain: apps/web",
            "    title: t",
            "    content: c",
            "    evidence: [e]",
            "    confidence: medium",
            "    status: candidate",
            "",
          ].join("\n"),
        );
        db.prepare(
          `INSERT INTO runs
             (run_id, repo_id, project_id, repo_path, domain, workflow,
              base_branch, run_branch, status, safety_status, started_at,
              source_meta_sha256, updated_at, meta_json)
           VALUES
             ('run-knowledge', 'demo-repo', 'demo', '/tmp/demo', 'apps/web',
              'domain-coding', 'main', 'harness/run-knowledge', 'needs_review',
              'clean', '2026-05-25T00:00:00Z', 'sha',
              '2026-05-25T00:00:00Z', '{}')`,
        ).run();
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["other"],
        allowedOperations: ["knowledge.promote"],
      };

      const denied = await callTool(server(root, config), "harness.knowledge.promote", {
        candidateId: "run-knowledge:0",
        idempotencyKey: "knowledge-denied-1",
      });
      expect(denied.status).toBe("permission_denied");
      expect(denied.data.reason).toBe("project_not_allowed");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM knowledge_candidates").get() as { n: number }).n,
        ),
      ).toBe(0);
    });

    it("denies scoped knowledge decisions when an existing candidate row belongs to another project", async () => {
      const root = freshRoot((db) => {
        db.prepare(
          `INSERT INTO knowledge_candidates
             (candidate_id, run_id, project_id, repo_id, domain, kind, title,
              body, status, created_at)
           VALUES
             ('run-knowledge:0', 'run-knowledge', 'demo', 'demo-repo',
              'apps/web', 'policy_improvement', 't', 'c', 'candidate',
              '2026-05-25T00:00:00Z')`,
        ).run();
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["other"],
        allowedOperations: ["knowledge.promote"],
      };

      const denied = await callTool(server(root, config), "harness.knowledge.promote", {
        candidateId: "run-knowledge:0",
        idempotencyKey: "knowledge-denied-existing-1",
      });
      expect(denied.status).toBe("permission_denied");
      expect(denied.data.reason).toBe("project_not_allowed");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM operations").get() as { n: number }).n,
        ),
      ).toBe(0);
    });

    it("denies db.repair.apply confirmation when the finding resolves outside allowedProjects", async () => {
      const root = freshRoot((db) => {
        db.prepare(
          `INSERT INTO runs
             (run_id, repo_id, project_id, repo_path, domain, workflow,
              base_branch, run_branch, status, safety_status, started_at,
              source_meta_sha256, updated_at, meta_json)
           VALUES
             ('run-demo', 'demo-repo', 'demo', '/tmp/demo', 'apps/web',
              'domain-coding', 'main', 'harness/run-demo', 'approved',
              'clean', '2026-05-25T00:00:00Z', 'sha',
              '2026-05-25T00:00:00Z', '{}')`,
        ).run();
        db.prepare(
          `INSERT INTO doctor_runs
             (doctor_run_id, started_at, completed_at, status, summary_json)
           VALUES ('doctor-1', '2026-05-25T00:00:00Z',
                   '2026-05-25T00:00:00Z', 'warn', '{}')`,
        ).run();
        db.prepare(
          `INSERT INTO doctor_findings
             (doctor_run_id, check_id, severity, status, message, repairable,
              details_json)
           VALUES ('doctor-1', 'lock.expired_active', 'warn', 'flagged',
                   'expired lock', 1, ?)`,
        ).run(JSON.stringify({ run_id: "run-demo", lock_id: 1 }));
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["other"],
      };

      const denied = await callTool(server(root, config), "harness.db.repair.apply", {
        findingId: 1,
        idempotencyKey: "repair-denied-1",
      });
      expect(denied.status).toBe("permission_denied");
      expect(denied.data.reason).toBe("project_not_allowed");
      expect(
        readDb(root, (db) =>
          (db.prepare("SELECT count(*) AS n FROM mcp_confirmation_requests").get() as { n: number }).n,
        ),
      ).toBe(0);
    });

    it("rechecks db.repair.apply project scope when the finding changes before confirm", async () => {
      const root = freshRoot((db) => {
        db.prepare(
          `INSERT INTO runs
             (run_id, repo_id, project_id, repo_path, domain, workflow,
              base_branch, run_branch, status, safety_status, started_at,
              source_meta_sha256, updated_at, meta_json)
           VALUES
             ('run-demo', 'demo-repo', 'demo', '/tmp/demo', 'apps/web',
              'domain-coding', 'main', 'harness/run-demo', 'approved',
              'clean', '2026-05-25T00:00:00Z', 'sha',
              '2026-05-25T00:00:00Z', '{}'),
             ('run-other', 'other-repo', 'other', '/tmp/other', 'apps/web',
              'domain-coding', 'main', 'harness/run-other', 'approved',
              'clean', '2026-05-25T00:00:00Z', 'sha',
              '2026-05-25T00:00:00Z', '{}')`,
        ).run();
        db.prepare(
          `INSERT INTO domain_locks
             (domain_key, repo_id, domain, holder_run_id, holder_pid,
              holder_hostname, acquired_at, expires_at, heartbeat_at)
           VALUES
             ('demo-repo::apps/web', 'demo-repo', 'apps/web', 'run-demo',
              123, 'host', '2026-05-25T00:00:00Z', '2020-01-01T00:00:00Z',
              '2026-05-25T00:00:00Z')`,
        ).run();
        const lock = db.prepare("SELECT lock_id FROM domain_locks").get() as { lock_id: number };
        db.prepare(
          `INSERT INTO doctor_runs
             (doctor_run_id, started_at, completed_at, status, summary_json)
           VALUES ('doctor-1', '2026-05-25T00:00:00Z',
                   '2026-05-25T00:00:00Z', 'warn', '{}')`,
        ).run();
        db.prepare(
          `INSERT INTO doctor_findings
             (doctor_run_id, check_id, severity, status, message, repairable,
              details_json)
           VALUES ('doctor-1', 'lock.expired_active', 'warn', 'flagged',
                   'expired lock', 1, ?)`,
        ).run(JSON.stringify({ lock_id: lock.lock_id, run_id: "run-demo" }));
      });
      const config: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo"],
      };
      const pending = await callTool(server(root, config), "harness.db.repair.apply", {
        findingId: 1,
        idempotencyKey: "repair-recheck-1",
      });
      expect(pending.status).toBe("confirmation_required");

      readDb(root, (db) =>
        db
          .prepare("UPDATE doctor_findings SET details_json = ? WHERE finding_id = 1")
          .run(JSON.stringify({ run_id: "run-other" })),
      );
      const confirmed = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: pending.confirmationId,
        confirmedBy: "human",
        config,
      });
      expect(confirmed.status).toBe("error");
      expect(confirmed.data.reason).toBe("project_not_allowed");
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT count(*) AS n FROM repair_actions WHERE dry_run = 0").get() as { n: number }).n,
      ),
    ).toBe(0);
  });

  it("checks run.start budgets before expensive project preparation", async () => {
    const root = freshRoot((db) => {
      db.prepare(
        `INSERT INTO operations
           (operation_id, command, scope_type, scope_id, result_json,
            created_at, operation_type, target_type, target_id, actor,
            idempotency_key, dry_run, status, input_json, started_at,
            metadata_json)
         VALUES
           ('op-budget-existing', 'run.start', 'project_domain', 'missing:apps/web',
            '{}', ?, 'run.start', 'project_domain', 'missing:apps/web',
            'mcp:unit-test', 'budget-existing', 0, 'running', '{}', ?, '{}')`,
      ).run(new Date().toISOString(), new Date().toISOString());
    });
    const config: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedOperations: ["run.start"],
      limits: {
        ...DEFAULT_MCP_CONFIG.limits,
        maxMutationOperationsPerHour: 1,
        maxRunsPerHour: 10,
        maxConcurrentRuns: 10,
      },
    };
    const result = await callTool(server(root, config), "harness.run.start", {
      projectId: "missing",
      domain: "apps/web",
      goal: "Should hit budget before profile resolution",
      idempotencyKey: "budget-new",
    });
    expect(result.status).toBe("permission_denied");
    expect(result.data.limit).toBe("maxMutationOperationsPerHour");
  });

  it("rejects goal-linked run.start when convergence is budget_exhausted", async () => {
    const root = freshRoot((db) => {
      new GoalRepository(db).createSession({
        goalId: "goal-budget-stop",
        title: "Budget exhausted goal",
        projectId: "demo",
        domain: "apps/web",
        createdBy: "test",
        createdSource: "mcp",
      });
      new GoalRepository(db).updateStatus(
        "goal-budget-stop",
        "budget_exhausted",
        "budget exhausted",
      );
    });
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["run.start"],
      }),
      "harness.run.start",
      {
        projectId: "demo",
        domain: "apps/web",
        goal: "Should be blocked",
        goalId: "goal-budget-stop",
        idempotencyKey: "goal-budget-stop-run",
      },
    );

    expect(result.status).toBe("permission_denied");
    expect(result.data.reason).toBe("goal_budget_exhausted");
  });

  it("rejects goal-linked run.start with goal_not_found when the goal is absent", async () => {
    const root = freshRoot();
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["run.start"],
      }),
      "harness.run.start",
      {
        projectId: "demo",
        domain: "apps/web",
        goal: "Should be blocked",
        goalId: "goal-does-not-exist",
        idempotencyKey: "goal-missing-run",
      },
    );

    // A missing goal must be a structured denial, not an opaque DB error.
    expect(result.status).toBe("permission_denied");
    expect(result.data.reason).toBe("goal_not_found");
  });

  it("rejects goal-linked rerun.start when convergence needs classification", async () => {
    const root = freshRoot((db) => {
      seedRun(db, "run-needs-classification", "demo");
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-needs-classification",
        title: "Needs classification",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.upsertFinding({
        goalId: "goal-needs-classification",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "unknown",
        summary: "Unclassified finding",
      });
    });
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["rerun.start"],
      }),
      "harness.rerun.start",
      {
        runId: "run-needs-classification",
        goalId: "goal-needs-classification",
        idempotencyKey: "goal-classification-rerun",
      },
    );

    expect(result.status).toBe("permission_denied");
    expect(result.data.reason).toBe("goal_needs_classification");
  });

  it("rejects goal-linked run.start when convergence is close_ready", async () => {
    const root = freshRoot((db) => {
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-close-ready",
        title: "Close ready",
        projectId: "demo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.recordCloseCheck({
        goalId: "goal-close-ready",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
    });
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["run.start"],
      }),
      "harness.run.start",
      {
        projectId: "demo",
        domain: "apps/web",
        goal: "Should be blocked",
        goalId: "goal-close-ready",
        idempotencyKey: "goal-close-ready-run",
      },
    );

    expect(result.status).toBe("permission_denied");
    expect(result.data.reason).toBe("goal_close_ready");
  });

  it("rejects goal-linked run.start when close checks are pending", async () => {
    const root = freshRoot((db) => {
      seedRun(db, "run-close-check-pending", "demo");
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-close-check-pending",
        title: "Close check pending",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      // a coding pass has already run; the goal awaits close-check evidence.
      repo.createAttempt({
        goalId: "goal-close-check-pending",
        attemptType: "implement",
      });
    });
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["run.start", "rerun.start"],
      }),
      "harness.run.start",
      {
        projectId: "demo",
        domain: "apps/web",
        goal: "Should run close check first",
        goalId: "goal-close-check-pending",
        idempotencyKey: "goal-close-check-pending-run",
      },
    );

    expect(result.status).toBe("permission_denied");
    expect(result.data.reason).toBe("goal_next_action_run_close_check");

    const rerun = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["rerun.start"],
      }),
      "harness.rerun.start",
      {
        runId: "run-close-check-pending",
        goalId: "goal-close-check-pending",
        idempotencyKey: "goal-close-check-pending-rerun",
      },
    );
    expect(rerun.status).toBe("permission_denied");
    expect(rerun.data.reason).toBe("goal_next_action_run_close_check");
  });

  it("allows goal-linked review.auto when close-check evidence is pending", async () => {
    const root = freshRoot((db, harnessRoot) => {
      seedReviewableRun(db, harnessRoot, { runId: "run-review-auto-close-check" });
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-review-auto-close-check",
        title: "Review auto close check",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [
          { id: "review-consensus", kind: "review_consensus", required: true },
        ],
        createdBy: "test",
        createdSource: "mcp",
      });
      // a coding pass has already run; the goal awaits close-check evidence.
      repo.createAttempt({
        goalId: "goal-review-auto-close-check",
        attemptType: "implement",
      });
    });
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["review.auto"],
      }),
      "harness.review.auto",
      {
        runId: "run-review-auto-close-check",
        goalId: "goal-review-auto-close-check",
        idempotencyKey: "goal-review-auto-close-check",
      },
    );

    expect(result.status).toBe("error");
    expect(result.summary).toContain("already has an active proposal");
  });

  it("rejects goal-linked implementation mutations when follow-ups need deferral", async () => {
    const root = freshRoot((db) => {
      seedRun(db, "run-defer-followups", "demo");
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-defer-followups",
        title: "Defer followups",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.upsertFinding({
        goalId: "goal-defer-followups",
        source: "review",
        severity: "P2",
        category: "follow-up",
        scopeStatus: "out_of_scope",
        summary: "Defer this dashboard follow-up",
      });
      repo.recordCloseCheck({
        goalId: "goal-defer-followups",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
    });
    const config = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["demo"],
      allowedOperations: ["run.start", "rerun.start"],
    };
    const s = server(root, config);

    const run = await callTool(s, "harness.run.start", {
      projectId: "demo",
      domain: "apps/web",
      goal: "Should defer followups first",
      goalId: "goal-defer-followups",
      idempotencyKey: "goal-defer-followups-run",
    });
    expect(run.status).toBe("permission_denied");
    expect(run.data.reason).toBe("goal_next_action_defer_followups");

    const rerun = await callTool(s, "harness.rerun.start", {
      runId: "run-defer-followups",
      goalId: "goal-defer-followups",
      idempotencyKey: "goal-defer-followups-rerun",
    });
    expect(rerun.status).toBe("permission_denied");
    expect(rerun.data.reason).toBe("goal_next_action_defer_followups");
  });

  it("allows goal-linked run.start gate when convergence needs a fix", async () => {
    const root = freshRoot((db) => {
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-needs-fix",
        title: "Needs fix",
        projectId: "demo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.upsertFinding({
        goalId: "goal-needs-fix",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Needs implementation",
      });
    });
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["run.start"],
      }),
      "harness.run.start",
      {
        projectId: "demo",
        domain: "apps/web",
        goal: "Allowed past goal gate",
        goalId: "goal-needs-fix",
        idempotencyKey: "goal-needs-fix-run",
      },
    );

    expect(result.status).toBe("error");
    expect(result.summary).toContain("no project profile");
  });

  it("allows goal-linked rerun.start gate when convergence needs a fix", async () => {
    const root = freshRoot((db) => {
      seedRun(db, "run-needs-fix-rerun", "demo");
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-needs-fix-rerun",
        title: "Needs fix rerun",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.upsertFinding({
        goalId: "goal-needs-fix-rerun",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Needs rerun fix",
      });
    });
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["rerun.start"],
      }),
      "harness.rerun.start",
      {
        runId: "run-needs-fix-rerun",
        goalId: "goal-needs-fix-rerun",
        idempotencyKey: "goal-needs-fix-rerun",
      },
    );

    expect(result.status).toBe("error");
    expect(result.summary).toContain("source-mode conflict");
  });

  it("allows implementation mutations when a required close check failed", async () => {
    const root = freshRoot((db) => {
      seedRun(db, "run-failed-close-check", "demo");
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-failed-close-check",
        title: "Failed close check",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.recordCloseCheck({
        goalId: "goal-failed-close-check",
        conditionId: "typecheck",
        status: "failed",
        checkedBy: "test",
      });
    });
    const config = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["demo"],
      allowedOperations: ["run.start", "rerun.start"],
    };
    const s = server(root, config);

    const run = await callTool(s, "harness.run.start", {
      projectId: "demo",
      domain: "apps/web",
      goal: "Fix failed close check",
      goalId: "goal-failed-close-check",
      idempotencyKey: "goal-failed-close-check-run",
    });
    expect(run.status).toBe("error");
    expect(run.summary).toContain("no project profile");

    const rerun = await callTool(s, "harness.rerun.start", {
      runId: "run-failed-close-check",
      goalId: "goal-failed-close-check",
      idempotencyKey: "goal-failed-close-check-rerun",
    });
    expect(rerun.status).toBe("error");
    expect(rerun.summary).toContain("source-mode conflict");
  });

  it("rejects goal-linked review.process and does not create confirmation when convergence needs a fix", async () => {
    const root = freshRoot((db, harnessRoot) => {
      seedReviewableRun(db, harnessRoot, {
        runId: "run-needs-fix-review-process",
        projectId: "demo",
      });
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-needs-fix-review-process",
        title: "Needs fix review process",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.upsertFinding({
        goalId: "goal-needs-fix-review-process",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Must fix before processing review",
      });
    });
    const result = await callTool(
      server(root, {
        ...DEFAULT_MCP_CONFIG,
        defaultMode: "guarded-mutation",
        allowedProjects: ["demo"],
        allowedOperations: ["review.process"],
      }),
      "harness.review.process",
      {
        runId: "run-needs-fix-review-process",
        decision: "approved",
        goalId: "goal-needs-fix-review-process",
        idempotencyKey: "goal-needs-fix-review-process",
      },
    );

    expect(result.status).toBe("permission_denied");
    expect(result.data.reason).toBe(
      "goal_needs_fix_fix_findings_disallows_review_process",
    );
    expect(
      readDb(
        root,
        (db) =>
          (
            db
              .prepare("SELECT count(*) AS n FROM mcp_confirmation_requests")
              .get() as { n: number }
          ).n,
      ),
    ).toBe(0);
  });

  it("processes goal-linked review proposals into close_ready via review.process", async () => {
    const root = freshRoot((db, harnessRoot) => {
      seedReviewableRun(db, harnessRoot, {
        runId: "run-goal-review-process-close",
        projectId: "demo",
      });
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "goal-review-process-close",
        title: "Review process close",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [
          { id: "review-consensus", kind: "review_consensus", required: true },
        ],
        createdBy: "test",
        createdSource: "mcp",
      });
      // a coding pass has already run; the goal awaits review consensus.
      repo.createAttempt({
        goalId: "goal-review-process-close",
        attemptType: "implement",
      });
    });
    const s = server(root, {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["demo"],
      allowedOperations: ["review.process"],
    });
    const pending = await callTool(s, "harness.review.process", {
      runId: "run-goal-review-process-close",
      decision: "approved",
      goalId: "goal-review-process-close",
      idempotencyKey: "goal-review-process-close",
    });

    expect(pending.status).toBe("confirmation_required");
    expect(pending.data.preview.data.goalId).toBe("goal-review-process-close");

    const confirmed = await confirmMcpRequest({
      harnessRoot: root,
      confirmationId: pending.confirmationId,
      confirmedBy: "human",
    });
    expect(confirmed.status).toBe("operation_started");
    expect(confirmed.data.result.goalIntegration.convergenceDecision.decision).toBe(
      "close_ready",
    );

    expect(
      readDb(
        root,
        (db) =>
          (
            db
              .prepare("SELECT status FROM goal_sessions WHERE goal_id = ?")
              .get("goal-review-process-close") as { status: string }
          ).status,
      ),
    ).toBe("close_ready");
  });

  it("rejects project reruns when the refreshed project repo attribution changed", async () => {
    const root = freshRoot((db, harnessRoot) => {
      const oldRepo = join(harnessRoot, "repo-old");
      const newRepo = join(harnessRoot, "repo-new");
      mkdirSync(join(oldRepo, "apps", "web"), { recursive: true });
      mkdirSync(join(newRepo, "apps", "web"), { recursive: true });
      writeFileSync(join(oldRepo, "package.json"), '{"name":"repo-old"}\n');
      writeFileSync(join(newRepo, "package.json"), '{"name":"repo-new"}\n');
      mkdirSync(join(harnessRoot, "templates", "policy"), { recursive: true });
      writeFileSync(
        join(harnessRoot, "templates", "policy", "strict-monorepo-v1.yaml"),
        [
          "version: 1",
          "template_id: strict-monorepo-v1",
          "domain_defaults:",
          "  app:",
          "    read: ['{root}/**']",
          "    write: ['{root}/**']",
          "    deny_write: []",
          "",
        ].join("\n"),
      );
      mkdirSync(join(harnessRoot, "projects"), { recursive: true });
      writeFileSync(
        join(harnessRoot, "projects", "demo.yaml"),
        [
          "version: 1",
          "project_id: demo",
          "repo:",
          "  id: demo-repo-new",
          `  path: ${JSON.stringify(newRepo)}`,
          "policy:",
          "  template: strict-monorepo-v1",
          "domains:",
          "  - id: apps/web",
          "    root: apps/web",
          "    kind: app",
          "",
        ].join("\n"),
      );
      new GoalRepository(db).createSession({
        goalId: "goal-rerun-repo",
        title: "Goal rerun repo",
        projectId: "demo",
        repoId: "demo-repo",
        domain: "apps/web",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      new GoalRepository(db).upsertFinding({
        goalId: "goal-rerun-repo",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Needs fix before rerun repo drift check",
      });
      const yaml = reviewDecisionYaml({
        runId: "run-rerun-repo",
        decision: "changes_requested",
        requiredChanges: ["fix the reviewed issue"],
      });
      const meta = {
        runId: "run-rerun-repo",
        repoId: "demo-repo",
        repoPath: oldRepo,
        domain: "apps/web",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "sha",
        runBranch: "harness/run-rerun-repo",
        status: "changes_requested",
        safetyStatus: "clean",
        startedAt: "2026-05-25T00:00:00Z",
        project: { projectId: "demo" },
      };
      db.prepare(
        `INSERT INTO runs
           (run_id, repo_id, project_id, repo_path, domain, workflow,
            base_branch, run_branch, status, safety_status, started_at,
            source_meta_sha256, updated_at, source_mode, db_revision, meta_json)
         VALUES
           ('run-rerun-repo', 'demo-repo', 'demo', ?, 'apps/web',
            'domain-coding', 'main', 'harness/run-rerun-repo',
            'changes_requested', 'clean', '2026-05-25T00:00:00Z',
            'sha', '2026-05-25T00:00:00Z', 'db-first', 1, ?)`,
      ).run(oldRepo, JSON.stringify(meta));
      db.prepare(
        `INSERT INTO review_decisions
           (run_id, decision, reviewer, summary, reviewed_at, source_yaml,
            source_sha256)
         VALUES
           ('run-rerun-repo', 'changes_requested', 'reviewer', 'needs work',
            '2026-05-25T01:00:00Z', ?, ?)`,
      ).run(yaml, sha256Text(yaml));
    });
    const config: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["demo"],
      allowedOperations: ["rerun.start"],
    };
    const result = await callTool(server(root, config), "harness.rerun.start", {
      runId: "run-rerun-repo",
      goalId: "goal-rerun-repo",
      idempotencyKey: "rerun-repo-mismatch",
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("rerun repo attribution drift");
  });

  it("rejects project rerun repo attribution drift without relying on a goal link", async () => {
    const root = freshRoot((db, harnessRoot) => {
      const oldRepo = join(harnessRoot, "repo-old");
      const newRepo = join(harnessRoot, "repo-new");
      mkdirSync(join(oldRepo, "apps", "web"), { recursive: true });
      mkdirSync(join(newRepo, "apps", "web"), { recursive: true });
      writeFileSync(join(oldRepo, "package.json"), '{"name":"repo-old"}\n');
      writeFileSync(join(newRepo, "package.json"), '{"name":"repo-new"}\n');
      mkdirSync(join(harnessRoot, "templates", "policy"), { recursive: true });
      writeFileSync(
        join(harnessRoot, "templates", "policy", "strict-monorepo-v1.yaml"),
        [
          "version: 1",
          "template_id: strict-monorepo-v1",
          "domain_defaults:",
          "  app:",
          "    read: ['{root}/**']",
          "    write: ['{root}/**']",
          "    deny_write: []",
          "",
        ].join("\n"),
      );
      mkdirSync(join(harnessRoot, "projects"), { recursive: true });
      writeFileSync(
        join(harnessRoot, "projects", "demo.yaml"),
        [
          "version: 1",
          "project_id: demo",
          "repo:",
          "  id: demo-repo-new",
          `  path: ${JSON.stringify(newRepo)}`,
          "policy:",
          "  template: strict-monorepo-v1",
          "domains:",
          "  - id: apps/web",
          "    root: apps/web",
          "    kind: app",
          "",
        ].join("\n"),
      );
      const yaml = reviewDecisionYaml({
        runId: "run-rerun-repo",
        decision: "changes_requested",
        requiredChanges: ["fix the reviewed issue"],
      });
      const meta = {
        runId: "run-rerun-repo",
        repoId: "demo-repo",
        repoPath: oldRepo,
        domain: "apps/web",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "sha",
        runBranch: "harness/run-rerun-repo",
        status: "changes_requested",
        safetyStatus: "clean",
        startedAt: "2026-05-25T00:00:00Z",
        project: { projectId: "demo" },
      };
      db.prepare(
        `INSERT INTO runs
           (run_id, repo_id, project_id, repo_path, domain, workflow,
            base_branch, run_branch, status, safety_status, started_at,
            source_meta_sha256, updated_at, source_mode, db_revision, meta_json)
         VALUES
           ('run-rerun-repo', 'demo-repo', 'demo', ?, 'apps/web',
            'domain-coding', 'main', 'harness/run-rerun-repo',
            'changes_requested', 'clean', '2026-05-25T00:00:00Z',
            'sha', '2026-05-25T00:00:00Z', 'db-first', 1, ?)`,
      ).run(oldRepo, JSON.stringify(meta));
      db.prepare(
        `INSERT INTO review_decisions
           (run_id, decision, reviewer, summary, reviewed_at, source_yaml,
            source_sha256)
         VALUES
           ('run-rerun-repo', 'changes_requested', 'reviewer', 'needs work',
            '2026-05-25T01:00:00Z', ?, ?)`,
      ).run(yaml, sha256Text(yaml));
    });
    const config: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["demo"],
      allowedOperations: ["rerun.start"],
    };
    const result = await callTool(server(root, config), "harness.rerun.start", {
      runId: "run-rerun-repo",
      idempotencyKey: "rerun-repo-mismatch-no-goal",
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("rerun repo attribution drift");
  });

  it("confirms with the permission snapshot captured when the preview was created", async () => {
    const root = freshRoot((db) => {
      seedProject(db, "demo");
      seedProject(db, "other");
      seedRun(db, "run-demo", "demo");
      db.prepare(
        `INSERT INTO domain_locks
           (domain_key, repo_id, domain, holder_run_id, holder_pid,
            holder_hostname, acquired_at, expires_at, heartbeat_at)
         VALUES
           ('demo-repo::apps/web', 'demo-repo', 'apps/web', 'run-demo',
            123, 'host', '2026-05-25T00:00:00Z', '2020-01-01T00:00:00Z',
            '2026-05-25T00:00:00Z')`,
      ).run();
      const lock = db.prepare("SELECT lock_id FROM domain_locks").get() as { lock_id: number };
      db.prepare(
        `INSERT INTO doctor_runs
           (doctor_run_id, started_at, completed_at, status, summary_json)
         VALUES ('doctor-1', '2026-05-25T00:00:00Z',
                 '2026-05-25T00:00:00Z', 'warn', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO doctor_findings
           (doctor_run_id, check_id, severity, status, message, repairable,
            details_json)
         VALUES ('doctor-1', 'lock.expired_active', 'warn', 'flagged',
                 'expired lock', 1, ?)`,
      ).run(JSON.stringify({ lock_id: lock.lock_id, run_id: "run-demo" }));
    });
    const config: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      allowedProjects: ["demo"],
    };
    const pending = await callTool(server(root, config), "harness.db.repair.apply", {
      findingId: 1,
      idempotencyKey: "repair-snapshot-1",
    });
    expect(pending.status).toBe("confirmation_required");

    readDb(root, (db) =>
      db.prepare("UPDATE runs SET project_id = 'other' WHERE run_id = 'run-demo'").run(),
    );
    const confirmed = await confirmMcpRequest({
      harnessRoot: root,
      confirmationId: pending.confirmationId,
      confirmedBy: "human",
    });
    expect(confirmed.status).toBe("error");
    expect(confirmed.summary).toContain("project_not_allowed");
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT count(*) AS n FROM repair_actions WHERE dry_run = 0").get() as { n: number }).n,
      ),
    ).toBe(0);
    const snapshot = readDb(root, (db) =>
      (db
        .prepare("SELECT permission_snapshot_json FROM mcp_confirmation_requests WHERE confirmation_id = ?")
        .get(pending.confirmationId) as { permission_snapshot_json: string }).permission_snapshot_json,
    );
    expect(JSON.parse(snapshot).allowedProjects).toEqual(["demo"]);
  });

  it("processes MCP review decisions through the proposal-bound path and rejects stale proposals", async () => {
    const root = freshRoot((db, harnessRoot) => {
      seedProject(db);
      seedReviewableRun(db, harnessRoot, { runId: "run-review-bound" });
    });
    const proposal = readDb(root, (db) =>
      db
        .prepare("SELECT proposal_id, source_sha256 FROM review_proposals WHERE run_id = ?")
        .get("run-review-bound") as { proposal_id: number; source_sha256: string },
    );
    const s = server(root, DEFAULT_MCP_CONFIG);
    const pending = await callTool(s, "harness.review.process", {
      runId: "run-review-bound",
      decision: "approved",
      idempotencyKey: "review-bound-1",
    });

    expect(pending.status).toBe("confirmation_required");
    expect(pending.data.preview.data.proposal).toMatchObject({
      proposalId: proposal.proposal_id,
      sourceSha256: proposal.source_sha256,
    });
    const storedInput = readDb(root, (db) =>
      JSON.parse(
        (db
          .prepare("SELECT input_json FROM mcp_confirmation_requests WHERE confirmation_id = ?")
          .get(pending.confirmationId) as { input_json: string }).input_json,
      ) as { proposalId: number; sourceSha256: string },
    );
    expect(storedInput.proposalId).toBe(proposal.proposal_id);
    expect(storedInput.sourceSha256).toBe(proposal.source_sha256);

    const confirmed = await confirmMcpRequest({
      harnessRoot: root,
      confirmationId: pending.confirmationId,
      confirmedBy: "human",
    });
    expect(confirmed.status).toBe("operation_started");
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT status FROM runs WHERE run_id = ?").get("run-review-bound") as { status: string }).status,
      ),
    ).toBe("approved");
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT count(*) AS n FROM review_overrides").get() as { n: number }).n,
      ),
    ).toBe(0);

    const staleRoot = freshRoot((db, harnessRoot) => {
      seedProject(db);
      seedReviewableRun(db, harnessRoot, { runId: "run-review-stale" });
    });
    const staleServer = server(staleRoot, DEFAULT_MCP_CONFIG);
    const stalePending = await callTool(staleServer, "harness.review.process", {
      runId: "run-review-stale",
      decision: "approved",
      idempotencyKey: "review-stale-1",
    });
    readDb(staleRoot, (db) =>
      db
        .prepare(
          `UPDATE review_proposals
              SET superseded_at = '2026-05-25T02:00:00Z',
                  lifecycle_status = 'superseded'
            WHERE run_id = ?`,
        )
        .run("run-review-stale"),
    );
	    const staleConfirm = await confirmMcpRequest({
	      harnessRoot: staleRoot,
	      confirmationId: stalePending.confirmationId,
	      confirmedBy: "human",
	    });
	    expect(staleConfirm.status).toBe("error");
	    expect(staleConfirm.summary).toContain("superseded");
	    expect(
	      readDb(staleRoot, (db) =>
	        (db.prepare("SELECT status FROM runs WHERE run_id = ?").get("run-review-stale") as { status: string }).status,
	      ),
	    ).toBe("needs_review");

	    const newerRoot = freshRoot((db, harnessRoot) => {
	      seedProject(db);
	      seedReviewableRun(db, harnessRoot, { runId: "run-review-newer-active" });
	    });
	    const newerServer = server(newerRoot, DEFAULT_MCP_CONFIG);
	    const newerPending = await callTool(newerServer, "harness.review.process", {
	      runId: "run-review-newer-active",
	      decision: "approved",
	      idempotencyKey: "review-newer-active-1",
	    });
	    readDb(newerRoot, (db) => {
	      const yaml = reviewDecisionYaml({
	        runId: "run-review-newer-active",
	        reviewer: "human-reviewer",
	      });
	      db.prepare(
	        `INSERT INTO review_proposals
	           (run_id, reviewer, decision, required_changes_json,
	            non_blocking_comments_json, out_of_scope_suggestions_json,
	            reviewed_at, source_yaml, source_sha256, created_at)
	         VALUES (?, 'human-reviewer', 'approved', '[]', '[]', '[]',
	                 '2026-05-25T01:30:00Z', ?, ?, '2026-05-25T01:30:00Z')`,
	      ).run("run-review-newer-active", yaml, sha256Text(yaml));
	    });
	    const newerConfirm = await confirmMcpRequest({
	      harnessRoot: newerRoot,
	      confirmationId: newerPending.confirmationId,
	      confirmedBy: "human",
	    });
	    expect(newerConfirm.status).toBe("error");
	    expect(newerConfirm.summary).toContain("latest active proposal");
	    expect(
	      readDb(newerRoot, (db) =>
	        (db
	          .prepare("SELECT status FROM runs WHERE run_id = ?")
	          .get("run-review-newer-active") as { status: string }).status,
	      ),
	    ).toBe("needs_review");

	    const competingRoot = freshRoot((db, harnessRoot) => {
	      seedProject(db);
	      seedReviewableRun(db, harnessRoot, { runId: "run-review-competing" });
	    });
	    const competingServer = server(competingRoot, DEFAULT_MCP_CONFIG);
	    const competingPending = await callTool(competingServer, "harness.review.process", {
	      runId: "run-review-competing",
	      decision: "approved",
	      idempotencyKey: "review-competing-1",
	    });
	    const humanProposal = readDb(competingRoot, (db) => {
	      const yaml = reviewDecisionYaml({
	        runId: "run-review-competing",
	        reviewer: "human-reviewer",
	      });
	      db.prepare(
	        `INSERT INTO review_proposals
	           (run_id, reviewer, decision, required_changes_json,
	            non_blocking_comments_json, out_of_scope_suggestions_json,
	            reviewed_at, source_yaml, source_sha256, created_at)
	         VALUES (?, 'human-reviewer', 'approved', '[]', '[]', '[]',
	                 '2026-05-25T01:30:00Z', ?, ?, '2026-05-25T01:30:00Z')`,
	      ).run("run-review-competing", yaml, sha256Text(yaml));
	      return db
	        .prepare(
	          "SELECT proposal_id, source_sha256 FROM review_proposals WHERE run_id = ? AND reviewer = 'human-reviewer'",
	        )
	        .get("run-review-competing") as { proposal_id: number; source_sha256: string };
	    });
	    await processReviewDecision({
	      runsDir: join(competingRoot, "runs"),
	      locksDir: join(competingRoot, "runs"),
	      dbPath: join(competingRoot, ".harness", "harness.sqlite"),
	      runId: "run-review-competing",
	      proposalId: humanProposal.proposal_id,
	      sourceSha256: humanProposal.source_sha256,
	    });
	    const competingConfirm = await confirmMcpRequest({
	      harnessRoot: competingRoot,
	      confirmationId: competingPending.confirmationId,
	      confirmedBy: "human",
	    });
	    expect(competingConfirm.status).toBe("error");
	    expect(competingConfirm.summary).toContain("only needs_review can be processed");
	  });

  it("keeps pr.create preview and confirmed execution on the run base branch", async () => {
    const root = freshRoot((db) => {
      seedProject(db);
      seedRun(db, "run-pr-develop", "demo");
      db.prepare("UPDATE runs SET base_branch = 'develop' WHERE run_id = ?").run("run-pr-develop");
    });
    const s = server(root, DEFAULT_MCP_CONFIG);
    const pending = await callTool(s, "harness.pr.create", {
      runId: "run-pr-develop",
      idempotencyKey: "pr-develop-1",
    });

    expect(pending.status).toBe("confirmation_required");
    expect(pending.data.preview.data.plannedPullRequest).toMatchObject({
      baseBranch: "develop",
      draft: true,
    });

	    readDb(root, (db) =>
	      db.prepare("UPDATE runs SET base_branch = 'release/1' WHERE run_id = ?").run("run-pr-develop"),
	    );
	    const stale = await confirmMcpRequest({
	      harnessRoot: root,
	      confirmationId: pending.confirmationId,
	      confirmedBy: "human",
	    });
	    expect(stale.status).toBe("error");
	    expect(stale.summary).toContain("base branch changed");

	    const failedRoot = freshRoot((db) => {
	      seedProject(db);
	      seedRun(db, "run-pr-failed-retry", "demo");
	      db.prepare("UPDATE runs SET base_branch = 'develop' WHERE run_id = ?").run(
	        "run-pr-failed-retry",
	      );
	      db.prepare(
	        `INSERT INTO pull_requests
	           (run_id, provider, repo, branch, base_branch, title, url,
	            external_pr_id, status, operation_id, created_at, updated_at)
	         VALUES
	           ('run-pr-failed-retry', 'git', 'demo-repo',
	            'harness/run-pr-failed-retry', 'develop', 'old', NULL,
	            NULL, 'failed', 'op-old', '2026-05-25T00:00:00Z',
	            '2026-05-25T00:00:00Z')`,
	      ).run();
	    });
	    const failedPending = await callTool(server(failedRoot, DEFAULT_MCP_CONFIG), "harness.pr.create", {
	      runId: "run-pr-failed-retry",
	      idempotencyKey: "pr-failed-retry-1",
	    });
	    expect(failedPending.status).toBe("confirmation_required");
	    expect(failedPending.data.preview.data.plannedPullRequest).toMatchObject({
	      baseBranch: "develop",
	      draft: true,
	    });
	    readDb(failedRoot, (db) =>
	      db.prepare("UPDATE runs SET base_branch = 'release/2' WHERE run_id = ?").run(
	        "run-pr-failed-retry",
	      ),
	    );
	    const failedStale = await confirmMcpRequest({
	      harnessRoot: failedRoot,
	      confirmationId: failedPending.confirmationId,
	      confirmedBy: "human",
	    });
	    expect(failedStale.status).toBe("error");
	    expect(failedStale.summary).toContain("base branch changed");
	  });

  it("requires global MCP scope for db.archive.apply", async () => {
    const root = freshRoot((db) => {
      seedProject(db);
      seedRun(db, "run-archive-scope", "demo");
    });
    const scoped: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      allowedProjects: ["demo"],
    };
    const denied = await callTool(server(root, scoped), "harness.db.archive.apply", {
      before: "2026-05-25T00:00:00Z",
      idempotencyKey: "archive-scoped-1",
    });
    expect(denied.status).toBe("permission_denied");
    expect(denied.data.reason).toBe("global_scope_required");

    const global = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.db.archive.apply", {
      before: "2026-05-25T00:00:00Z",
      idempotencyKey: "archive-global-1",
    });
    expect(global.status).toBe("confirmation_required");
  });

  it("binds db.archive.apply confirmation preview to the exact full DB copy target", async () => {
    const root = freshRoot((db) => {
      seedProject(db);
      seedRun(db, "run-archive-preview", "demo");
    });
    const pending = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.db.archive.apply", {
      before: "2026-05-25T00:00:00Z",
      out: "manual/full-db.sqlite",
      idempotencyKey: "archive-preview-1",
    });
    expect(pending.status).toBe("confirmation_required");
    const preview = pending.data.preview;
    expect(preview.data.operation).toBe("db-archive-copy");
    expect(preview.data.mode).toBe("copy-only-full-db");
    expect(preview.data.before).toBe("2026-05-25T00:00:00Z");
    expect(preview.data.beforeIsMetadataOnly).toBe(true);
    expect(preview.data.willCopyFullDb).toBe(true);
    expect(preview.data.candidateRunsAreInformational).toBe(true);
    expect(preview.data.outPath).toBe(
      join(root, ".harness", "archives", "manual", "full-db.sqlite"),
    );
    expect(preview.warnings.join("\n")).toContain("before is archive metadata rangeEnd");

    const stored = getMcpConfirmationRequest(root, pending.confirmationId);
    expect(JSON.parse(stored!.inputJson).out).toBe(preview.data.outPath);
  });

  it("rejects db.archive.apply out paths outside .harness/archives", async () => {
    const root = freshRoot();
    const denied = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.db.archive.apply", {
      before: "2026-05-25T00:00:00Z",
      out: join(tmpdir(), "outside-archive.sqlite"),
      idempotencyKey: "archive-outside-1",
    });
    expect(denied.status).toBe("permission_denied");
    expect(denied.data.reason).toBe("archive_outside_harness_archives");
  });

  it("rejects stale db.archive.apply confirmations when stored input and preview outPath diverge", async () => {
    const root = freshRoot();
    const pending = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.db.archive.apply", {
      before: "2026-05-25T00:00:00Z",
      out: "bound.sqlite",
      idempotencyKey: "archive-stale-1",
    });
    expect(pending.status).toBe("confirmation_required");

    readDb(root, (db) => {
      const stored = JSON.parse(
        (db
          .prepare("SELECT input_json FROM mcp_confirmation_requests WHERE confirmation_id = ?")
          .get(pending.confirmationId) as { input_json: string }).input_json,
      );
      db.prepare(
        `UPDATE mcp_confirmation_requests
            SET input_json = ?
          WHERE confirmation_id = ?`,
      ).run(
        JSON.stringify({
          ...stored,
          out: join(root, ".harness", "archives", "changed.sqlite"),
        }),
        pending.confirmationId,
      );
    });

    const confirmed = await confirmMcpRequest({
      harnessRoot: root,
      confirmationId: pending.confirmationId,
      confirmedBy: "human",
    });
    expect(confirmed.status).toBe("error");
    expect(confirmed.summary).toContain("outPath changed");
  });

  it("requires global MCP scope for db.gc_blobs.apply", async () => {
    const root = freshRoot((db) => {
      seedProject(db);
    });
    const scoped: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      allowedProjects: ["demo"],
    };
    const preview = await callTool(server(root, scoped), "harness.db.gc_blobs.preview", {});
    expect(preview.status).toBe("dry_run");
    expect(preview.nextActions).toEqual([]);
    expect(preview.warnings.join("\n")).toContain("global maintenance operation");

    const denied = await callTool(server(root, scoped), "harness.db.gc_blobs.apply", {
      idempotencyKey: "gc-scoped-1",
    });
    expect(denied.status).toBe("permission_denied");
    expect(denied.data.reason).toBe("global_scope_required");

    const global = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.db.gc_blobs.apply", {
      idempotencyKey: "gc-global-1",
    });
    expect(global.status).toBe("confirmation_required");
  });

  it("consumes confirmations with a redacted error when a handler throws", async () => {
    const root = freshRoot((db) => {
      seedProject(db);
      seedRun(db, "run-throw-confirm", "demo");
    });
    const s = server(root, DEFAULT_MCP_CONFIG);
    const pending = await callTool(s, "harness.pr.create", {
      runId: "run-throw-confirm",
      idempotencyKey: "throw-confirm-1",
    });
    expect(pending.status).toBe("confirmation_required");

    const tool = MCP_TOOL_DEFINITIONS.find((candidate) => candidate.name === "harness.pr.create");
    if (tool === undefined) throw new Error("harness.pr.create missing");
    const original = tool.handler;
    tool.handler = (() => {
      throw new Error("token=super-secret");
    }) as typeof tool.handler;
    try {
      const result = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: pending.confirmationId,
        confirmedBy: "human",
	      });
	      expect(result.status).toBe("error");
	      expect(result.summary).toBe("[redacted]");
	      expect(result.summary).not.toContain("super-secret");
	      const row = readDb(root, (db) =>
        db
          .prepare("SELECT status, error_message FROM mcp_confirmation_requests WHERE confirmation_id = ?")
          .get(pending.confirmationId) as { status: string; error_message: string },
      );
      expect(row.status).toBe("consumed");
      expect(row.error_message).toBe("[redacted]");
      const second = await confirmMcpRequest({
        harnessRoot: root,
        confirmationId: pending.confirmationId,
        confirmedBy: "human",
      });
      expect(second.status).toBe("error");
      expect(second.summary).toContain("consumed");
    } finally {
      tool.handler = original;
    }
  });

    it("creates, rejects, expires, and consumes confirmation requests", async () => {
    const root = freshRoot((db) => {
      db.prepare(
        `INSERT INTO runs
           (run_id, repo_id, project_id, repo_path, domain, workflow,
            base_branch, run_branch, status, safety_status, started_at,
            source_meta_sha256, updated_at, meta_json)
         VALUES
           ('run-demo', 'demo-repo', 'demo', '/tmp/demo', 'apps/web',
            'domain-coding', 'main', 'harness/run-demo', 'approved', 'clean',
            '2026-05-25T00:00:00Z', 'sha', '2026-05-25T00:00:00Z', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO domain_locks
           (domain_key, repo_id, domain, holder_run_id, holder_pid,
            holder_hostname, acquired_at, expires_at, heartbeat_at)
         VALUES
           ('demo-repo::apps/web', 'demo-repo', 'apps/web', 'run-demo',
            123, 'host', '2026-05-25T00:00:00Z', '2020-01-01T00:00:00Z',
            '2026-05-25T00:00:00Z')`,
      ).run();
      const lock = db.prepare("SELECT lock_id FROM domain_locks").get() as { lock_id: number };
      db.prepare(
        `INSERT INTO doctor_runs
           (doctor_run_id, started_at, completed_at, status, summary_json)
         VALUES ('doctor-1', '2026-05-25T00:00:00Z',
                 '2026-05-25T00:00:00Z', 'warn', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO doctor_findings
           (doctor_run_id, check_id, severity, status, message, repairable,
            details_json)
         VALUES ('doctor-1', 'lock.expired_active', 'warn', 'flagged',
                 'expired lock', 1, ?)`,
      ).run(JSON.stringify({ lock_id: lock.lock_id, run_id: "run-demo" }));
    });

    const s = server(root, DEFAULT_MCP_CONFIG);
    await s.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "unit-test" } },
    });
    const repair = await callTool(s, "harness.db.repair.apply", {
      findingId: 1,
      idempotencyKey: "repair-1",
    });
    expect(repair.status).toBe("confirmation_required");
    expect(repair.confirmationId).toMatch(/^mcpconf-/);
    expect(repair.data.preview.data.findingId).toBe(1);
    expect(repair.data.preview.data.repair.result.lockId).toBeGreaterThan(0);

    const confirmed = await confirmMcpRequest({
      harnessRoot: root,
      confirmationId: repair.confirmationId,
      confirmedBy: "human",
    });
    expect(confirmed.status).toBe("operation_started");
    expect(confirmed.operationId).toMatch(/^op-/);
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT status, consumed_operation_id FROM mcp_confirmation_requests WHERE confirmation_id = ?")
          .get(repair.confirmationId) as any),
      ),
    ).toMatchObject({
      status: "consumed",
      consumed_operation_id: confirmed.operationId,
    });
    expect(readDb(root, (db) => (db.prepare("SELECT count(*) AS n FROM repair_actions WHERE dry_run = 0").get() as { n: number }).n)).toBe(1);
    const secondConfirm = await confirmMcpRequest({
      harnessRoot: root,
      confirmationId: repair.confirmationId,
      confirmedBy: "human",
    });
    expect(secondConfirm.status).toBe("error");

    const rejectable = await callTool(s, "harness.pr.create", {
      runId: "run-demo",
      idempotencyKey: "pr-1",
    });
    expect(rejectable.status).toBe("confirmation_required");
    const rejected = rejectMcpRequest({
      harnessRoot: root,
      confirmationId: rejectable.confirmationId,
      confirmedBy: "human",
    });
    expect(rejected.status).toBe("rejected");
    const rejectedConfirm = await confirmMcpRequest({
      harnessRoot: root,
      confirmationId: rejectable.confirmationId,
      confirmedBy: "human",
    });
    expect(rejectedConfirm.status).toBe("error");

    const expiring = await callTool(s, "harness.pr.create", {
      runId: "run-demo",
      idempotencyKey: "pr-2",
    });
    readDb(root, (db) =>
      db
        .prepare("UPDATE mcp_confirmation_requests SET expires_at = '2000-01-01T00:00:00Z' WHERE confirmation_id = ?")
        .run(expiring.confirmationId),
    );
    const expired = await confirmMcpRequest({
      harnessRoot: root,
      confirmationId: expiring.confirmationId,
      confirmedBy: "human",
    });
    expect(expired.status).toBe("error");
    expect(readDb(root, (db) => (db.prepare("SELECT status FROM mcp_confirmation_requests WHERE confirmation_id = ?").get(expiring.confirmationId) as any).status)).toBe("expired");
  });

  it("audits dry-runs by default and keeps read tools unaudited unless enabled", async () => {
    const root = freshRoot();
    const s = server(root, DEFAULT_MCP_CONFIG);
    await s.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "unit-test" } },
    });
    await callTool(s, "harness.db.status");
    await callTool(s, "harness.db.repair.dry_run", { limit: 5 });
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT tool_name FROM mcp_tool_invocations ORDER BY started_at").all() as any[])
          .map((r) => r.tool_name),
      ),
    ).toEqual(["harness.db.repair.dry_run"]);
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT session_id, client_name, ended_at FROM mcp_sessions").get() as any),
      ),
    ).toMatchObject({
      session_id: "mcpsess_mut",
      client_name: "unit-test",
      ended_at: null,
    });
    s.close();
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT ended_at FROM mcp_sessions WHERE session_id = 'mcpsess_mut'").get() as any)
          .ended_at,
      ),
    ).not.toBeNull();

    const readAuditServer = server(root, {
      ...DEFAULT_MCP_CONFIG,
      audit: { ...DEFAULT_MCP_CONFIG.audit, recordReadTools: true },
    });
    await callTool(readAuditServer, "harness.db.status");
    expect(
      readDb(root, (db) =>
        (db.prepare("SELECT count(*) AS n FROM mcp_tool_invocations WHERE tool_name = 'harness.db.status'").get() as { n: number }).n,
      ),
    ).toBe(1);
  });
});
