import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openDbReadonly, DbError } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";
import {
  backupDb,
  restoreDb,
  checkpointDb,
  vacuumDb,
  dbStats,
} from "../../src/db/maintenance.js";

let seq = 0;

/** A fresh DB at schema v4 with one runs row, returns its path + root. */
function freshDb(): { dbPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), `harness-maint-${seq++}-`));
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  try {
    runMigrations(db);
  } finally {
    db.close();
  }
  return { dbPath, root };
}

function insertRun(dbPath: string, runId: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, updated_at)
       VALUES (?, 'repo', 'apps/x', 'domain-coding', 'main', 'needs_review',
         '2026-05-22T00:00:00Z')`,
    ).run(runId);
  } finally {
    db.close();
  }
}

function runCount(dbPath: string): number {
  const db = openDbReadonly(dbPath);
  try {
    return (db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number })
      .n;
  } finally {
    db.close();
  }
}

describe("db maintenance — backup / restore", () => {
  it("backup produces a standalone copy at the same schema version", async () => {
    const { dbPath, root } = freshDb();
    insertRun(dbPath, "run-a");
    const out = join(root, "backup.sqlite");
    const r = await backupDb({ dbPath, outPath: out });
    expect(r.schemaVersion).toBe(11);
    expect(r.bytes).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(true);
    // the backup is a real DB and carries the row
    expect(runCount(out)).toBe(1);
  });

  it("backup refuses a missing DB and an existing target", async () => {
    const { dbPath, root } = freshDb();
    await expect(
      backupDb({ dbPath: join(root, "nope.sqlite"), outPath: join(root, "b") }),
    ).rejects.toBeInstanceOf(DbError);
    const out = join(root, "exists.sqlite");
    writeFileSync(out, "");
    await expect(backupDb({ dbPath, outPath: out })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it("restore round-trips: a mutation after backup is rolled back", async () => {
    const { dbPath, root } = freshDb();
    insertRun(dbPath, "run-a");
    const out = join(root, "backup.sqlite");
    await backupDb({ dbPath, outPath: out });
    // mutate the live DB after the backup was taken
    insertRun(dbPath, "run-b");
    expect(runCount(dbPath)).toBe(2);
    const r = await restoreDb({ dbPath, fromPath: out });
    expect(r.schemaVersion).toBe(11);
    // the post-backup row is gone — restore replaced the live DB
    expect(runCount(dbPath)).toBe(1);
  });

  it("restore drops a stale WAL sidecar so no journal survives", async () => {
    const { dbPath, root } = freshDb();
    insertRun(dbPath, "run-a");
    const out = join(root, "backup.sqlite");
    await backupDb({ dbPath, outPath: out });
    // a WAL file exists from the writes above; restore must remove it
    writeFileSync(`${dbPath}-wal`, "stale-journal");
    await restoreDb({ dbPath, fromPath: out });
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(runCount(dbPath)).toBe(1);
  });

  it("restore rejects a file that is not a SQLite DB", async () => {
    const { dbPath, root } = freshDb();
    const garbage = join(root, "garbage.bin");
    writeFileSync(garbage, "not a database");
    await expect(
      restoreDb({ dbPath, fromPath: garbage }),
    ).rejects.toThrow(DbError);
    // the live DB is untouched
    expect(existsSync(dbPath)).toBe(true);
    expect(runCount(dbPath)).toBe(0);
  });

  it("restore rejects a valid SQLite that is not a harness DB", async () => {
    const { dbPath, root } = freshDb();
    insertRun(dbPath, "run-a");
    // a real SQLite file, but with no harness schema
    const foreign = join(root, "foreign.sqlite");
    const fdb = openDb(foreign);
    try {
      fdb.prepare("CREATE TABLE unrelated (x INTEGER)").run();
    } finally {
      fdb.close();
    }
    await expect(
      restoreDb({ dbPath, fromPath: foreign }),
    ).rejects.toThrow(DbError);
    // the live DB and its data survive the rejected restore
    expect(runCount(dbPath)).toBe(1);
  });

  it("restore rejects restoring the live DB onto itself", async () => {
    const { dbPath } = freshDb();
    await expect(
      restoreDb({ dbPath, fromPath: dbPath }),
    ).rejects.toThrow(DbError);
  });

  it("restore reads a source whose data is still in a live WAL", async () => {
    const { dbPath } = freshDb();
    // a separate source DB whose row sits in an un-checkpointed WAL —
    // the source connection is kept open so the WAL is not flushed.
    const srcRoot = mkdtempSync(join(tmpdir(), "harness-maint-src-"));
    const srcPath = join(srcRoot, "live.sqlite");
    const srcDb = openDb(srcPath);
    try {
      runMigrations(srcDb);
      srcDb
        .prepare(
          `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
             status, updated_at)
           VALUES ('run-wal', 'repo', 'apps/x', 'domain-coding', 'main',
             'needs_review', '2026-05-22T00:00:00Z')`,
        )
        .run();
      expect(existsSync(`${srcPath}-wal`)).toBe(true);
      const r = await restoreDb({ dbPath, fromPath: srcPath });
      expect(r.schemaVersion).toBe(11);
      // the row living in the source WAL must not be lost by the restore
      expect(runCount(dbPath)).toBe(1);
    } finally {
      srcDb.close();
    }
  });
});

describe("db maintenance — checkpoint / vacuum / stats", () => {
  it("checkpoint truncates the WAL file", () => {
    const { dbPath } = freshDb();
    for (let i = 0; i < 50; i++) insertRun(dbPath, `run-${i}`);
    const r = checkpointDb(dbPath);
    expect(r.walBytesAfter).toBeLessThanOrEqual(r.walBytesBefore);
    expect(r.walBytesAfter).toBe(0);
  });

  it("vacuum keeps the data and does not grow the file", () => {
    const { dbPath } = freshDb();
    for (let i = 0; i < 50; i++) insertRun(dbPath, `run-${i}`);
    const db = openDb(dbPath);
    try {
      db.prepare("DELETE FROM runs").run();
    } finally {
      db.close();
    }
    const r = vacuumDb(dbPath);
    expect(r.bytesAfter).toBeLessThanOrEqual(r.bytesBefore);
    expect(runCount(dbPath)).toBe(0);
  });

  it("stats reports table rows, blob totals and DB size", () => {
    const { dbPath } = freshDb();
    insertRun(dbPath, "run-a");
    const db = openDb(dbPath);
    try {
      storeArtifactBlob(db, Buffer.from("hello artifact body"));
    } finally {
      db.close();
    }
    const s = dbStats(dbPath);
    expect(s.schemaVersion).toBe(11);
    expect(s.dbBytes).toBeGreaterThan(0);
    expect(s.tableRows.runs).toBe(1);
    expect(s.totalRows).toBeGreaterThanOrEqual(1);
    expect(s.blobs.count).toBe(1);
    expect(s.blobs.rawBytes).toBe("hello artifact body".length);
    expect(s.blobs.chunkCount).toBeGreaterThanOrEqual(1);
  });

  it("stats / checkpoint / vacuum reject an uninitialized DB", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-maint-noinit-"));
    const dbPath = join(root, ".harness", "harness.sqlite");
    expect(() => dbStats(dbPath)).toThrow(DbError);
    expect(() => checkpointDb(dbPath)).toThrow(DbError);
    expect(() => vacuumDb(dbPath)).toThrow(DbError);
  });
});

describe("db maintenance — file permissions", () => {
  it("openDb restricts harness.sqlite to 0600", () => {
    // POSIX modes only — skip where chmod has no effect.
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "harness-maint-perm-"));
    const dbPath = join(root, ".harness", "harness.sqlite");
    mkdirSync(join(root, ".harness"), { recursive: true });
    const db = openDb(dbPath);
    db.close();
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it("backup output is restricted to 0600", async () => {
    if (process.platform === "win32") return;
    const { dbPath, root } = freshDb();
    const out = join(root, "backup.sqlite");
    await backupDb({ dbPath, outPath: out });
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
});
