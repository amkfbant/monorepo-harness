import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordKnowledgeEntryRevision,
  getCurrentKnowledgeRevision,
  listKnowledgeRevisions,
} from "../../../src/db/repositories/knowledge-entry-revisions.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-kn-rev-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("knowledge_entry_revisions (Phase 14-4)", () => {
  it("v1 record + current pointer + entry row auto-create", () => {
    const db = freshDb();
    try {
      const r = recordKnowledgeEntryRevision(db, {
        entryId: "domain/cache",
        bodyMarkdown: "# Cache notes\n",
        frontmatter: { tags: ["perf"] },
        title: "Cache notes",
        actor: "import",
      });
      expect(r.revision.version).toBe(1);
      expect(r.reusedExisting).toBe(false);
      expect(getCurrentKnowledgeRevision(db, "domain/cache")?.title).toBe(
        "Cache notes",
      );
    } finally {
      db.close();
    }
  });

  it("same body sha → reuseExisting=true", () => {
    const db = freshDb();
    try {
      recordKnowledgeEntryRevision(db, {
        entryId: "d/e",
        bodyMarkdown: "x",
        frontmatter: {},
        actor: "a",
      });
      const r2 = recordKnowledgeEntryRevision(db, {
        entryId: "d/e",
        bodyMarkdown: "x",
        frontmatter: {},
        actor: "b",
      });
      expect(r2.reusedExisting).toBe(true);
      expect(listKnowledgeRevisions(db, "d/e")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("different body → v2", () => {
    const db = freshDb();
    try {
      recordKnowledgeEntryRevision(db, {
        entryId: "d/e",
        bodyMarkdown: "v1",
        frontmatter: {},
        actor: "a",
      });
      const r2 = recordKnowledgeEntryRevision(db, {
        entryId: "d/e",
        bodyMarkdown: "v2",
        frontmatter: {},
        actor: "b",
      });
      expect(r2.revision.version).toBe(2);
      expect(getCurrentKnowledgeRevision(db, "d/e")?.bodyMarkdown).toBe("v2");
    } finally {
      db.close();
    }
  });
});
