import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { openDb, DbError } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { exportBacklogItem } from "../../../src/db/export-files.js";

/**
 * Phase 7-8 — `exportBacklogItem`: the DB-canonical backlog item is
 * exported to `backlog/<status>/<id>.yaml`, a status change moves the
 * file, and the outcome is tracked in the export bookkeeping tables.
 */

function setup(): { db: Database.Database; backlogDir: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-bl-export-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, backlogDir: join(root, "backlog") };
}

function seed(db: Database.Database, itemId: string, status: string): void {
  db.prepare(
    `INSERT INTO backlog_items (item_id, domain, title, goal, status, priority,
       tags_json, created_at, source_mode, db_revision, export_status)
     VALUES (?, 'apps/web', 't', 'g', ?, 'medium', '["x"]',
       '2026-05-22T00:00:00.000Z', 'db-first', 1, 'dirty')`,
  ).run(itemId, status);
}

describe("exportBacklogItem", () => {
  it("exports the item to the dir for its status", () => {
    const { db, backlogDir } = setup();
    seed(db, "item-20260522-001", "open");
    const result = exportBacklogItem(db, "item-20260522-001", { backlogDir });
    expect(result.status).toBe("synced");
    expect(result.scopeType).toBe("backlog_item");

    const path = join(backlogDir, "open", "item-20260522-001.yaml");
    expect(existsSync(path)).toBe(true);
    const yaml = parseYaml(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(yaml.id).toBe("item-20260522-001");
    expect(yaml.status).toBe("open");
    expect(yaml.tags).toEqual(["x"]);
    db.close();
  });

  it("moves the YAML when the item's status changes", () => {
    const { db, backlogDir } = setup();
    seed(db, "item-20260522-001", "open");
    exportBacklogItem(db, "item-20260522-001", { backlogDir });
    expect(
      existsSync(join(backlogDir, "open", "item-20260522-001.yaml")),
    ).toBe(true);

    // the item is marked done — the export must move the file
    db.prepare(
      "UPDATE backlog_items SET status = 'done' WHERE item_id = ?",
    ).run("item-20260522-001");
    exportBacklogItem(db, "item-20260522-001", { backlogDir });
    expect(
      existsSync(join(backlogDir, "open", "item-20260522-001.yaml")),
    ).toBe(false);
    expect(
      existsSync(join(backlogDir, "done", "item-20260522-001.yaml")),
    ).toBe(true);
    db.close();
  });

  it("records the export in the bookkeeping tables", () => {
    const { db, backlogDir } = setup();
    seed(db, "item-20260522-001", "open");
    exportBacklogItem(db, "item-20260522-001", { backlogDir });

    const record = db
      .prepare(
        "SELECT status FROM export_records WHERE scope_type = 'backlog_item' AND scope_id = ?",
      )
      .get("item-20260522-001") as { status: string };
    expect(record.status).toBe("synced");

    const files = db
      .prepare(
        "SELECT relative_path FROM exported_files WHERE scope_type = 'backlog_item' AND scope_id = ?",
      )
      .all("item-20260522-001") as { relative_path: string }[];
    expect(files.map((f) => f.relative_path)).toEqual([
      join("open", "item-20260522-001.yaml"),
    ]);

    const row = db
      .prepare("SELECT export_status FROM backlog_items WHERE item_id = ?")
      .get("item-20260522-001") as { export_status: string };
    expect(row.export_status).toBe("synced");
    db.close();
  });

  it("records a failed export without throwing", () => {
    const { db, backlogDir } = setup();
    seed(db, "item-20260522-001", "open");
    // make backlog/open a regular file so the dir cannot be created
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(join(backlogDir, "open"), "blocker\n");

    const result = exportBacklogItem(db, "item-20260522-001", { backlogDir });
    expect(result.status).toBe("failed");
    const row = db
      .prepare("SELECT export_status FROM backlog_items WHERE item_id = ?")
      .get("item-20260522-001") as { export_status: string };
    expect(row.export_status).toBe("failed");
    db.close();
  });

  it("throws DbError for a missing item", () => {
    const { db, backlogDir } = setup();
    expect(() =>
      exportBacklogItem(db, "item-20260522-999", { backlogDir }),
    ).toThrow(DbError);
    db.close();
  });
});
