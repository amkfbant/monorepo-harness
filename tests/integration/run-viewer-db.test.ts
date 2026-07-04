import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";
import {
  recordExternalBlob,
  registerBlobStore,
} from "../../src/db/blob-stores.js";
import { LocalBlobStore } from "../../src/storage/local-blob-store.js";
import {
  readRunArtifactBody,
  renderRunShow,
  renderRunTimeline,
  renderRunArtifacts,
  RunViewError,
} from "../../src/core/run-viewer.js";
import { buildRerunChain, formatChain } from "../../src/core/rerun.js";

/**
 * Phase 8-12 — the read-only viewers fall back to the DB when a db-first
 * run has no exported files (file export OFF, or run dir cleaned).
 */

let seq = 0;
const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), "src/cli/run.ts");

interface Fixture {
  root: string;
  runsDir: string;
  dbPath: string;
  runId: string;
}

/** A DB with one db-first run (meta_json + events + a db-stored artifact)
 *  and an EMPTY runs dir — i.e. the DB-only state. */
function dbOnlyRun(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `harness-rvdb-${seq++}-`));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true }); // exists, but no run subdir
  const dbPath = join(root, ".harness", "harness.sqlite");
  const runId = "run-20260523-apps-web-db1";
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    const meta = {
      runId,
      repoId: "demo",
      repoPath: "/repo",
      domain: "apps/web",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: `harness/${runId}`,
      status: "needs_review",
      safetyStatus: "allowed",
      changedFilesCount: 3,
      commandResults: [],
    };
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, updated_at, meta_json)
       VALUES (?, 'demo', 'apps/web', 'domain-coding', 'main',
         'needs_review', 'db-first', '2026-05-23T00:00:00Z', ?)`,
    ).run(runId, JSON.stringify(meta));
    db.prepare(
      `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
       VALUES (?, 1, 'run_started', NULL, ?)`,
    ).run(runId, JSON.stringify({ type: "run_started", stage: "start" }));
    const blob = storeArtifactBlob(db, Buffer.from("codex log body"));
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
         bytes, sha256, storage, blob_sha256, body_status)
       VALUES ('a1', ?, 'codex-log', 'codex.log', 14, ?, 'db', ?,
         'db_available')`,
    ).run(runId, blob.sha256, blob.sha256);
  } finally {
    db.close();
  }
  return { root, runsDir, dbPath, runId };
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runHarness(
  root: string,
  args: readonly string[],
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      ["--import", "tsx", CLI, ...args],
      {
        env: { ...process.env, HARNESS_ROOT: root },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: e.code ?? 1,
    };
  }
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function materializeRunDir(
  fixture: Pick<Fixture, "runsDir" | "runId">,
  files: Record<string, string> = {},
): string {
  const runDir = join(fixture.runsDir, fixture.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      runId: fixture.runId,
      repoId: "demo",
      repoPath: "/repo",
      domain: "apps/web",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: `harness/${fixture.runId}`,
      status: "needs_review",
      safetyStatus: "allowed",
      changedFilesCount: 3,
      commandResults: [],
    }),
  );
  for (const [rel, body] of Object.entries(files)) {
    const parts = rel.split("/");
    const dir =
      parts.length > 1 ? join(runDir, ...parts.slice(0, -1)) : runDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(runDir, rel), body);
  }
  return runDir;
}

