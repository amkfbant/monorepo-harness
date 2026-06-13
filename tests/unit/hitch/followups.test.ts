import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

  it("classifies and defers an in-scope finding when requested", async () => {
    const { db, repo } = setup();
    try {
      const goal = repo.createSession({
        hitchId: "goal-followup",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        createdBy: "test",
        createdSource: "cli",
      });
      const finding = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Document a process-only advisory",
      }).finding;

      const result = await deferFindingToBacklog({
        repository: repo,
        findingId: finding.findingId,
        reason: "operator confirmed this is process-only",
        classifyOutOfScope: true,
        createBacklogItem: false,
        now: new Date("2026-05-26T07:00:00.000Z"),
      });

      expect(result.createdBacklogItem).toBe(false);
      expect(result.backlogItemId).toBeNull();
      expect(result.finding.scopeStatus).toBe("out_of_scope");
      expect(result.finding.lifecycleStatus).toBe("deferred");
      expect(result.finding.classificationReason).toBe(
        "operator confirmed this is process-only",
      );
      expect(result.finding.resolutionNote).toBe(
        "operator confirmed this is process-only",
      );
    } finally {
      db.close();
    }
  });

  it("creates a backlog item while classifying an in-scope finding out of scope", async () => {
    const { root, db, repo } = setup();
    try {
      const paths = harnessPaths(root);
      const goal = repo.createSession({
        hitchId: "goal-followup",
        title: "Fix MCP confirmation safety",
        projectId: "monorepo-harness",
        domain: "mcp",
        createdBy: "test",
        createdSource: "cli",
      });
      const finding = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Track future reviewer advisory automation",
      }).finding;

      const result = await deferFindingToBacklog({
        repository: repo,
        findingId: finding.findingId,
        reason: "operator confirmed future follow-up",
        classifyOutOfScope: true,
        createBacklogItem: true,
        backlogContext: {
          backlogDir: paths.backlogDir,
          dbPath: paths.dbPath,
        },
        now: new Date("2026-05-26T08:00:00.000Z"),
      });

      expect(result.createdBacklogItem).toBe(true);
      expect(result.backlogItemId).toBe("item-20260526-001");
      expect(result.finding.scopeStatus).toBe("out_of_scope");
      expect(result.finding.lifecycleStatus).toBe("deferred");
      expect(result.finding.deferredBacklogItemId).toBe("item-20260526-001");
      expect(result.backlogItem?.tags).toContain("scope:out_of_scope");
      expect(
        db
          .prepare("SELECT source_mode FROM backlog_items WHERE item_id = ?")
          .get("item-20260526-001") as { source_mode: string },
      ).toEqual({ source_mode: "db-first" });
    } finally {
      db.close();
    }
  });

  it("rolls back classification and backlog insert when the deferred update fails", async () => {
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
      const finding = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Track rollback on defer failure",
      }).finding;
      db.prepare(
        `CREATE TRIGGER fail_hitch_defer
         BEFORE UPDATE OF lifecycle_status ON hitch_findings
         WHEN NEW.lifecycle_status = 'deferred'
         BEGIN
           SELECT RAISE(ABORT, 'defer blocked');
         END`,
      ).run();

      await expect(
        deferFindingToBacklog({
          repository: repo,
          findingId: finding.findingId,
          reason: "operator confirmed future follow-up",
          classifyOutOfScope: true,
          createBacklogItem: true,
          backlogContext: {
            backlogDir: paths.backlogDir,
            dbPath: paths.dbPath,
          },
          now: new Date("2026-05-26T09:00:00.000Z"),
        }),
      ).rejects.toThrow(/defer blocked/);

      expect(repo.requireFinding(finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        classificationReason: null,
        deferredBacklogItemId: null,
      });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM backlog_items")
          .get() as { count: number },
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rolls back classification when the backlog insert (mid-transaction) fails", async () => {
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
      const finding = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Track rollback on backlog insert failure",
      }).finding;
      // abort the middle step (the backlog row insert) — classification must
      // not survive and no finding lifecycle change may leak.
      db.prepare(
        `CREATE TRIGGER fail_backlog_insert
         BEFORE INSERT ON backlog_items
         BEGIN
           SELECT RAISE(ABORT, 'backlog insert blocked');
         END`,
      ).run();

      await expect(
        deferFindingToBacklog({
          repository: repo,
          findingId: finding.findingId,
          reason: "operator confirmed future follow-up",
          classifyOutOfScope: true,
          createBacklogItem: true,
          backlogContext: {
            backlogDir: paths.backlogDir,
            dbPath: paths.dbPath,
          },
          now: new Date("2026-05-26T09:00:00.000Z"),
        }),
      ).rejects.toThrow(/backlog insert blocked/);

      expect(repo.requireFinding(finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        classificationReason: null,
        deferredBacklogItemId: null,
      });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM backlog_items")
          .get() as { count: number },
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("commits the DB state and returns a warning when backlog export fails", async () => {
    const { root, db, repo } = setup();
    try {
      const paths = harnessPaths(root);
      mkdirSync(paths.backlogDir, { recursive: true });
      writeFileSync(join(paths.backlogDir, "open"), "blocker\n");
      const goal = repo.createSession({
        hitchId: "goal-followup",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        createdBy: "test",
        createdSource: "cli",
      });
      const finding = repo.upsertFinding({
        hitchId: goal.hitchId,
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Track export warning behavior",
      }).finding;

      const result = await deferFindingToBacklog({
        repository: repo,
        findingId: finding.findingId,
        reason: "operator confirmed future follow-up",
        classifyOutOfScope: true,
        createBacklogItem: true,
        backlogContext: {
          backlogDir: paths.backlogDir,
          dbPath: paths.dbPath,
        },
        now: new Date("2026-05-26T10:00:00.000Z"),
      });

      expect(result.exportWarning).toMatch(/exporting .* failed/i);
      expect(repo.requireFinding(finding.findingId)).toMatchObject({
        scopeStatus: "out_of_scope",
        lifecycleStatus: "deferred",
        deferredBacklogItemId: "item-20260526-001",
      });
      expect(
        db
          .prepare("SELECT status FROM backlog_items WHERE item_id = ?")
          .get("item-20260526-001") as { status: string },
      ).toEqual({ status: "open" });
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
