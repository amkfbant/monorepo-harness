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
