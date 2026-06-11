import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { harnessPaths } from "../../../src/config/paths.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { deferFindingToBacklog } from "../../../src/hitch/followups.js";
import { HitchRepository } from "../../../src/hitch/repository.js";

function setup(): {
  root: string;
  db: ReturnType<typeof openDb>;
  repo: HitchRepository;
} {
  const root = mkdtempSync(join(tmpdir(), "harness-goal-followup-"));
  const paths = harnessPaths(root);
  const db = openDb(paths.dbPath);
  runMigrations(db);
  return { root, db, repo: new HitchRepository(db) };
}

describe("goal follow-up deferral", () => {
  it("creates a backlog item and links it to the deferred finding", async () => {
    const { root, db, repo } = setup();
    try {
      const paths = harnessPaths(root);
      const goal = repo.createSession({
        hitchId: "goal-followup",
        title: "Fix MCP confirmation safety",
        projectId: "monorepo-harness",
        domain: "mcp",
        scope: {
          targetFiles: ["src/mcp/**"],
          excludedCategories: ["future-feature"],
        },
        createdBy: "test",
        createdSource: "cli",
      });
      const finding = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P2",
        category: "future-feature",
        scopeStatus: "out_of_scope",
        summary: "Add dashboard controls for goal sessions",
        detail: "Useful after the current MCP safety phase ships.",
        filePath: "src/dashboard/view.ts",
      }).finding;

      const result = await deferFindingToBacklog({
        repository: repo,
        findingId: finding.findingId,
        reason: "future dashboard UI improvement",
        backlogContext: {
          backlogDir: paths.backlogDir,
          dbPath: paths.dbPath,
        },
        now: new Date("2026-05-26T03:00:00.000Z"),
      });

      expect(result.createdBacklogItem).toBe(true);
      expect(result.backlogItemId).toBe("item-20260526-001");
      expect(result.finding.lifecycleStatus).toBe("deferred");
      expect(result.finding.deferredBacklogItemId).toBe("item-20260526-001");
      expect(result.backlogItem?.priority).toBe("medium");
      expect(result.backlogItem?.tags).toContain("hitch-finding");
      expect(result.backlogItem?.tags).toContain("hitch:goal-followup");
      expect(result.backlogItem?.goal).toContain("source: hitch-finding");
      expect(result.backlogItem?.goal).toContain(
        `findingId: ${finding.findingId}`,
      );

      const row = db
        .prepare("SELECT * FROM backlog_items WHERE item_id = ?")
        .get("item-20260526-001") as Record<string, unknown>;
      expect(row.status).toBe("open");
      expect(row.source_mode).toBe("db-first");

      const yamlPath = join(
        paths.backlogDir,
        "open",
        "item-20260526-001.yaml",
      );
      expect(existsSync(yamlPath)).toBe(true);
      const yaml = parseYaml(readFileSync(yamlPath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(yaml.title).toBe(
        "Follow-up: Add dashboard controls for goal sessions",
      );
    } finally {
      db.close();
    }
  });

  it("does not create a second backlog item for an already linked finding", async () => {
    const { root, db, repo } = setup();
    try {
      const paths = harnessPaths(root);
      const goal = repo.createSession({
        hitchId: "goal-followup",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        createdBy: "test",
        createdSource: "cli",
      });
      const findingId = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P1",
        category: "future-feature",
        scopeStatus: "out_of_scope",
        summary: "Add future project template",
      }).finding.findingId;

      const first = await deferFindingToBacklog({
        repository: repo,
        findingId,
        reason: "future project template",
        backlogContext: {
          backlogDir: paths.backlogDir,
          dbPath: paths.dbPath,
        },
        now: new Date("2026-05-26T04:00:00.000Z"),
      });
      expect(first.createdBacklogItem).toBe(true);

      const result = await deferFindingToBacklog({
        repository: repo,
        findingId,
        reason: "do not duplicate",
        backlogContext: {
          backlogDir: paths.backlogDir,
          dbPath: paths.dbPath,
        },
        now: new Date("2026-05-26T04:05:00.000Z"),
      });

      expect(result.createdBacklogItem).toBe(false);
      expect(result.backlogItemId).toBe("item-20260526-001");
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM backlog_items")
          .get() as { count: number },
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects deferring findings that are not classified out of scope", async () => {
    const { root, db, repo } = setup();
    try {
      const paths = harnessPaths(root);
      const goal = repo.createSession({
        hitchId: "goal-followup",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        createdBy: "test",
        createdSource: "cli",
      });
      const unknown = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P2",
        category: "quality",
        scopeStatus: "unknown",
        summary: "Improve launch handoff",
      }).finding;
      const inScope = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "MCP confirmation bypass",
      }).finding;

      for (const finding of [unknown, inScope]) {
        await expect(
          deferFindingToBacklog({
            repository: repo,
            findingId: finding.findingId,
            reason: "should not bypass convergence",
            backlogContext: {
              backlogDir: paths.backlogDir,
              dbPath: paths.dbPath,
            },
            now: new Date("2026-05-26T05:00:00.000Z"),
          }),
        ).rejects.toThrow(/classify it out_of_scope first/);
      }
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM backlog_items")
          .get() as { count: number },
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("surfaces a broken deferred backlog link instead of trusting it", async () => {
    const { root, db, repo } = setup();
    try {
      const paths = harnessPaths(root);
      const goal = repo.createSession({
        hitchId: "goal-followup",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        createdBy: "test",
        createdSource: "cli",
      });
      const finding = repo.deferFinding({
        findingId: repo.upsertFinding({
          hitchId: goal.hitchId,
          source: "review",
          severity: "P2",
          category: "future-feature",
          scopeStatus: "out_of_scope",
          summary: "Add future project template",
        }).finding.findingId,
        backlogItemId: "item-20260526-999",
        note: "missing link",
      });

      await expect(
        deferFindingToBacklog({
          repository: repo,
          findingId: finding.findingId,
          reason: "verify link",
          backlogContext: {
            backlogDir: paths.backlogDir,
            dbPath: paths.dbPath,
          },
          now: new Date("2026-05-26T06:00:00.000Z"),
        }),
      ).rejects.toThrow(/missing from backlog_items/);
    } finally {
      db.close();
    }
  });
});
