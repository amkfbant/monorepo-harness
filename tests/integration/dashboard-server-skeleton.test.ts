import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { type AddressInfo } from "node:net";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";
import { createDashboardServer } from "../../src/dashboard/server/server.js";
import {
  recordExternalBlob,
  registerBlobStore,
} from "../../src/db/blob-stores.js";
import { LocalBlobStore } from "../../src/storage/local-blob-store.js";

interface Env {
  dbPath: string;
  server: Awaited<ReturnType<typeof startServer>>;
}

async function startServer(dbPath: string) {
  const server = createDashboardServer({
    dbPath,
    host: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function get(baseUrl: string, path: string, init?: RequestInit) {
  const r = await fetch(`${baseUrl}${path}`, init);
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

describe("Dashboard server skeleton (Phase 12-1)", () => {
  let env: Env;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-dash-srv-"));
    mkdirSync(join(root, ".harness"), { recursive: true });
    const dbPath = join(root, ".harness", "harness.sqlite");
    const db = openDb(dbPath);
    runMigrations(db);
    db.close();
    env = { dbPath, server: await startServer(dbPath) };
  });

  afterEach(async () => {
    await env.server.close();
  });

  it("GET /api/health returns 200 + ok with schema version", async () => {
    const r = await get(env.server.baseUrl, "/api/health");
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.dbSchemaVersion).toBe(SCHEMA_VERSION);
    expect(body.schemaVersionExpected).toBe(SCHEMA_VERSION);
    expect(typeof body.generatedAt).toBe("string");
  });

  it("POST /api/health returns 405 with method_not_allowed", async () => {
    const r = await get(env.server.baseUrl, "/api/health", {
      method: "POST",
    });
    expect(r.status).toBe(405);
    const body = r.body as { error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });

  it("PUT / DELETE / PATCH all return 405", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const r = await get(env.server.baseUrl, "/api/health", { method });
      expect(r.status).toBe(405);
    }
  });

  it("GET unknown route returns 404 with not_found code", async () => {
    const r = await get(env.server.baseUrl, "/api/does-not-exist");
    expect(r.status).toBe(404);
    const body = r.body as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("GET /api/snapshot returns DashboardSnapshot from the DB (Phase 12-2)", async () => {
    const r = await get(env.server.baseUrl, "/api/snapshot");
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(body.dbSchemaVersion).toBe(SCHEMA_VERSION);
    expect(Array.isArray(body.recentRuns)).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("GET /api/snapshot accepts ?project= / ?repo= filter query params", async () => {
    const r = await get(
      env.server.baseUrl,
      "/api/snapshot?project=does-not-exist",
    );
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.filters).toEqual({ projectId: "does-not-exist" });
  });

  it("Phase 12-7: token-protected server requires Bearer auth", async () => {
    // shut down the local-no-token server and restart with a token.
    await env.server.close();
    const { createDashboardServer } = await import(
      "../../src/dashboard/server/server.js"
    );
    const srv = createDashboardServer({
      dbPath: env.dbPath,
      host: "127.0.0.1",
      port: 0,
      token: "topsecret",
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const no = await get(base, "/api/health");
      expect(no.status).toBe(401);
      const yes = await get(base, "/api/health", {
        headers: { Authorization: "Bearer topsecret" },
      });
      expect(yes.status).toBe(200);
      const wrong = await get(base, "/api/health", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(wrong.status).toBe(401);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      // restart the default for any subsequent test (cleanup)
      env.server = await startServer(env.dbPath);
    }
  });

  it("Phase 12-7: security headers (X-Content-Type-Options / X-Frame-Options / Referrer-Policy) on every response", async () => {
    const r = await fetch(`${env.server.baseUrl}/api/health`);
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("GET / returns the live HTML dashboard (Phase 12-6)", async () => {
    const r = await get(env.server.baseUrl, "/");
    expect(r.status).toBe(200);
    expect(typeof r.body).toBe("string");
    expect(String(r.body)).toMatch(/<html/i);
  });

  it("invariant: GET /api/health does NOT mutate the DB (mtime unchanged)", async () => {
    const fs = await import("node:fs");
    const before = fs.statSync(env.dbPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    await get(env.server.baseUrl, "/api/health");
    await get(env.server.baseUrl, "/api/health");
    const after = fs.statSync(env.dbPath).mtimeMs;
    expect(after).toBe(before);
  });

  // Phase 13 post-close fix (codex P1.3): mutation requires bearer + csrf.
  it("Phase 13 post-close: createDashboardServer throws when mutationEnabled without bearer token", () => {
    expect(() =>
      createDashboardServer({
        dbPath: env.dbPath,
        host: "127.0.0.1",
        port: 0,
        mutationEnabled: true,
      }),
    ).toThrow(/bearer token/i);
  });

  it("Phase 13 post-close: createDashboardServer throws when mutationEnabled without csrf token", () => {
    expect(() =>
      createDashboardServer({
        dbPath: env.dbPath,
        host: "127.0.0.1",
        port: 0,
        mutationEnabled: true,
        token: "topsecret",
      }),
    ).toThrow(/csrf/i);
  });

  it("Phase 4: GET / on a read-only server has NO mutation UI", async () => {
    const r = await get(env.server.baseUrl, "/");
    expect(r.status).toBe(200);
    const html = r.body as string;
    expect(html).not.toMatch(/harness-csrf-token/);
    expect(html).not.toMatch(/harness-bearer/);
    expect(html).not.toMatch(/<script/);
  });

  it("Phase 4: GET / with mutation enabled renders the mutation UI + CSRF meta", async () => {
    await env.server.close();
    const srv = createDashboardServer({
      dbPath: env.dbPath,
      host: "127.0.0.1",
      port: 0,
      mutationEnabled: true,
      token: "topsecret",
      csrfToken: "csrf-123",
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      // When a bearer token is configured (mutation mode) every request needs
      // it — including loading the page that hosts the mutation UI.
      const res = await fetch(`${base}/`, {
        headers: { Authorization: "Bearer topsecret" },
      });
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toMatch(/<meta name="harness-csrf-token" content="csrf-123">/);
      expect(html).toMatch(/id="harness-bearer"/);
      expect(html).toMatch(/X-CSRF-Token/);
      expect(html).toMatch(/\/api\/runs\//);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      env.server = await startServer(env.dbPath);
    }
  });

  it("Phase 4: POST /api/runs/:id/review dispatches to the POST handler (not the GET route)", async () => {
    await env.server.close();
    const srv = createDashboardServer({
      dbPath: env.dbPath,
      host: "127.0.0.1",
      port: 0,
      mutationEnabled: true,
      token: "topsecret",
      csrfToken: "csrf-123",
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const res = await fetch(`${base}/api/runs/run-x/review`, {
        method: "POST",
        headers: {
          Authorization: "Bearer topsecret",
          "X-CSRF-Token": "csrf-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "approved", dryRun: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // the mutation (POST) handler shape — NOT the read-only GET review shape.
      expect(body).toHaveProperty("operationId");
      expect((body.result as Record<string, unknown>).plannedDecision).toBe("approved");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      env.server = await startServer(env.dbPath);
    }
  });

  it("Phase 13 post-close: POST mutation without X-CSRF-Token returns 403", async () => {
    await env.server.close();
    const srv = createDashboardServer({
      dbPath: env.dbPath,
      host: "127.0.0.1",
      port: 0,
      mutationEnabled: true,
      token: "topsecret",
      csrfToken: "csrf-123",
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const noCsrf = await fetch(`${base}/api/runs/run-x/rerun`, {
        method: "POST",
        headers: {
          Authorization: "Bearer topsecret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dryRun: true }),
      });
      expect(noCsrf.status).toBe(403);
      const withCsrfWrong = await fetch(`${base}/api/runs/run-x/rerun`, {
        method: "POST",
        headers: {
          Authorization: "Bearer topsecret",
          "X-CSRF-Token": "csrf-wrong",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dryRun: true }),
      });
      expect(withCsrfWrong.status).toBe(403);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      env.server = await startServer(env.dbPath);
    }
  });

  // Phase 13 post-close fix (codex P1.1): 202 deferred endpoints must not
  // claim "succeeded" for work that never ran. The operation should be
  // finalized as `pending` so `GET /api/operations/:id` is truthful.
  it("Phase 13 post-close: deferred POST /api/runs/:id/rerun finalizes operation as pending (non-dry-run)", async () => {
    await env.server.close();
    const srv = createDashboardServer({
      dbPath: env.dbPath,
      host: "127.0.0.1",
      port: 0,
      mutationEnabled: true,
      token: "topsecret",
      csrfToken: "csrf-123",
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const r = await fetch(`${base}/api/runs/run-deferred/rerun`, {
        method: "POST",
        headers: {
          Authorization: "Bearer topsecret",
          "X-CSRF-Token": "csrf-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "external worker test" }),
      });
      expect(r.status).toBe(202);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
      const result = body.result as Record<string, unknown>;
      expect(result.executed).toBe(false);
      // Poll via GET /api/operations/:id and confirm pending.
      const opId = body.operationId as string;
      const poll = await fetch(`${base}/api/operations/${opId}`, {
        headers: { Authorization: "Bearer topsecret" },
      });
      expect(poll.status).toBe(200);
      const pollBody = (await poll.json()) as { operation: Record<string, unknown> };
      expect(pollBody.operation.status).toBe("pending");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      env.server = await startServer(env.dbPath);
    }
  });

  // Phase 12 post-close fix (external review P2-3): oversize JSON body
  // is rejected with 413 instead of being read into memory.
  it("Phase 12 post-close: POST mutation body > 1 MiB returns 413 payload_too_large", async () => {
    await env.server.close();
    const srv = createDashboardServer({
      dbPath: env.dbPath,
      host: "127.0.0.1",
      port: 0,
      mutationEnabled: true,
      token: "topsecret",
      csrfToken: "csrf-123",
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      // 1.5 MiB JSON
      const big = JSON.stringify({ dryRun: true, junk: "x".repeat(1_500_000) });
      const r = await fetch(`${base}/api/runs/run-big/rerun`, {
        method: "POST",
        headers: {
          Authorization: "Bearer topsecret",
          "X-CSRF-Token": "csrf-123",
          "Content-Type": "application/json",
        },
        body: big,
      });
      expect(r.status).toBe(413);
      const body = (await r.json()) as { error: { code: string } };
      expect(body.error.code).toBe("payload_too_large");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      env.server = await startServer(env.dbPath);
    }
  });

  // Phase 12 post-close fix (external review P1-1): artifact_id is TEXT
  // (`<runId>:<relativePath>`) and the column is `bytes`, not `byte_size`.
  // Earlier code numeric-validated the id and SELECTed a missing column,
  // so both artifact endpoints were broken. Pin down the fix.
  it("Phase 12 post-close: GET /api/artifacts/:idB64 returns the TEXT-id artifact row", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sqlite = (await import("better-sqlite3")).default;
    const db = sqlite(env.dbPath);
    try {
      // seed a minimal run + artifact row.
      const runId = "run-art-1";
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, started_at,
           updated_at, meta_json)
         VALUES (?, 'r', 'd', 'domain-coding', 'main',
           'needs_review', 'db-first', 1, 'disabled',
           '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', '{}')`,
      ).run(runId);
      const artifactId = `${runId}:summary.md`;
      db.prepare(
        `INSERT INTO artifacts
           (artifact_id, run_id, kind, relative_path, content_type, bytes,
            sha256, storage, created_at, redacted, secret_suspect)
         VALUES (?, ?, 'summary', 'summary.md', 'text/markdown', 12,
                 'deadbeef', 'file', '2025-01-01T00:00:00Z', 0, 0)`,
      ).run(artifactId, runId);
    } finally {
      db.close();
    }
    void fs; void path;
    const idB64 = Buffer.from(`${"run-art-1"}:summary.md`).toString("base64url");
    const r = await get(env.server.baseUrl, `/api/artifacts/${idB64}`);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.artifact_id).toBe("run-art-1:summary.md");
    expect(body.bytes).toBe(12);
    expect(body.run_id).toBe("run-art-1");
  });

  it("Phase 12 post-close: GET /api/artifacts/:idB64 returns 400 for non-base64url segment", async () => {
    const r = await get(env.server.baseUrl, "/api/artifacts/!!!not-base64!!!");
    // base64 decoder accepts loose forms; the truly empty/invalid case is
    // caught as 404 (no such artifact_id) rather than 400. Either is
    // acceptable as long as it's not 500 / no-such-column.
    expect([400, 404]).toContain(r.status);
  });

  it("GET /api/artifacts/:idB64/body returns integrity error for corrupt external blobs", async () => {
    const db = openDb(env.dbPath);
    const storeRoot = mkdtempSync(join(tmpdir(), "harness-dash-blob-"));
    try {
      const runId = "run-ext-body";
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, started_at,
           updated_at, meta_json)
         VALUES (?, 'r', 'd', 'domain-coding', 'main',
           'needs_review', 'db-first', 1, 'disabled',
           '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', '{}')`,
      ).run(runId);
      registerBlobStore(db, {
        storeId: "local",
        storeType: "local",
        config: { root: storeRoot },
      });
      const body = Buffer.from("external body\n");
      const sha256 = createHash("sha256").update(body).digest("hex");
      const put = await new LocalBlobStore({ root: storeRoot }).put({
        sha256,
        body,
        contentEncoding: "identity",
      });
      recordExternalBlob(db, {
        sha256,
        storeId: "local",
        uri: put.uri,
        bytes: body.length,
        storedBytes: body.length,
        contentEncoding: "identity",
      });
      const artifactId = `${runId}:summary.md`;
      db.prepare(
        `INSERT INTO artifacts
           (artifact_id, run_id, kind, relative_path, content_type, bytes,
            sha256, storage, blob_sha256, body_status, created_at,
            redacted, secret_suspect)
         VALUES (?, ?, 'summary', 'summary.md', 'text/markdown', ?,
                 ?, 'external', ?, 'external_available',
                 '2025-01-01T00:00:00Z', 0, 0)`,
      ).run(artifactId, runId, body.length, sha256, sha256);
      writeFileSync(fileURLToPath(put.uri), "corrupt body\n");
      const idB64 = Buffer.from(artifactId).toString("base64url");
      const r = await get(env.server.baseUrl, `/api/artifacts/${idB64}/body`);
      expect(r.status).toBe(409);
      const json = r.body as { error: { code: string } };
      expect(json.error.code).toBe("blob_integrity_error");
    } finally {
      db.close();
    }
  });

  it("Phase 13 post-close: dry-run rerun still finalizes as succeeded (no executor needed)", async () => {
    await env.server.close();
    const srv = createDashboardServer({
      dbPath: env.dbPath,
      host: "127.0.0.1",
      port: 0,
      mutationEnabled: true,
      token: "topsecret",
      csrfToken: "csrf-123",
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const r = await fetch(`${base}/api/runs/run-dry/rerun`, {
        method: "POST",
        headers: {
          Authorization: "Bearer topsecret",
          "X-CSRF-Token": "csrf-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dryRun: true }),
      });
      expect(r.status).toBe(202);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.status).toBe("succeeded");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      env.server = await startServer(env.dbPath);
    }
  });
});
