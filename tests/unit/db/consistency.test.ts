import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { runFullImport } from "../../../src/db/import-files.js";
import { checkConsistency } from "../../../src/db/consistency.js";
import { storeArtifactBlob } from "../../../src/db/artifact-blobs.js";

/** Insert a db-stored artifact backed by a real blob; returns its sha. */
function addDbArtifact(
  db: ReturnType<typeof openDb>,
  artifactId: string,
  body: Buffer,
): string {
  const stored = storeArtifactBlob(db, body);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
       content_type, bytes, sha256, storage, blob_sha256, body_status)
     VALUES (?, 'run-20260521-apps-web-aaa', 'codex-log', 'codex.log',
       'text/plain', ?, ?, 'db', ?, 'db_available')`,
  ).run(artifactId, body.length, stored.sha256, stored.sha256);
  return stored.sha256;
}

const PROFILE = [
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

function writeRun(root: string, runId: string, status = "needs_review"): void {
  const dir = join(root, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      repoId: "demo",
      repoPath: "/tmp/demo",
      domain: "apps/web",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: `harness/${runId}`,
      status,
      startedAt: "2026-05-21T00:00:00Z",
    }),
  );
  writeFileSync(join(dir, "events.jsonl"), `{"type":"run_started"}\n`);
}

/** Harness root with one project and one run, already imported. */
function importedRoot(): { root: string; db: ReturnType<typeof openDb> } {
  const root = mkdtempSync(join(tmpdir(), "harness-cons-"));
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "projects", "demo.yaml"), PROFILE);
  writeRun(root, "run-20260521-apps-web-aaa");
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  runFullImport(db, { harnessRoot: root });
  return { root, db };
}

describe("checkConsistency", () => {
  it("reports ok immediately after an import", () => {
    const { root, db } = importedRoot();
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(r.status).toBe("ok");
    expect(r.items.every((i) => i.status === "ok")).toBe(true);
  });

  it("detects run drift when a run file changes after import", () => {
    const { root, db } = importedRoot();
    writeRun(root, "run-20260521-apps-web-aaa", "approved"); // meta changed
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(r.status).toBe("warn");
    expect(
      r.items.some((i) => i.kind === "run" && i.status === "drift"),
    ).toBe(true);
  });

  it("detects a missing run dir as missing-file", () => {
    const { root, db } = importedRoot();
    rmSync(join(root, "runs", "run-20260521-apps-web-aaa"), {
      recursive: true,
      force: true,
    });
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some((i) => i.kind === "run" && i.status === "missing-file"),
    ).toBe(true);
  });

  it("detects an un-imported run dir as missing-db", () => {
    const { root, db } = importedRoot();
    writeRun(root, "run-20260521-apps-web-bbb");
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) =>
          i.kind === "run" &&
          i.id === "run-20260521-apps-web-bbb" &&
          i.status === "missing-db",
      ),
    ).toBe(true);
  });

  it("does not false-warn when the filename differs from project_id", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cons-"));
    mkdirSync(join(root, "projects"), { recursive: true });
    // filename stem "weird-name" ≠ project_id "demo"
    writeFileSync(join(root, "projects", "weird-name.yaml"), PROFILE);
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    runFullImport(db, { harnessRoot: root });
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(r.status).toBe("ok");
  });

  it("detects generated policy provenance sidecar drift", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cons-"));
    mkdirSync(join(root, "policies", "repos"), { recursive: true });
    writeFileSync(join(root, "policies", "repos", "demo.yaml"), "repo_id: demo\n");
    const sidecar = join(root, "policies", "repos", "demo.generated.json");
    const provenance = {
      schemaVersion: 1,
      projectId: "demo",
      repoId: "demo",
      profilePath: "projects/demo.yaml",
      profileVersion: 1,
      policyTemplate: null,
      commandPresets: [],
      contextPackPresets: [],
      domainRegistry: null,
      generatedAt: "2026-05-22T00:00:00.000Z",
    };
    writeFileSync(sidecar, JSON.stringify(provenance));
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    runFullImport(db, { harnessRoot: root });
    // the policy YAML is unchanged; only the provenance sidecar drifts
    writeFileSync(
      sidecar,
      JSON.stringify({ ...provenance, generatedAt: "2026-05-23T00:00:00.000Z" }),
    );
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) =>
          i.kind === "policy" &&
          i.status === "drift" &&
          /sidecar/.test(i.detail),
      ),
    ).toBe(true);
  });

  it("detects a generated policy sidecar missing from the DB", () => {
    const { root, db } = importedRoot();
    // a generated-policy sidecar appears on disk but is never imported
    mkdirSync(join(root, "policies", "repos"), { recursive: true });
    writeFileSync(join(root, "policies", "repos", "demo.yaml"), "repo_id: demo\n");
    writeFileSync(
      join(root, "policies", "repos", "demo.generated.json"),
      JSON.stringify({
        schemaVersion: 1,
        projectId: "demo",
        repoId: "demo",
        profilePath: "projects/demo.yaml",
        profileVersion: 1,
        policyTemplate: null,
        commandPresets: [],
        contextPackPresets: [],
        domainRegistry: null,
        generatedAt: "2026-05-22T00:00:00.000Z",
      }),
    );
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some((i) => i.kind === "policy" && i.status === "missing-db"),
    ).toBe(true);
  });

  it("detects a backlog item on disk but not in the DB (missing-db)", () => {
    const { root, db } = importedRoot();
    // a backlog item appears on disk after the import
    mkdirSync(join(root, "backlog", "open"), { recursive: true });
    writeFileSync(
      join(root, "backlog", "open", "item-20260521-001.yaml"),
      [
        "id: item-20260521-001",
        "title: t",
        "domain: apps/web",
        "goal: g",
        "status: open",
        "priority: medium",
        "tags: []",
        "createdAt: 2026-05-21T00:00:00Z",
        "linkedRuns: []",
        "",
      ].join("\n"),
    );
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) => i.kind === "backlog" && i.status === "missing-db",
      ),
    ).toBe(true);
  });

  it("detects project profile drift", () => {
    const { root, db } = importedRoot();
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      `${PROFILE}\ndescription: changed\n`,
    );
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some((i) => i.kind === "project" && i.status === "drift"),
    ).toBe(true);
  });
});

describe("checkConsistency — artifact blobs (Phase 8-11)", () => {
  it("stays ok with a healthy db-stored artifact and blob", () => {
    const { root, db } = importedRoot();
    addDbArtifact(db, "art-ok", Buffer.from("a healthy codex log body"));
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(r.items.some((i) => i.kind.startsWith("artifact"))).toBe(false);
    expect(r.status).toBe("ok");
  });

  it("does NOT flag a DB-reconstructed artifact for a null blob_sha256", () => {
    const { root, db } = importedRoot();
    // meta.json / events.jsonl / review-decision.yaml are db-stored but
    // DB-reconstructed — `ingestRunArtifacts` registers them storage='db'
    // with blob_sha256 NULL by design; that is not drift.
    for (const name of ["meta.json", "events.jsonl", "review-decision.yaml"]) {
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
           bytes, sha256, storage, blob_sha256, body_status)
         VALUES (?, 'run-20260521-apps-web-aaa', 'meta', ?, 0, 'h', 'db',
           NULL, 'db_available')`,
      ).run(`art-${name}`, name);
    }
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(r.items.some((i) => i.kind.startsWith("artifact"))).toBe(false);
    expect(r.status).toBe("ok");
  });

  it("flags a db-stored artifact with no blob_sha256 reference", () => {
    const { root, db } = importedRoot();
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, bytes, sha256,
         storage, blob_sha256, body_status)
       VALUES ('art-noref', 'run-20260521-apps-web-aaa', 'codex-log', 3,
         'deadbeef', 'db', NULL, 'db_available')`,
    ).run();
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) =>
          i.kind === "artifact" &&
          i.id === "art-noref" &&
          i.status === "drift",
      ),
    ).toBe(true);
  });

  it("flags a db-stored artifact whose blob row is gone", () => {
    const { root, db } = importedRoot();
    const sha = addDbArtifact(db, "art-dangling", Buffer.from("body"));
    // drop the blob the artifact still points at
    db.prepare("DELETE FROM artifact_blobs WHERE sha256 = ?").run(sha);
    db.prepare("DELETE FROM artifact_blob_chunks WHERE sha256 = ?").run(sha);
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) => i.kind === "artifact" && i.id === "art-dangling",
      ),
    ).toBe(true);
  });

  it("flags a blob whose chunks do not match its manifest", () => {
    const { root, db } = importedRoot();
    // a multi-chunk blob, then a chunk is deleted (partial / corrupt write)
    const sha = addDbArtifact(db, "art-corrupt", Buffer.from("x".repeat(8)));
    db.prepare(
      "UPDATE artifact_blobs SET chunk_count = chunk_count + 1 WHERE sha256 = ?",
    ).run(sha);
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) => i.kind === "artifact-blob" && i.status === "drift",
      ),
    ).toBe(true);
  });

  it("reports error when an artifact blob's content is corrupt", () => {
    const { root, db } = importedRoot();
    const sha = addDbArtifact(db, "art-corrupt-body", Buffer.alloc(40, "x"));
    // overwrite the chunk with same-length different bytes — chunk_count
    // and stored_bytes still match, so only an end-to-end sha check catches it
    db.prepare(
      "UPDATE artifact_blob_chunks SET content = ? WHERE sha256 = ?",
    ).run(Buffer.alloc(40, "y"), sha);
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) => i.kind === "artifact-blob" && i.status === "drift",
      ),
    ).toBe(true);
    // a corrupt DB blob is data loss — error severity, not warn
    expect(r.status).toBe("error");
  });

  it("flags an artifact whose body_status is missing", () => {
    const { root, db } = importedRoot();
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, bytes, sha256,
         storage, blob_sha256, body_status)
       VALUES ('art-missing', 'run-20260521-apps-web-aaa', 'codex-log', 0,
         'cafebabe', 'file', NULL, 'missing')`,
    ).run();
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) =>
          i.kind === "artifact" &&
          i.id === "art-missing" &&
          i.status === "missing-file",
      ),
    ).toBe(true);
  });

  it(
    "flags a truncated artifact missing original_bytes/original_sha256 " +
      "(Phase 9 post-close P2-5)",
    () => {
      const { root, db } = importedRoot();
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, bytes, sha256,
           storage, blob_sha256, body_status, original_bytes, original_sha256)
         VALUES ('art-trunc-bad', 'run-20260521-apps-web-aaa', 'codex-log',
           100, 'aaa', 'db', 'aaa', 'truncated', NULL, NULL)`,
      ).run();
      const r = checkConsistency({ db, harnessRoot: root });
      db.close();
      expect(
        r.items.some(
          (i) =>
            i.kind === "artifact" &&
            i.id === "art-trunc-bad" &&
            i.status === "drift" &&
            /audit metadata/.test(i.detail ?? ""),
        ),
      ).toBe(true);
    },
  );

  it(
    "flags a truncated artifact whose original_bytes < stored bytes " +
      "(Phase 9 post-close P2-5)",
    () => {
      const { root, db } = importedRoot();
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, bytes, sha256,
           storage, blob_sha256, body_status, original_bytes, original_sha256)
         VALUES ('art-trunc-shrunk', 'run-20260521-apps-web-aaa', 'codex-log',
           100, 'aaa', 'db', 'aaa', 'truncated', 50, 'bbb')`,
      ).run();
      const r = checkConsistency({ db, harnessRoot: root });
      db.close();
      expect(
        r.items.some(
          (i) =>
            i.kind === "artifact" &&
            i.id === "art-trunc-shrunk" &&
            i.status === "drift" &&
            /original_bytes \(50\) < stored bytes \(100\)/.test(i.detail ?? ""),
        ),
      ).toBe(true);
    },
  );

  it(
    "flags a non-truncated artifact that carries original_* (Phase 9 post-close P2-5)",
    () => {
      const { root, db } = importedRoot();
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, bytes, sha256,
           storage, blob_sha256, body_status, original_bytes, original_sha256)
         VALUES ('art-clean-stray', 'run-20260521-apps-web-aaa', 'codex-log',
           20, 'aaa', 'db', 'aaa', 'db_available', 50, 'bbb')`,
      ).run();
      const r = checkConsistency({ db, harnessRoot: root });
      db.close();
      expect(
        r.items.some(
          (i) =>
            i.kind === "artifact" &&
            i.id === "art-clean-stray" &&
            i.status === "drift" &&
            /non-truncated/.test(i.detail ?? ""),
        ),
      ).toBe(true);
    },
  );
});
