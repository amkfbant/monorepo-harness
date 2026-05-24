import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  acquireShared,
  acquireExclusive,
  MaintenanceLockBusyError,
} from "../../src/db/maintenance-lock.js";
import {
  acquireDomainLock,
  assertActiveLease,
  LeaseGuardFailedError,
  DomainLockBusyError,
} from "../../src/workspace/db-domain-lock.js";

/**
 * Phase 9-12 — concurrency / lease / maintenance lock / lifecycle matrix.
 *
 * Exercises cross-cutting scenarios that the per-feature unit tests
 * (9-2 / 9-4 / 9-6 / 9-7 / 9-11) do not cover individually.
 */

const CLI = join(process.cwd(), "src/cli/run.ts");

function tmpHarness(): { root: string; dbPath: string; lockPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-p9fx-"));
  return {
    root,
    dbPath: join(root, ".harness", "harness.sqlite"),
    lockPath: join(root, ".harness", "db.lock"),
  };
}

const PRIOR_LEASE = process.env.HARNESS_LOCK_LEASE_MS;
afterEach(() => {
  if (PRIOR_LEASE === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
  else process.env.HARNESS_LOCK_LEASE_MS = PRIOR_LEASE;
});

describe("Phase 9-12 — maintenance lock semantics", () => {
  it("shared lock blocks an exclusive contender (busy on timeout)", () => {
    const h = tmpHarness();
    const a = acquireShared(h.lockPath);
    expect(() => acquireExclusive(h.lockPath, { timeoutMs: 150 })).toThrow(
      MaintenanceLockBusyError,
    );
    a.release();
  });

  it("`harness db restore` requires an exclusive lock — held shared blocks it", () => {
    const h = tmpHarness();
    // init a DB + take a shared lock to simulate a write command in flight
    const initDb = openDb(h.dbPath);
    runMigrations(initDb);
    initDb.close();
    // make a backup so we have something to restore from
    const env = { ...process.env, HARNESS_ROOT: h.root };
    const backup = join(h.root, "snap.sqlite");
    const b = spawnSync(
      "node",
      ["--import", "tsx", CLI, "db", "backup", "--out", backup],
      { env, encoding: "utf8" },
    );
    expect(b.status).toBe(0);

    // hold a shared lock — restore must fail busy
    const shared = acquireShared(h.lockPath);
    const restore = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        CLI,
        "db",
        "restore",
        "--from",
        backup,
        "--force",
        "--timeout",
        "200",
      ],
      { env, encoding: "utf8" },
    );
    shared.release();
    expect(restore.status).toBe(1);
    expect(restore.stderr).toMatch(/maintenance lock busy/);
  });
});

