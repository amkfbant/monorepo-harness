import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  addBacklogItem,
  transitionBacklogItem,
  linkBacklogRun,
  resolveBacklogItemForRun,
  type BacklogDbContext,
} from "../../../src/core/backlog-db.js";
import { addItem } from "../../../src/core/backlog.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { runFullImport } from "../../../src/db/import-files.js";
import { importBacklog } from "../../../src/db/import/backlog.js";
import { emptyCounters } from "../../../src/db/import/common.js";
import { StateConflictError } from "../../../src/db/errors.js";

/**
 * Phase 7-8 — backlog DB-first write path: add / done / defer / run go
 * through the DB and export YAML, legacy items keep the file path, and a
 * re-import never demigrates a db-first row.
 */

function setup(): BacklogDbContext {
  const root = mkdtempSync(join(tmpdir(), "harness-bldb-"));
  return {
    backlogDir: join(root, "backlog"),
    dbPath: join(root, ".harness", "harness.sqlite"),
  };
}

/** The harness root for a context — `backlogDir` is `<root>/backlog`. */
function rootOf(ctx: BacklogDbContext): string {
  return join(ctx.backlogDir, "..");
}

const NOW = new Date("2026-05-22T00:00:00.000Z");

function itemRow(ctx: BacklogDbContext, itemId: string): Record<string, unknown> {
  const db = openDb(ctx.dbPath);
  runMigrations(db);
  const row = db
    .prepare("SELECT * FROM backlog_items WHERE item_id = ?")
    .get(itemId) as Record<string, unknown>;
  db.close();
  return row;
}

