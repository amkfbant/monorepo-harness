import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { storeArtifactBlob } from "../../../src/db/artifact-blobs.js";
import { recordProjectProfileRevision } from "../../../src/db/repositories/project-profile-revisions.js";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../../src/mcp/security/config.js";

function freshHarness(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-resources-"));
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
    sessionId: "mcpsess_resources",
  });
}

async function readResource(
  s: HarnessMcpServer,
  uri: string,
): Promise<Record<string, any>> {
  const response = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri },
  })) as any;
  return JSON.parse(response.result.contents[0].text) as Record<string, any>;
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
  recordProjectProfileRevision(db, {
    projectId: "demo",
    bodyYaml: "id: demo\ndomains:\n  - apps/web\n",
    parsed: { id: "demo", domains: ["apps/web"] },
    actor: "test",
    now: new Date("2026-05-25T00:01:00Z"),
  });
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
       ('run-demo', 'demo-repo', 'demo', 'apps/web', 'domain-coding',
        'main', 'needs_review', 'clean', '2026-05-25T02:00:00Z', 's1',
        '2026-05-25T02:00:00Z', '{}'),
       ('run-other', 'other-repo', 'other', 'apps/web', 'domain-coding',
        'main', 'approved', 'clean', '2026-05-25T03:00:00Z', 's2',
        '2026-05-25T03:00:00Z', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
     VALUES ('run-demo', 1, 'run_started', '2026-05-25T02:00:00Z',
             '{"type":"run_started"}')`,
  ).run();
  const logBlob = storeArtifactBlob(db, Buffer.from("resource log body"));
  const secretBlob = storeArtifactBlob(db, Buffer.from("secret body"));
  db.prepare(
    `INSERT INTO artifacts
       (artifact_id, run_id, kind, relative_path, content_type, bytes,
        sha256, storage, blob_sha256, body_status, created_at, redacted,
        secret_suspect)
     VALUES
       ('run-demo:logs/output.txt', 'run-demo', 'log', 'logs/output.txt',
        'text/plain', ?, ?, 'db', ?, 'db_available',
        '2026-05-25T02:01:00Z', 0, 0),
       ('run-demo:secret.txt', 'run-demo', 'log', 'secret.txt',
        'text/plain', ?, ?, 'db', ?, 'db_available',
        '2026-05-25T02:02:00Z', 0, 1)`,
  ).run(
    logBlob.bytes,
    logBlob.sha256,
    logBlob.sha256,
    secretBlob.bytes,
    secretBlob.sha256,
    secretBlob.sha256,
  );
  db.prepare(
    `INSERT INTO backlog_items
       (item_id, project_id, repo_id, domain, title, goal, status, priority,
        tags_json, created_at, updated_at)
     VALUES
       ('item-001', 'demo', 'demo-repo', 'apps/web', 'Fix UI',
        'Make UI work', 'open', 'medium', '[]',
        '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO knowledge_entries
       (entry_id, project_id, repo_id, domain, kind, path, title, body,
        frontmatter_json, created_at, source_candidate_id)
     VALUES
       ('knowledge/demo.md', 'demo', 'demo-repo', 'apps/web', 'note',
        'docs/knowledge/demo.md', 'Demo note', 'Body mentions filters',
        '{}', '2026-05-25T00:00:00Z', NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO effective_policy_snapshots
       (snapshot_id, project_id, repo_id, domain, generated_policy_yaml,
        generated_policy_sha256, provenance_json, created_at)
     VALUES
       (201, 'demo', 'demo-repo', 'apps/web', 'read:\\n  - apps/web/**\\n',
        'policy-sha', '{"source":"test"}', '2026-05-25T00:00:00Z')`,
  ).run();
}

describe("MCP resources and prompts", () => {
	  it("reads stable project, domain, policy, run, backlog, and knowledge resources", async () => {
	    const { root, db } = freshHarness();
	    try {
      const s = server(root);
      const project = await readResource(s, "harness://project/demo");
      expect(project.status).toBe("ok");
      expect(project.data.project.projectId).toBe("demo");

      const profile = await readResource(s, "harness://project/demo/profile");
      expect(profile.data.current.bodyYaml).toContain("apps/web");

      const domain = await readResource(
        s,
        `harness://project/demo/domain/${encodeURIComponent("apps/web")}`,
      );
      expect(domain.data.domain.domainId).toBe("apps/web");

      const policy = await readResource(
        s,
        "harness://project/demo/policy/effective",
      );
      expect(policy.data.snapshots[0].snapshotId).toBe(201);

      const timeline = await readResource(s, "harness://run/run-demo/timeline");
      expect(timeline.data.timeline[0].type).toBe("run_started");

      const backlog = await readResource(s, "harness://backlog/item-001");
      expect(backlog.data.item.title).toBe("Fix UI");

      const knowledge = await readResource(
        s,
        `harness://knowledge/${encodeURIComponent("knowledge/demo.md")}`,
      );
      expect(knowledge.data.entry.title).toBe("Demo note");
    } finally {
      db.close();
	    }
	  });

	  it("caps knowledge resource bodies through the resource path", async () => {
	    const { root, db } = freshHarness();
	    try {
	      db.prepare("UPDATE knowledge_entries SET body = ? WHERE entry_id = ?").run(
	        "abcdef",
	        "knowledge/demo.md",
	      );
	      const cfg: McpConfig = {
	        ...DEFAULT_MCP_CONFIG,
	        limits: {
	          ...DEFAULT_MCP_CONFIG.limits,
	          maxArtifactBytesPerToolResult: 3,
	        },
	        resources: {
	          ...DEFAULT_MCP_CONFIG.resources,
	          maxResourceBytes: 1_000,
	        },
	      };
	      const knowledge = await readResource(
	        server(root, cfg),
	        `harness://knowledge/${encodeURIComponent("knowledge/demo.md")}`,
	      );
	      expect(knowledge.status).toBe("ok");
	      expect(knowledge.data.entry.bodyPreview).toMatchObject({
	        omitted: true,
	        capped: true,
	        maxBytes: 3,
	        text: "abc",
	      });
	    } finally {
	      db.close();
	    }
	  });

	  it("applies artifact body mode, redaction, cap, and path safety", async () => {
    const { root, db } = freshHarness();
    try {
      const cfg: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        resources: {
          ...DEFAULT_MCP_CONFIG.resources,
          artifactBody: "full",
          maxResourceBytes: 2_000,
        },
      };
      const s = server(root, cfg);
      const artifact = await readResource(
        s,
        "harness://run/run-demo/artifact/logs/output.txt",
      );
      expect(artifact.status).toBe("ok");
      expect(artifact.data.body).toMatchObject({
        mode: "full",
        text: "resource log body",
        truncated: false,
      });

      const encodedArtifactId = Buffer.from("run-demo:secret.txt", "utf8").toString(
        "base64url",
      );
      const secret = await readResource(
        s,
        `harness://artifact/${encodedArtifactId}`,
      );
      expect(secret.data.body).toMatchObject({
        omitted: true,
        reason: "secret_suspect",
      });

      const unsafe = await readResource(
        s,
        "harness://run/run-demo/artifact/../secret.txt",
      );
      expect(unsafe.status).toBe("error");
    } finally {
      db.close();
    }
  });

  it("reads verified local external blob bodies through artifact resources", async () => {
    const { root, db } = freshHarness();
    try {
      const body = Buffer.from("external resource body");
      const sha = createHash("sha256").update(body).digest("hex");
      const storeRoot = join(root, "blob-store");
      const objectDir = join(storeRoot, "sha256", sha.slice(0, 2), sha.slice(2, 4));
      mkdirSync(objectDir, { recursive: true });
      writeFileSync(join(objectDir, sha), body);
      db.prepare(
        `INSERT INTO blob_stores
           (store_id, store_type, config_json, created_at, updated_at,
            status, metadata_json)
         VALUES ('local-main', 'local', ?, '2026-05-25T00:00:00Z',
                 '2026-05-25T00:00:00Z', 'active', '{}')`,
      ).run(JSON.stringify({ root: storeRoot }));
      db.prepare(
        `INSERT INTO external_artifact_blobs
           (sha256, store_id, uri, bytes, stored_bytes, content_encoding,
            chunking, uploaded_at, verified_at, status, metadata_json)
         VALUES (?, 'local-main', ?, ?, ?, 'identity', 'none',
                 '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z',
                 'available', '{}')`,
      ).run(sha, `file://${join(objectDir, sha)}`, body.length, body.length);
      db.prepare(
        `INSERT INTO artifacts
           (artifact_id, run_id, kind, relative_path, content_type, bytes,
            sha256, storage, blob_sha256, body_status, created_at, redacted,
            secret_suspect)
         VALUES ('run-demo:external.txt', 'run-demo', 'log', 'external.txt',
                 'text/plain', ?, ?, 'external', ?, 'external_available',
                 '2026-05-25T03:00:00Z', 0, 0)`,
      ).run(body.length, sha, sha);

      const cfg: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        resources: {
          ...DEFAULT_MCP_CONFIG.resources,
          artifactBody: "full",
          maxResourceBytes: 5_000,
        },
      };
      const artifact = await readResource(
        server(root, cfg),
        "harness://run/run-demo/artifact/external.txt",
      );
      expect(artifact.status).toBe("ok");
	      expect(artifact.data.body).toMatchObject({
	        mode: "full",
	        text: "external resource body",
	        truncated: false,
	      });
	      writeFileSync(join(objectDir, sha), Buffer.from("corrupt"));
	      const corrupt = await readResource(
	        server(root, cfg),
	        "harness://run/run-demo/artifact/external.txt",
	      );
	      expect(corrupt.status).toBe("ok");
	      expect(corrupt.data.body).toMatchObject({
	        mode: "full",
	        omitted: true,
	        reason: "blob_missing",
	      });
	      unlinkSync(join(objectDir, sha));
	      const missing = await readResource(
	        server(root, cfg),
	        "harness://run/run-demo/artifact/external.txt",
	      );
	      expect(missing.status).toBe("ok");
	      expect(missing.data.body).toMatchObject({
	        mode: "full",
	        omitted: true,
	        reason: "blob_missing",
	      });
	    } finally {
	      db.close();
	    }
  });

  it("enforces project allowlists for resources", async () => {
    const { root, db } = freshHarness();
    try {
      const cfg: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo"],
      };
      const blocked = await readResource(server(root, cfg), "harness://run/run-other");
      expect(blocked.status).toBe("permission_denied");
    } finally {
      db.close();
    }
  });

  it("returns project resource not-found only when the client may access that project id", async () => {
    const { root, db } = freshHarness();
    try {
      const scoped = server(root, {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo", "missing-allowed"],
      });
      const missingAllowedProfile = await readResource(
        scoped,
        "harness://project/missing-allowed/profile",
      );
      expect(missingAllowedProfile.status).toBe("error");
      expect(missingAllowedProfile.summary).toBe("project not found: missing-allowed");

      const missingUnrestrictedPolicy = await readResource(
        server(root),
        "harness://project/does-not-exist/policy/effective",
      );
      expect(missingUnrestrictedPolicy.status).toBe("error");
      expect(missingUnrestrictedPolicy.summary).toBe(
        "project not found: does-not-exist",
      );

      const deniedServer = server(root, {
        ...DEFAULT_MCP_CONFIG,
        allowedProjects: ["demo"],
      });
      const deniedExisting = await readResource(
        deniedServer,
        "harness://project/other/profile",
      );
      const deniedMissing = await readResource(
        deniedServer,
        "harness://project/does-not-exist/profile",
      );
      expect(deniedExisting.status).toBe("permission_denied");
      expect(deniedExisting.status).toBe(deniedMissing.status);
      expect(deniedExisting.summary).toBe(deniedMissing.summary);
      expect(deniedExisting.data.reason).toBe(deniedMissing.data.reason);

      const allowedExisting = await readResource(
        scoped,
        "harness://project/demo/profile",
      );
      expect(allowedExisting.status).toBe("ok");
      expect(allowedExisting.data.project.projectId).toBe("demo");
    } finally {
      db.close();
    }
  });

  it("enforces denied operations for composite resources", async () => {
    const { root, db } = freshHarness();
    try {
      const policyDenied: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        deniedOperations: [
          ...DEFAULT_MCP_CONFIG.deniedOperations,
          "policy.get_effective",
        ],
      };
      const policy = await readResource(
        server(root, policyDenied),
        "harness://project/demo/policy/effective",
      );
      expect(policy.status).toBe("permission_denied");
      expect(policy.data).toMatchObject({
        reason: "operation_denied",
        operation: "policy.get_effective",
      });

      const consensusDenied: McpConfig = {
        ...DEFAULT_MCP_CONFIG,
        deniedOperations: [
          ...DEFAULT_MCP_CONFIG.deniedOperations,
          "review.consensus",
        ],
      };
      const review = await readResource(
        server(root, consensusDenied),
        "harness://run/run-demo/review",
      );
      expect(review.status).toBe("permission_denied");
      expect(review.data).toMatchObject({
        reason: "operation_denied",
        operation: "review.consensus",
      });
    } finally {
      db.close();
    }
  });

  it("returns prompt messages with concrete resource URIs and validates required args", async () => {
    const { root, db } = freshHarness();
    try {
      const s = server(root);
      const prompt = (await s.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: {
          name: "harness.prompt.review_run",
          arguments: { runId: "run-demo", focus: "security" },
        },
      })) as any;
      expect(prompt.result.messages[0].content.text).toContain(
        "harness://run/run-demo/review",
      );

      const missing = (await s.handleMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "prompts/get",
        params: {
          name: "harness.prompt.review_run",
          arguments: {},
        },
      })) as any;
      expect(missing.error.message).toContain("missing required prompt argument");
    } finally {
      db.close();
    }
  });
});