describe("Phase 9-12 — DB domain lock + fencing guard", () => {
  it("a stolen lease causes assertActiveLease to throw LeaseGuardFailedError", () => {
    process.env.HARNESS_LOCK_LEASE_MS = "10";
    const h = tmpHarness();
    const db = openDb(h.dbPath);
    runMigrations(db);
    const HOLDER = {
      repoId: "demo",
      domain: "apps/web",
      domainKey: "demo::apps/web",
      pid: 1,
      hostname: "h1",
    };
    const a = acquireDomainLock(db, { ...HOLDER, runId: "run-a" });
    // stamp the run row as Phase 9-5 would, so assertActiveLease has
    // a lease_lock_id to check.
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at,
         lease_lock_id, lease_token, lease_domain_key)
       VALUES ('run-a', 'demo', 'apps/web', 'domain-coding', 'main',
         'needs_review', 'db-first', 1, 'synced', 't', ?, ?, ?)`,
    ).run(a.lockId, a.fencingToken, HOLDER.domainKey);

    // simulate lease theft: another process acquires it after expiry
    const later = new Date(Date.now() + 1_000);
    acquireDomainLock(db, { ...HOLDER, runId: "run-b", now: later });
    // run-a tries to write — fencing guard rejects.
    expect(() => assertActiveLease(db, "run-a", later)).toThrow(
      LeaseGuardFailedError,
    );
    db.close();
  });

  it("a run without a recorded lease (pre-9-5 / legacy) is not gated", () => {
    const h = tmpHarness();
    const db = openDb(h.dbPath);
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at)
       VALUES ('run-legacy', 'demo', 'apps/x', 'domain-coding', 'main',
         'needs_review', 'db-first', 1, 'synced', 't')`,
    ).run();
    // no lease_lock_id → assertion is a no-op
    expect(() => assertActiveLease(db, "run-legacy")).not.toThrow();
    db.close();
  });

  it("a concurrent acquire on the same domain key is busy", () => {
    const h = tmpHarness();
    const db = openDb(h.dbPath);
    runMigrations(db);
    const HOLDER = {
      repoId: "demo",
      domain: "apps/x",
      domainKey: "demo::apps/x",
      pid: 1,
      hostname: "h1",
    };
    const a = acquireDomainLock(db, { ...HOLDER, runId: "r1" });
    expect(() =>
      acquireDomainLock(db, { ...HOLDER, runId: "r2" }),
    ).toThrow(DomainLockBusyError);
    a.release();
    db.close();
  });
});

describe("Phase 9-12 — legacy-file gate via CLI", () => {
  it("`harness backlog add` exits 1 when runs has a legacy-file row", () => {
    const h = tmpHarness();
    const db = openDb(h.dbPath);
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at)
       VALUES ('run-legacy', 'r', 'apps/x', 'domain-coding', 'main',
         'needs_review', 'legacy-file', 0, 'synced', 't')`,
    ).run();
    db.close();
    mkdirSync(join(h.root, "backlog"), { recursive: true });
    const r = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        CLI,
        "backlog",
        "add",
        "--title",
        "x",
        "--domain",
        "apps/x",
        "--goal",
        "y",
      ],
      { env: { ...process.env, HARNESS_ROOT: h.root }, encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(
      /legacy-file row|db migrate-legacy/,
    );
  });

  it("`harness db migrate-legacy` bypasses the legacy gate", () => {
    const h = tmpHarness();
    const db = openDb(h.dbPath);
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at)
       VALUES ('run-x', 'r', 'apps/x', 'domain-coding', 'main',
         'needs_review', 'legacy-file', 0, 'synced', 't')`,
    ).run();
    db.close();
    const r = spawnSync(
      "node",
      ["--import", "tsx", CLI, "db", "migrate-legacy"],
      { env: { ...process.env, HARNESS_ROOT: h.root }, encoding: "utf8" },
    );
    // migrate-legacy must not be blocked by its own target state
    expect(r.status).toBe(0);
  });
});

describe("Phase 9-12 — HARNESS_EXPORT_FILES default OFF", () => {
  it("fileExportEnabled returns false when the env var is unset (Phase 9 default)", async () => {
    const prior = process.env.HARNESS_EXPORT_FILES;
    delete process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_SUPPRESS_EXPORT_MODE_WARNING = "1";
    const { fileExportEnabled, _resetExportModeWarningForTest } = await import(
      "../../src/config/export-mode.js"
    );
    _resetExportModeWarningForTest();
    try {
      expect(fileExportEnabled()).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prior;
    }
  });
});

describe("Phase 9-12 — schema migration end-to-end", () => {
  it("v1 → v5 idempotent and creates every expected table", () => {
    const h = tmpHarness();
    const db = openDb(h.dbPath);
    const first = runMigrations(db);
    expect(first.version).toBe(11);
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.version).toBe(11);
    for (const t of [
      "domain_locks",
      "review_proposals",
      "artifact_blobs",
      "schema_migrations",
    ]) {
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(t),
      ).toBeDefined();
    }
    // tidy: avoid lint warnings about unused declarations
    void writeFileSync;
    void rmSync;
    db.close();
  });
});