function yamlAt(
  ctx: BacklogDbContext,
  status: string,
  itemId: string,
): Record<string, unknown> {
  const path = join(ctx.backlogDir, status, `${itemId}.yaml`);
  return parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("backlog DB-first", () => {
  it("add writes a db-first row and exports backlog/open/<id>.yaml", async () => {
    const ctx = setup();
    const { item, exportWarning } = await addBacklogItem(
      ctx,
      { title: "validate orders", domain: "apps/orders", goal: "do x" },
      NOW,
    );
    expect(item.id).toBe("item-20260522-001");
    expect(item.status).toBe("open");
    expect(exportWarning).toBeUndefined();

    const row = itemRow(ctx, item.id);
    expect(row.source_mode).toBe("db-first");
    expect(row.status).toBe("open");

    // the YAML export matches the DB row
    const yaml = yamlAt(ctx, "open", item.id);
    expect(yaml.id).toBe(item.id);
    expect(yaml.title).toBe("validate orders");
    expect(yaml.domain).toBe("apps/orders");
    expect(yaml.status).toBe("open");
  });

  it("add rejects empty required fields", async () => {
    const ctx = setup();
    await expect(
      addBacklogItem(ctx, { title: " ", domain: "d", goal: "g" }, NOW),
    ).rejects.toThrow(/--title is required/);
  });

  it("done moves the item and its YAML to backlog/done/", async () => {
    const ctx = setup();
    const { item } = await addBacklogItem(
      ctx,
      { title: "t", domain: "d", goal: "g" },
      NOW,
    );
    const { item: done } = await transitionBacklogItem(ctx, item.id, "done");
    expect(done.status).toBe("done");
    expect(itemRow(ctx, item.id).status).toBe("done");
    expect(
      existsSync(join(ctx.backlogDir, "open", `${item.id}.yaml`)),
    ).toBe(false);
    expect(yamlAt(ctx, "done", item.id).status).toBe("done");
  });

  it("defer moves the item to backlog/deferred/", async () => {
    const ctx = setup();
    const { item } = await addBacklogItem(
      ctx,
      { title: "t", domain: "d", goal: "g" },
      NOW,
    );
    const { item: deferred } = await transitionBacklogItem(
      ctx,
      item.id,
      "deferred",
    );
    expect(deferred.status).toBe("deferred");
    expect(yamlAt(ctx, "deferred", item.id).status).toBe("deferred");
  });

  it("defer of a done item is a guarded StateConflictError", async () => {
    const ctx = setup();
    const { item } = await addBacklogItem(
      ctx,
      { title: "t", domain: "d", goal: "g" },
      NOW,
    );
    await transitionBacklogItem(ctx, item.id, "done");
    await expect(
      transitionBacklogItem(ctx, item.id, "deferred"),
    ).rejects.toThrow(StateConflictError);
  });

  it("run links a run, moves the item to doing, and re-exports", async () => {
    const ctx = setup();
    const { item } = await addBacklogItem(
      ctx,
      { title: "t", domain: "d", goal: "g" },
      NOW,
    );
    const runId = "run-20260522-d-bl1";
    const { item: linked } = await linkBacklogRun(ctx, item.id, runId);
    expect(linked.status).toBe("doing");
    expect(linked.linkedRuns).toEqual([runId]);
    expect(itemRow(ctx, item.id).status).toBe("doing");
    expect(yamlAt(ctx, "doing", item.id).linkedRuns).toEqual([runId]);
  });

  it("run rejects an invalid runId", async () => {
    const ctx = setup();
    const { item } = await addBacklogItem(
      ctx,
      { title: "t", domain: "d", goal: "g" },
      NOW,
    );
    await expect(
      linkBacklogRun(ctx, item.id, "../escape"),
    ).rejects.toThrow(/invalid runId/);
  });

  it("reports an exportWarning when the file export fails", async () => {
    const ctx = setup();
    // make backlog/open a regular file so the export dir cannot be created
    mkdirSync(ctx.backlogDir, { recursive: true });
    writeFileSync(join(ctx.backlogDir, "open"), "blocker\n");

    const { item, exportWarning } = await addBacklogItem(
      ctx,
      { title: "t", domain: "d", goal: "g" },
      NOW,
    );
    // the DB write still succeeded — only the export failed
    expect(itemRow(ctx, item.id).source_mode).toBe("db-first");
    expect(exportWarning).toMatch(/export.*failed/i);
  });

  it("exported YAML round-trips: importBacklog skips the db-first row", async () => {
    const ctx = setup();
    const { item } = await addBacklogItem(
      ctx,
      {
        title: "t",
        domain: "apps/web",
        goal: "g",
        priority: "high",
        tags: ["a", "b"],
      },
      NOW,
    );
    await transitionBacklogItem(ctx, item.id, "done");

    const before = itemRow(ctx, item.id);
    const db = openDb(ctx.dbPath);
    runMigrations(db);
    importBacklog(db, ctx.backlogDir, emptyCounters());
    const after = db
      .prepare("SELECT * FROM backlog_items WHERE item_id = ?")
      .get(item.id) as Record<string, unknown>;
    db.close();

    // a db-first row is canonical — re-import must not touch it
    expect(after.status).toBe(before.status);
    expect(after.priority).toBe(before.priority);
    expect(after.tags_json).toBe(before.tags_json);
    expect(after.source_mode).toBe("db-first");
    expect(after.db_revision).toBe(before.db_revision);
  });

  it("a --reset full import preserves the db-first row", async () => {
    const ctx = setup();
    const { item } = await addBacklogItem(
      ctx,
      { title: "t", domain: "d", goal: "g" },
      NOW,
    );
    await linkBacklogRun(ctx, item.id, "run-20260522-d-bl1");

    const db = openDb(ctx.dbPath);
    runMigrations(db);
    // a reset import — as every read-only scoped command performs — must
    // not demigrate the db-first item back to legacy-file
    runFullImport(db, { harnessRoot: rootOf(ctx), reset: true });
    const row = db
      .prepare("SELECT source_mode, status FROM backlog_items WHERE item_id = ?")
      .get(item.id) as { source_mode: string; status: string } | undefined;
    const links = db
      .prepare("SELECT run_id FROM backlog_run_links WHERE item_id = ?")
      .all(item.id) as { run_id: string }[];
    db.close();
    expect(row?.source_mode).toBe("db-first");
    expect(row?.status).toBe("doing");
    expect(links.map((l) => l.run_id)).toEqual(["run-20260522-d-bl1"]);
  });

  it("resolveBacklogItemForRun reads a db-first item from the DB row", async () => {
    const ctx = setup();
    const { item } = await addBacklogItem(
      ctx,
      { title: "t", domain: "apps/web", goal: "g" },
      NOW,
    );
    // corrupt the exported YAML — the resolver must ignore it for db-first
    writeFileSync(
      join(ctx.backlogDir, "open", `${item.id}.yaml`),
      "id: tampered\ntitle: tampered\n",
    );
    const resolved = await resolveBacklogItemForRun(ctx, item.id);
    expect(resolved.id).toBe(item.id);
    expect(resolved.title).toBe("t");
    expect(resolved.domain).toBe("apps/web");
  });

  it("resolveBacklogItemForRun reads a legacy item from its file", async () => {
    const ctx = setup();
    const legacy = await addItem(
      ctx.backlogDir,
      { title: "legacy", domain: "d", goal: "g" },
      NOW,
    );
    const resolved = await resolveBacklogItemForRun(ctx, legacy.id);
    expect(resolved.id).toBe(legacy.id);
    expect(resolved.title).toBe("legacy");
  });

  it("done routes a legacy-file item (not in the DB) through the file path", async () => {
    const ctx = setup();
    // a pre-Phase-7 item: file only, no DB row
    const legacy = await addItem(
      ctx.backlogDir,
      { title: "legacy", domain: "d", goal: "g" },
      NOW,
    );
    const { item: done } = await transitionBacklogItem(ctx, legacy.id, "done");
    expect(done.status).toBe("done");
    expect(existsSync(join(ctx.backlogDir, "done", `${legacy.id}.yaml`))).toBe(
      true,
    );
    // the legacy path does not create a DB row
    const db = openDb(ctx.dbPath);
    runMigrations(db);
    const row = db
      .prepare("SELECT item_id FROM backlog_items WHERE item_id = ?")
      .get(legacy.id);
    db.close();
    expect(row).toBeUndefined();
  });

  it("done routes a legacy-file DB row through the file path", async () => {
    const ctx = setup();
    const legacy = await addItem(
      ctx.backlogDir,
      { title: "legacy", domain: "d", goal: "g" },
      NOW,
    );
    // seed a legacy-file DB row (as Phase 6 `db import` would)
    const db = openDb(ctx.dbPath);
    runMigrations(db);
    db.prepare(
      `INSERT INTO backlog_items (item_id, domain, title, goal, status,
         priority, tags_json, created_at, source_mode, db_revision)
       VALUES (?, 'd', 'legacy', 'g', 'open', 'medium', '[]',
         '2026-05-22T00:00:00.000Z', 'legacy-file', 0)`,
    ).run(legacy.id);
    db.close();

    await transitionBacklogItem(ctx, legacy.id, "done");
    // the file moved, but the legacy-file DB row was NOT mutated
    expect(existsSync(join(ctx.backlogDir, "done", `${legacy.id}.yaml`))).toBe(
      true,
    );
    expect(itemRow(ctx, legacy.id).status).toBe("open");
    expect(itemRow(ctx, legacy.id).source_mode).toBe("legacy-file");
  });
});