describe("run viewer — DB fallback (Phase 8-12)", () => {
  it("run show renders a db-first run with no exported files", async () => {
    const { runsDir, dbPath, runId } = dbOnlyRun();
    const out = await renderRunShow(runsDir, runId, undefined, dbPath);
    expect(out).toContain(runId);
    expect(out).toContain("apps/web");
    expect(out).toContain("needs_review");
    expect(out).toContain("codex.log"); // artifact listed from the DB
  });

  it("run timeline renders events from the DB", async () => {
    const { runsDir, dbPath, runId } = dbOnlyRun();
    const out = await renderRunTimeline(runsDir, runId, dbPath);
    expect(out).toContain("run_started");
  });

  it("run artifacts lists the DB artifact manifest", async () => {
    const { runsDir, dbPath, runId } = dbOnlyRun();
    const out = await renderRunArtifacts(runsDir, runId, dbPath);
    expect(out).toContain("codex.log");
  });

  it("run artifact-get writes a DB artifact body to stdout", async () => {
    const { root, runId } = dbOnlyRun();
    const out = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "codex.log",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("codex log body");
    expect(out.stderr).toBe("");
  });

  it("run artifact-get can select by artifact id and write --out", async () => {
    const { root, runId } = dbOnlyRun();
    const outPath = join(root, "artifact.out");
    const out = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--artifact-id",
      "a1",
      "--out",
      outPath,
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("");
    expect(readFileSync(outPath, "utf8")).toBe("codex log body");
    expect(statSync(outPath).mode & 0o777).toBe(0o600);

    chmodSync(outPath, 0o644);
    writeFileSync(outPath, "old body");
    const overwrite = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--artifact-id",
      "a1",
      "--out",
      outPath,
    ]);
    expect(overwrite.code).toBe(0);
    expect(readFileSync(outPath, "utf8")).toBe("codex log body");
    expect(statSync(outPath).mode & 0o777).toBe(0o600);

    const targetPath = join(root, "target.out");
    const linkPath = join(root, "artifact-link.out");
    writeFileSync(targetPath, "target");
    symlinkSync(targetPath, linkPath);
    const symlinkOut = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--artifact-id",
      "a1",
      "--out",
      linkPath,
    ]);
    expect(symlinkOut.code).toBe(1);
    expect(symlinkOut.stderr).toContain("--out must not be a symlink");
  });

  it("run artifact-get resolves file-backed artifact ids in auto mode", async () => {
    const { root, runsDir, dbPath, runId } = dbOnlyRun();
    materializeRunDir({ runsDir, runId }, { "file-backed.log": "file body" });
    const db = openDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
         bytes, sha256, storage, blob_sha256, body_status)
         VALUES ('a-file', ?, 'codex-log', 'file-backed.log', 9,
           'file-sha', 'file', NULL, 'file_available')`,
      ).run(runId);
    } finally {
      db.close();
    }

    const out = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--artifact-id",
      "a-file",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("file body");

    const byName = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "file-backed.log",
    ]);
    expect(byName.code).toBe(0);
    expect(byName.stdout).toBe("file body");
  });

  it("run artifact-get reads an external-local DB artifact body", async () => {
    const { root, runId, dbPath } = dbOnlyRun();
    const body = Buffer.from("external body");
    const bodySha = sha256(body);
    const storeRoot = join(root, "blob-store");
    const store = new LocalBlobStore({ root: storeRoot });
    const put = await store.put({ sha256: bodySha, body });
    const db = openDb(dbPath);
    try {
      registerBlobStore(db, {
        storeId: "local-fixture",
        storeType: "local",
        config: { root: storeRoot },
      });
      recordExternalBlob(db, {
        sha256: bodySha,
        storeId: "local-fixture",
        uri: put.uri,
        bytes: body.length,
        storedBytes: put.storedBytes,
        contentEncoding: "identity",
      });
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
           bytes, sha256, storage, blob_sha256, body_status)
         VALUES ('a-ext', ?, 'codex-log', 'external.log', ?, ?, 'external',
           ?, 'external_available')`,
      ).run(runId, body.length, bodySha, bodySha);
    } finally {
      db.close();
    }

    const out = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "external.log",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("external body");
  });

  it("run artifact-get reconstructs bodyless DB sidecars", async () => {
    const { root, runId, dbPath } = dbOnlyRun();
    const db = openDb(dbPath);
    try {
      for (const [artifactId, relativePath] of [
        ["a-meta", "meta.json"],
        ["a-events", "events.jsonl"],
        ["a-review", "review-decision.yaml"],
      ] as const) {
        db.prepare(
          `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
             bytes, sha256, storage, blob_sha256, body_status)
           VALUES (?, ?, 'run-sidecar', ?, 0, ?, 'db', NULL,
             'db_reconstructable')`,
        ).run(artifactId, runId, relativePath, `${artifactId}-sha`);
      }
    } finally {
      db.close();
    }

    const meta = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--artifact-id",
      "a-meta",
    ]);
    expect(meta.code).toBe(0);
    expect(JSON.parse(meta.stdout)).toMatchObject({
      runId,
      domain: "apps/web",
    });

    const events = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "events.jsonl",
    ]);
    expect(events.code).toBe(0);
    expect(events.stdout).toContain('"type":"run_started"');

    const review = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "review-decision.yaml",
    ]);
    expect(review.code).toBe(0);
    expect(review.stdout).toContain(`runId: ${runId}`);
    expect(review.stdout).toContain("decision: pending");
  });

  it("run artifact-get reconstructs review decisions without review_proposals", async () => {
    const { root, runId, dbPath } = dbOnlyRun();
    const yaml = `runId: ${runId}\ndecision: approved\nreviewed_at: t\n`;
    const db = openDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
           bytes, sha256, storage, blob_sha256, body_status)
         VALUES ('a-review', ?, 'run-sidecar', 'review-decision.yaml', 0,
           'a-review-sha', 'db', NULL, 'db_reconstructable')`,
      ).run(runId);
      db.prepare(
        `INSERT INTO review_decisions (run_id, decision, reviewer, summary,
           reviewed_at, source_yaml, source_sha256)
         VALUES (?, 'approved', 'kn', NULL, 't', ?, ?)`,
      ).run(runId, yaml, sha256(Buffer.from(yaml)));
      db.prepare("DROP TABLE review_proposals").run();
    } finally {
      db.close();
    }

    const out = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "review-decision.yaml",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(yaml);
  });

  it("run artifact-get does not treat v35 grandfathered blobs as unsafe quarantine", async () => {
    const { root, runId, dbPath } = dbOnlyRun();
    const db = openDb(dbPath);
    try {
      db.prepare(
        "UPDATE artifacts SET quarantined = 1 WHERE artifact_id = 'a1'",
      ).run();
    } finally {
      db.close();
    }

    const out = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "codex.log",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("codex log body");
  });

  it("run artifact-get refuses redacted, quarantined, and unsafe names", async () => {
    const { root, runsDir, dbPath, runId } = dbOnlyRun();
    const db = openDb(dbPath);
    try {
      const redactedBlob = storeArtifactBlob(db, Buffer.from("secret body"));
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
           bytes, sha256, storage, blob_sha256, body_status, redacted)
         VALUES ('a-redacted', ?, 'codex-log', 'redacted.log', 11, ?, 'db',
           ?, 'db_available', 1)`,
      ).run(runId, redactedBlob.sha256, redactedBlob.sha256);
      const quarantinedBlob = storeArtifactBlob(
        db,
        Buffer.from("quarantined body"),
      );
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
           bytes, sha256, storage, blob_sha256, body_status, quarantined)
         VALUES ('a-quarantined', ?, 'codex-log',
           'reviewers/alice/reviewer-agent.out.log', 16, ?, 'db', ?,
           'db_available', 1)`,
      ).run(runId, quarantinedBlob.sha256, quarantinedBlob.sha256);
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
           bytes, sha256, storage, blob_sha256, body_status, quarantined)
         VALUES ('a-root-reviewer', ?, 'codex-log',
           'reviewer-agent.out.log', 16, ?, 'db', ?, 'db_available', 1)`,
      ).run(runId, quarantinedBlob.sha256, quarantinedBlob.sha256);
    } finally {
      db.close();
    }
    materializeRunDir({ runsDir, runId }, { "redacted.log": "secret body" });

    const redacted = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "redacted.log",
    ]);
    expect(redacted.code).toBe(1);
    expect(redacted.stderr).toContain("body unavailable: redacted");

    const redactedFiles = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "redacted.log",
      "--source",
      "files",
    ]);
    expect(redactedFiles.code).toBe(1);
    expect(redactedFiles.stderr).toContain("body unavailable: redacted");

    const quarantined = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "reviewers/alice/reviewer-agent.out.log",
    ]);
    expect(quarantined.code).toBe(1);
    expect(quarantined.stderr).toContain("body unavailable: quarantined");

    const rootReviewer = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "reviewer-agent.out.log",
    ]);
    expect(rootReviewer.code).toBe(1);
    expect(rootReviewer.stderr).toContain("body unavailable: quarantined");

    await expect(
      readRunArtifactBody(
        runsDir,
        runId,
        { kind: "name", value: "../meta.json" },
        dbPath,
      ),
    ).rejects.toThrow(/invalid artifact name/);
  });

  it("run artifact-get --source files refuses backslashes and symlink escapes", async () => {
    const { root, runsDir, dbPath, runId } = dbOnlyRun();
    const runDir = materializeRunDir({ runsDir, runId });
    const outsideFile = join(root, "outside.txt");
    writeFileSync(outsideFile, "outside secret");
    symlinkSync(outsideFile, join(runDir, "link.log"));
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "nested.log"), "nested secret");
    symlinkSync(outsideDir, join(runDir, "linked-dir"), "dir");
    const hiddenDir = join(runDir, ".hidden");
    mkdirSync(hiddenDir);
    writeFileSync(join(hiddenDir, "raw.log"), "raw secret");
    symlinkSync(hiddenDir, join(runDir, "public"), "dir");

    await expect(
      readRunArtifactBody(
        runsDir,
        runId,
        { kind: "name", value: "..\\meta.json" },
        dbPath,
        "files",
      ),
    ).rejects.toThrow(/invalid artifact name/);

    const link = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "link.log",
      "--source",
      "files",
    ]);
    expect(link.code).toBe(1);
    expect(link.stderr).toContain("is a symlink");

    const linkedDir = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "linked-dir/nested.log",
      "--source",
      "files",
    ]);
    expect(linkedDir.code).toBe(1);
    expect(linkedDir.stderr).toContain("is a symlink");

    const linkedInside = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "public/raw.log",
      "--source",
      "files",
    ]);
    expect(linkedInside.code).toBe(1);
    expect(linkedInside.stderr).toContain("is a symlink");
  });

  it("run artifact-get --source files refuses dotfiles and symlinked run dirs", async () => {
    const { root, runsDir, dbPath, runId } = dbOnlyRun();
    const runDir = materializeRunDir(
      { runsDir, runId },
      {
        ".codex-events.raw.jsonl": "raw secret",
        "reviewers/alice/.reviewer-agent.events.raw.jsonl": "raw reviewer",
      },
    );

    await expect(
      readRunArtifactBody(
        runsDir,
        runId,
        { kind: "name", value: ".codex-events.raw.jsonl" },
        dbPath,
        "files",
      ),
    ).rejects.toThrow(/invalid artifact name/);
    await expect(
      readRunArtifactBody(
        runsDir,
        runId,
        {
          kind: "name",
          value: "reviewers/alice/.reviewer-agent.events.raw.jsonl",
        },
        dbPath,
        "files",
      ),
    ).rejects.toThrow(/invalid artifact name/);

    rmSync(runDir, { recursive: true, force: true });
    const outsideRun = join(root, "outside-run");
    mkdirSync(outsideRun);
    writeFileSync(
      join(outsideRun, "meta.json"),
      JSON.stringify({
        runId,
        repoId: "demo",
        repoPath: "/repo",
        domain: "apps/web",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "abc",
        runBranch: `harness/${runId}`,
        status: "needs_review",
        safetyStatus: "allowed",
        changedFilesCount: 3,
        commandResults: [],
      }),
    );
    writeFileSync(join(outsideRun, "leaked.log"), "outside body");
    symlinkSync(outsideRun, runDir, "dir");

    const symlinkRunDir = await runHarness(root, [
      "run",
      "artifact-get",
      "--run-id",
      runId,
      "--name",
      "leaked.log",
      "--source",
      "files",
    ]);
    expect(symlinkRunDir.code).toBe(1);
    expect(symlinkRunDir.stderr).toContain("run dir");
    expect(symlinkRunDir.stderr).toContain("symlink");
  });

  it("without a dbPath a fileless run is reported not found", async () => {
    const { runsDir, runId } = dbOnlyRun();
    await expect(renderRunShow(runsDir, runId)).rejects.toBeInstanceOf(
      RunViewError,
    );
  });

  it("a run absent from both files and DB is not found", async () => {
    const { runsDir, dbPath } = dbOnlyRun();
    await expect(
      renderRunShow(runsDir, "run-20260523-apps-web-zzz", undefined, dbPath),
    ).rejects.toBeInstanceOf(RunViewError);
  });

  it("rerun chain builds from the DB for a fileless run", async () => {
    const { runsDir, dbPath, runId } = dbOnlyRun();
    const root = await buildRerunChain({ runsDir, runId, dbPath });
    expect(root.runId).toBe(runId);
    expect(formatChain(root)).toContain(runId);
  });
});
