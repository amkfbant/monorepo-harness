import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/db/connection.js";
import { readSchemaVersion } from "../../src/db/migrations.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";
import { buildKnowledgeContextFromDb } from "../../src/core/knowledge-context.js";
import { makeTmpDir } from "../helpers/tmp.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(
  root: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: root, ...extraEnv },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

describe("CLI harness db", () => {
  it("status reports 'not initialized' before db init", () => {
    const root = makeTmpDir("harness-clidb-");
    const { out, code } = runCli(root, ["db", "status"]);
    expect(code).toBe(0);
    expect(out).toMatch(/not initialized/);
  });

  it("init creates harness.sqlite at the latest schema version", () => {
    const root = makeTmpDir("harness-clidb-");
    const { out, code } = runCli(root, ["db", "init"]);
    expect(code).toBe(0);
    expect(out).toMatch(new RegExp(`schema version: ${SCHEMA_VERSION}`));
    expect(existsSync(join(root, ".harness", "harness.sqlite"))).toBe(true);
  });

  it("status after init shows the latest version and the tables", () => {
    const root = makeTmpDir("harness-clidb-");
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "status"]);
    expect(code).toBe(0);
    expect(out).toMatch(new RegExp(`schema version: ${SCHEMA_VERSION}`));
    expect(out).toMatch(/tables: [234567][0-9]/);
  });

  it("migrate is idempotent after init", () => {
    const root = makeTmpDir("harness-clidb-");
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "migrate"]);
    expect(code).toBe(0);
    expect(out).toMatch(
      new RegExp(`already at schema version ${SCHEMA_VERSION}`),
    );
  });

  it("upgrade-check reports db-newer-than-harness skew WITHOUT migrating (#271)", () => {
    const root = makeTmpDir("harness-clidb-");
    runCli(root, ["db", "init"]);
    const dbPath = join(root, ".harness", "harness.sqlite");
    // Stamp a schema_migrations row newer than this harness supports.
    {
      const db = openDb(dbPath);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(SCHEMA_VERSION + 1, "from-the-future", new Date().toISOString());
      db.close();
    }
    const { out, code } = runCli(root, [
      "db",
      "upgrade-check",
      "--target",
      "phaseNN",
      "--json",
    ]);
    expect(code).toBe(1); // overall blocked
    const report = JSON.parse(out) as {
      overall: string;
      checks: Array<{ id: string; status: string; details?: { skewKind?: string } }>;
    };
    expect(report.overall).toBe("blocked");
    const schemaCheck = report.checks.find((c) => c.id === "schema.version");
    expect(schemaCheck?.status).toBe("blocked");
    expect(schemaCheck?.details?.skewKind).toBe("db-newer-than-harness");
    expect(out).toMatch(/upgrade the harness/);
    // The diagnostic must NOT have migrated/changed the DB version.
    const probe = openDb(dbPath);
    expect(readSchemaVersion(probe)).toBe(SCHEMA_VERSION + 1);
    probe.close();
  });

  it("upgrade-check reports harness-newer-than-db skew WITHOUT auto-migrating (#271)", () => {
    const root = makeTmpDir("harness-clidb-");
    runCli(root, ["db", "init"]);
    const dbPath = join(root, ".harness", "harness.sqlite");
    // Simulate an older DB (vN-1) by deleting the top bookkeeping row.
    {
      const db = openDb(dbPath);
      db.prepare(
        "DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)",
      ).run();
      db.close();
    }
    const { out, code } = runCli(root, [
      "db",
      "upgrade-check",
      "--target",
      "phaseNN",
      "--json",
    ]);
    expect(code).toBe(1); // overall blocked
    const report = JSON.parse(out) as {
      overall: string;
      checks: Array<{ id: string; status: string; details?: { skewKind?: string } }>;
    };
    expect(report.overall).toBe("blocked");
    const schemaCheck = report.checks.find((c) => c.id === "schema.version");
    expect(schemaCheck?.status).toBe("blocked");
    expect(schemaCheck?.details?.skewKind).toBe("harness-newer-than-db");
    expect(out).toMatch(/harness db migrate/);
    // upgrade-check must NOT silently migrate the older DB forward.
    const probe = openDb(dbPath);
    expect(readSchemaVersion(probe)).toBe(SCHEMA_VERSION - 1);
    probe.close();
  });

  it("migrate-blobs --to db refuses corrupted external object bytes", () => {
    const root = makeTmpDir("harness-clidb-");
    runCli(root, ["db", "init"]);
    const dbPath = join(root, ".harness", "harness.sqlite");
    const db = openDb(dbPath);
    let blobSha: string;
    try {
      const body = Buffer.from("original artifact body");
      blobSha = storeArtifactBlob(db, body).sha256;
      db.prepare(
        `INSERT INTO artifacts
           (artifact_id, run_id, kind, relative_path, content_type, bytes,
            sha256, storage, blob_sha256, body_status, created_at,
            redacted, secret_suspect)
         VALUES ('run-a:summary.md', 'run-a', 'summary', 'summary.md',
                 'text/markdown', ?, ?, 'db', ?, 'db_available',
                 '2026-05-25T00:00:00.000Z', 0, 0)`,
      ).run(body.length, blobSha, blobSha);
    } finally {
      db.close();
    }

    const storeRoot = join(root, "blob-store");
    expect(
      runCli(root, [
        "db",
        "blob-store",
        "add",
        "local",
        "--id",
        "local",
        "--path",
        storeRoot,
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, ["db", "migrate-blobs", "--to", "external", "--store", "local"]).code,
    ).toBe(0);

    const corruptDb = openDb(dbPath);
    try {
      const row = corruptDb
        .prepare("SELECT uri FROM external_artifact_blobs WHERE sha256 = ?")
        .get(blobSha) as { uri: string };
      writeFileSync(fileURLToPath(row.uri), "corrupted body");
    } finally {
      corruptDb.close();
    }

    const restore = runCli(root, [
      "db",
      "migrate-blobs",
      "--to",
      "db",
      "--store",
      "local",
      "--json",
    ]);
    expect(restore.code).toBe(0);
    const parsed = JSON.parse(restore.out) as { restored: number; failed: number };
    expect(parsed.restored).toBe(0);
    expect(parsed.failed).toBe(1);
    const verifyDb = openDb(dbPath);
    try {
      const row = verifyDb
        .prepare("SELECT storage FROM artifacts WHERE artifact_id = 'run-a:summary.md'")
        .get() as { storage: string };
      expect(row.storage).toBe("external");
    } finally {
      verifyDb.close();
    }

    const doctor = runCli(root, ["db", "doctor", "--deep", "--json"]);
    expect(doctor.code).toBe(1);
    const doctorJson = JSON.parse(doctor.out) as {
      findings: Array<{ checkId: string; status: string }>;
    };
    expect(
      doctorJson.findings.some(
        (f) =>
          f.checkId === "artifact.external.unavailable" &&
          f.status === "flagged",
      ),
    ).toBe(true);
  });

  it("migrate-blobs preserves truncated artifact status across external round trip", () => {
    const root = makeTmpDir("harness-clidb-");
    runCli(root, ["db", "init"]);
    const dbPath = join(root, ".harness", "harness.sqlite");
    const db = openDb(dbPath);
    let blobSha: string;
    try {
      const body = Buffer.from("stored truncated prefix");
      blobSha = storeArtifactBlob(db, body).sha256;
      db.prepare(
        `INSERT INTO artifacts
           (artifact_id, run_id, kind, relative_path, content_type, bytes,
            sha256, storage, blob_sha256, body_status, created_at,
            redacted, secret_suspect, original_bytes, original_sha256)
         VALUES ('run-a:large.log', 'run-a', 'log', 'large.log',
                 'text/plain', ?, ?, 'db', ?, 'truncated',
                 '2026-05-25T00:00:00.000Z', 0, 0, ?, ?)`,
      ).run(body.length, blobSha, blobSha, body.length + 10, "f".repeat(64));
    } finally {
      db.close();
    }

    const storeRoot = join(root, "blob-store");
    expect(
      runCli(root, [
        "db",
        "blob-store",
        "add",
        "local",
        "--id",
        "local",
        "--path",
        storeRoot,
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, ["db", "migrate-blobs", "--to", "external", "--store", "local"]).code,
    ).toBe(0);

    const externalRow = openDb(dbPath);
    try {
      expect(
        externalRow
          .prepare("SELECT storage, body_status FROM artifacts WHERE artifact_id = 'run-a:large.log'")
          .get(),
      ).toEqual({ storage: "external", body_status: "truncated" });
    } finally {
      externalRow.close();
    }

    expect(
      runCli(root, ["db", "migrate-blobs", "--to", "db", "--store", "local"]).code,
    ).toBe(0);
    const restoredRow = openDb(dbPath);
    try {
      expect(
        restoredRow
          .prepare("SELECT storage, body_status FROM artifacts WHERE artifact_id = 'run-a:large.log'")
          .get(),
      ).toEqual({ storage: "db", body_status: "truncated" });
    } finally {
      restoredRow.close();
    }
  });

  it("init is idempotent — re-running keeps the schema current", () => {
    const root = makeTmpDir("harness-clidb-");
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "init"]);
    expect(code).toBe(0);
    expect(out).toMatch(/already current/);
  });

  it("import requires --from-files", () => {
    const root = makeTmpDir("harness-clidb-");
    const { out, code } = runCli(root, ["db", "import"]);
    expect(code).toBe(1);
    expect(out).toMatch(/requires --from-files/);
  });

  it("import --from-files builds the read model from a project tree", () => {
    const root = makeTmpDir("harness-clidb-");
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: demo",
        "policy:",
        "  template: strict-monorepo-v1",
        "domains:",
        "  - id: apps/web",
        "    root: apps/web",
        "    kind: app",
        "",
      ].join("\n"),
    );
    const { out, code } = runCli(root, [
      "db",
      "import",
      "--from-files",
      "--json",
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { projects: number; errors: number };
    expect(report.projects).toBe(1);
    expect(report.errors).toBe(0);
  });

  it("knowledge edit updates indexed metadata so DB context moves domains", async () => {
    const root = makeTmpDir("harness-clidb-");
    const knowledgeDir = join(root, "docs", "knowledge", "domain_rule");
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, "foo.md"),
      [
        "---",
        "kind: domain_rule",
        'domain: "catalog"',
        'title: "Catalog Lesson"',
        "---",
        "",
        "catalog body",
        "",
      ].join("\n"),
    );
    expect(runCli(root, ["knowledge", "import", "--from-docs"]).code).toBe(0);
    const editor = join(root, "edit-knowledge.sh");
    writeFileSync(
      editor,
      [
        "#!/bin/sh",
        "cat > \"$1\" <<'EOF'",
        "---",
        "kind: domain_rule",
        "domain: \"checkout\"",
        "title: \"Checkout Lesson\"",
        "---",
        "",
        "edited body",
        "EOF",
        "",
      ].join("\n"),
    );
    chmodSync(editor, 0o755);

    const edited = runCli(
      root,
      ["knowledge", "edit", "docs/knowledge/domain_rule/foo.md"],
      { EDITOR: editor },
    );
    expect(edited.code).toBe(0);

    const db = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      const checkout = await buildKnowledgeContextFromDb({
        db,
        outDir: join(root, "knowledge-context"),
        domain: "checkout",
      });
      const catalog = await buildKnowledgeContextFromDb({
        db,
        outDir: join(root, "knowledge-context"),
        domain: "catalog",
      });
      expect(checkout.entries.map((e) => e.title)).toEqual([
        "Checkout Lesson",
      ]);
      expect(catalog.entries).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("check-consistency reports ok right after an import", () => {
    const root = makeTmpDir("harness-clidb-");
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: demo",
        "domains:",
        "  - id: apps/web",
        "    root: apps/web",
        "    kind: app",
        "",
      ].join("\n"),
    );
    runCli(root, ["db", "import", "--from-files"]);
    const { out, code } = runCli(root, ["db", "check-consistency"]);
    expect(code).toBe(0);
    expect(out).toMatch(/db consistency: ok/);
  });

  it("check-consistency exits 1 when a profile drifts", () => {
    const root = makeTmpDir("harness-clidb-");
    mkdirSync(join(root, "projects"), { recursive: true });
    const profile = [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: demo",
      "domains:",
      "  - id: apps/web",
      "    root: apps/web",
      "    kind: app",
      "",
    ].join("\n");
    writeFileSync(join(root, "projects", "demo.yaml"), profile);
    runCli(root, ["db", "import", "--from-files"]);
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      `${profile}description: drifted\n`,
    );
    const { out, code } = runCli(root, ["db", "check-consistency"]);
    expect(code).toBe(1);
    expect(out).toMatch(/drift/);
  });
});
