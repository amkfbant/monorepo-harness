import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addItem,
  listItems,
  showItem,
  setItemStatus,
  recordBacklogRun,
  findBacklogItemForRun,
  formatItem,
  formatItemList,
} from "../../src/core/backlog.js";

function harnessRoot(): { backlogDir: string; runsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-bl-"));
  return { backlogDir: join(root, "backlog"), runsDir: join(root, "runs") };
}

describe("backlog", () => {
  it("E4-3-1: add creates an item in open/ with a dated id", async () => {
    const { backlogDir } = harnessRoot();
    const item = await addItem(
      backlogDir,
      { title: "orders validation", domain: "apps/orders", goal: "do x" },
      new Date("2026-05-21T00:00:00Z"),
    );
    expect(item.id).toMatch(/^item-20260521-001$/);
    expect(item.status).toBe("open");
    expect(item.priority).toBe("medium");
    expect(existsSync(join(backlogDir, "open", `${item.id}.yaml`))).toBe(true);
  });

  it("allocates sequential ids within a day", async () => {
    const { backlogDir } = harnessRoot();
    const now = new Date("2026-05-21T00:00:00Z");
    const a = await addItem(backlogDir, { title: "a", domain: "d", goal: "g" }, now);
    const b = await addItem(backlogDir, { title: "b", domain: "d", goal: "g" }, now);
    expect(a.id).toBe("item-20260521-001");
    expect(b.id).toBe("item-20260521-002");
  });

  it("rejects an empty title / domain / goal", async () => {
    const { backlogDir } = harnessRoot();
    await expect(
      addItem(backlogDir, { title: "  ", domain: "d", goal: "g" }),
    ).rejects.toThrow(/--title is required/);
    await expect(
      addItem(backlogDir, { title: "t", domain: "", goal: "g" }),
    ).rejects.toThrow(/--domain is required/);
  });

  it("E4-3-1: list and show", async () => {
    const { backlogDir } = harnessRoot();
    const item = await addItem(backlogDir, {
      title: "t",
      domain: "apps/x",
      goal: "g",
      tags: ["validation"],
    });
    const items = await listItems(backlogDir);
    expect(items).toHaveLength(1);
    const shown = await showItem(backlogDir, item.id);
    expect(shown.title).toBe("t");
    expect(shown.tags).toEqual(["validation"]);
  });

  it("E4-3-3 / E4-3-5: done / defer move the item between status dirs", async () => {
    const { backlogDir } = harnessRoot();
    const now = new Date("2026-05-21T00:00:00Z");
    const a = await addItem(backlogDir, { title: "a", domain: "d", goal: "g" }, now);
    const b = await addItem(backlogDir, { title: "b", domain: "d", goal: "g" }, now);
    await setItemStatus(backlogDir, a.id, "done");
    await setItemStatus(backlogDir, b.id, "deferred");
    expect(existsSync(join(backlogDir, "open", `${a.id}.yaml`))).toBe(false);
    expect(existsSync(join(backlogDir, "done", `${a.id}.yaml`))).toBe(true);
    expect((await listItems(backlogDir, "done"))).toHaveLength(1);
    expect((await listItems(backlogDir, "deferred"))).toHaveLength(1);
    expect((await listItems(backlogDir, "open"))).toHaveLength(0);
  });

  it("E4-3-2 / E4-3-4: recordBacklogRun links a run; run is found by scan", async () => {
    const { backlogDir } = harnessRoot();
    const item = await addItem(backlogDir, {
      title: "t",
      domain: "apps/x",
      goal: "g",
    });
    const runId = "run-20260521-apps-x-bl1";
    const updated = await recordBacklogRun(backlogDir, item.id, runId);
    expect(updated.status).toBe("doing");
    expect(updated.linkedRuns).toEqual([runId]);
    // the item moved to doing/
    expect(existsSync(join(backlogDir, "doing", `${item.id}.yaml`))).toBe(true);
    expect(existsSync(join(backlogDir, "open", `${item.id}.yaml`))).toBe(false);
    // run show derives the item by scanning linkedRuns
    expect(await findBacklogItemForRun(backlogDir, runId)).toBe(item.id);
    expect(await findBacklogItemForRun(backlogDir, "run-unrelated")).toBeNull();
  });

  it("recordBacklogRun is idempotent on the same runId", async () => {
    const { backlogDir } = harnessRoot();
    const item = await addItem(backlogDir, {
      title: "t",
      domain: "apps/x",
      goal: "g",
    });
    const runId = "run-20260521-apps-x-bl2";
    await recordBacklogRun(backlogDir, item.id, runId);
    const again = await recordBacklogRun(backlogDir, item.id, runId);
    expect(again.linkedRuns).toEqual([runId]);
  });

  it("recordBacklogRun rejects an invalid runId", async () => {
    const { backlogDir } = harnessRoot();
    const item = await addItem(backlogDir, {
      title: "t",
      domain: "apps/x",
      goal: "g",
    });
    await expect(
      recordBacklogRun(backlogDir, item.id, "../escape"),
    ).rejects.toThrow(/invalid runId/);
  });

  it("errors on an unknown / invalid item id", async () => {
    const { backlogDir } = harnessRoot();
    await expect(showItem(backlogDir, "item-20260521-999")).rejects.toThrow(
      /not found/,
    );
    await expect(showItem(backlogDir, "../escape")).rejects.toThrow(
      /invalid backlog item id/,
    );
  });

  it("formatItem / formatItemList render readable output", async () => {
    const { backlogDir } = harnessRoot();
    const item = await addItem(backlogDir, {
      title: "render me",
      domain: "apps/x",
      goal: "g",
    });
    expect(formatItem(item)).toMatch(/Title: render me/);
    expect(formatItemList([item])).toMatch(/\[open\]/);
    expect(formatItemList([])).toMatch(/No backlog items/);
  });
});
