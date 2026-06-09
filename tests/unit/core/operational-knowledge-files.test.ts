import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordOperationalKnowledge,
  deprecateOperationalKnowledge,
  listOperationalKnowledge,
  getOperationalKnowledge,
  importOperationalEntry,
  OperationalKnowledgeError,
} from "../../../src/core/operational-knowledge.js";
import {
  exportOperationalKnowledge,
  importOperationalKnowledge,
} from "../../../src/core/operational-knowledge-files.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-opsfiles-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function seed(db: ReturnType<typeof openDb>): void {
  recordOperationalKnowledge(db, {
    key: "ci-note", title: "CI quirk", body: "spending limit fails fast",
    kind: "ci", tags: ["github", "billing"], projectId: "demo", actor: "op",
  });
  recordOperationalKnowledge(db, {
    key: "portable", title: "Portable", body: "ext4 only", kind: "environment", actor: "op",
  });
  const gone = recordOperationalKnowledge(db, {
    key: "stale", title: "Stale", body: "old", actor: "op",
  });
  deprecateOperationalKnowledge(db, { entryId: gone.entryId, actor: "op" });
}

describe("operational knowledge file export/import (issue #57)", () => {
  it("round-trips DB → files → DB (entries reconstructed, deprecation preserved)", async () => {
    const db1 = freshDb();
    const outDir = mkdtempSync(join(tmpdir(), "harness-ops-out-"));
    try {
      seed(db1);
      const ex = await exportOperationalKnowledge(db1, outDir);
      expect(ex.written).toHaveLength(3); // incl. the deprecated one
      expect(existsSync(join(outDir, "ci", "ci-note.md"))).toBe(true);
      expect(existsSync(join(outDir, "environment", "portable.md"))).toBe(true);

      const db2 = freshDb();
      try {
        const im = await importOperationalKnowledge(db2, outDir);
        expect(im.imported).toBe(3);
        expect(im.skipped).toEqual([]);

        // active entries match
        const active = listOperationalKnowledge(db2).map((e) => e.entryId).sort();
        expect(active).toEqual(["ops/ci-note", "ops/portable"]);
        const ci = getOperationalKnowledge(db2, "ops/ci-note");
        expect(ci?.title).toBe("CI quirk");
        expect(ci?.kind).toBe("ci");
        expect(ci?.tags).toEqual(["github", "billing"]);
        expect(ci?.projectId).toBe("demo");
        // deprecated entry round-trips as deprecated
        expect(getOperationalKnowledge(db2, "ops/stale")?.deprecated).toBe(true);
        expect(listOperationalKnowledge(db2)).toHaveLength(2); // stale hidden
      } finally {
        db2.close();
      }
    } finally {
      db1.close();
    }
  });

  it("import is idempotent (re-import adds no revision)", async () => {
    const db = freshDb();
    const outDir = mkdtempSync(join(tmpdir(), "harness-ops-out2-"));
    try {
      recordOperationalKnowledge(db, { key: "k", title: "T", body: "b", actor: "op" });
      await exportOperationalKnowledge(db, outDir);
      const db2 = freshDb();
      try {
        const a = await importOperationalKnowledge(db2, outDir);
        expect(a.imported).toBe(1);
        const rev1 = (
          db2.prepare("SELECT version FROM knowledge_entry_revisions WHERE entry_id='ops/k' ORDER BY version DESC LIMIT 1").get() as { version: number }
        ).version;
        await importOperationalKnowledge(db2, outDir); // again
        const rev2 = (
          db2.prepare("SELECT version FROM knowledge_entry_revisions WHERE entry_id='ops/k' ORDER BY version DESC LIMIT 1").get() as { version: number }
        ).version;
        expect(rev2).toBe(rev1); // no churn
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });

  it("skips a file whose frontmatter kind is not a slug (no path traversal on re-export)", async () => {
    const db = freshDb();
    const inDir = mkdtempSync(join(tmpdir(), "harness-ops-evil-"));
    try {
      mkdirSync(join(inDir, "ci"), { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(inDir, "ci", "evil.md"),
        "---\ncategory: operational\nkind: ../../outside\ntitle: Evil\n---\nbody\n",
      );
      const r = await importOperationalKnowledge(db, inDir);
      expect(r.imported).toBe(0);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0]?.reason).toMatch(/kind/i);
      expect(listOperationalKnowledge(db, { includeDeprecated: true })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("importOperationalEntry rejects a non-ops entry id (namespace guard)", () => {
    const db = freshDb();
    try {
      expect(() =>
        importOperationalEntry(db, {
          entryId: "docs/knowledge/foo.md", // NOT ops/<slug>
          rawMarkdown: "---\ntitle: x\n---\nbody",
          frontmatter: { title: "x" },
          actor: "op",
        }),
      ).toThrow(OperationalKnowledgeError);
    } finally {
      db.close();
    }
  });

  it("prunes a stale export when an entry's kind changes (round-trip stays deterministic)", async () => {
    const db = freshDb();
    const outDir = mkdtempSync(join(tmpdir(), "harness-ops-prune-"));
    try {
      recordOperationalKnowledge(db, { key: "k", title: "T", body: "b", kind: "ci", actor: "op" });
      await exportOperationalKnowledge(db, outDir);
      expect(existsSync(join(outDir, "ci", "k.md"))).toBe(true);
      // re-record the same key under a different kind, then re-export
      recordOperationalKnowledge(db, { key: "k", title: "T", body: "b2", kind: "environment", actor: "op" });
      await exportOperationalKnowledge(db, outDir);
      expect(existsSync(join(outDir, "ci", "k.md"))).toBe(false); // orphan pruned
      expect(existsSync(join(outDir, "environment", "k.md"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("skips a file with no / malformed frontmatter (not a default-kind entry)", async () => {
    const db = freshDb();
    const inDir = mkdtempSync(join(tmpdir(), "harness-ops-badfm-"));
    try {
      mkdirSync(join(inDir, "ci"), { recursive: true });
      writeFileSync(join(inDir, "ci", "bad.md"), "just text, no frontmatter\n");
      const r = await importOperationalKnowledge(db, inDir);
      expect(r.imported).toBe(0);
      expect(r.skipped[0]?.reason).toMatch(/frontmatter/i);
      expect(listOperationalKnowledge(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("import of an empty / missing dir is a no-op", async () => {
    const db = freshDb();
    try {
      const r = await importOperationalKnowledge(db, join(tmpdir(), "does-not-exist-xyz"));
      expect(r).toEqual({ imported: 0, skipped: [] });
    } finally {
      db.close();
    }
  });

  it("does NOT collide with codebase knowledge: only operational entries are exported", async () => {
    const db = freshDb();
    const outDir = mkdtempSync(join(tmpdir(), "harness-ops-out3-"));
    try {
      recordOperationalKnowledge(db, { key: "op1", title: "Op", body: "x", actor: "op" });
      // a codebase entry must not be exported by the ops exporter
      db.prepare(
        `INSERT INTO knowledge_entries (entry_id, kind, body, category)
         VALUES ('docs/knowledge/note/a.md', 'note', 'codebase', 'codebase')`,
      ).run();
      const ex = await exportOperationalKnowledge(db, outDir);
      expect(ex.written).toHaveLength(1);
      expect(ex.written[0]).toMatch(/op1\.md$/);
    } finally {
      db.close();
    }
  });
});
