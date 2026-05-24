import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AddressInfo } from "node:net";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createDashboardServer } from "../../src/dashboard/server/server.js";

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
    expect(body.dbSchemaVersion).toBe(7);
    expect(body.schemaVersionExpected).toBe(7);
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
    expect(body.dbSchemaVersion).toBe(7);
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
});
