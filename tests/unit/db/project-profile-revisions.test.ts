import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordProjectProfileRevision,
  getCurrentProjectProfile,
  listProjectProfileRevisions,
  getProjectProfileRevision,
  sha256,
} from "../../../src/db/repositories/project-profile-revisions.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-proj-rev-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  return db;
}

const SAMPLE_YAML = `projectId: mini
domains:
  - root: apps/catalog
    kind: web
`;

describe("project_profile_revisions repository (Phase 14-2)", () => {
  it("recordRevision inserts version=1 + sets current pointer + projects row autocreated", () => {
    const db = freshDb();
    try {
      const r = recordProjectProfileRevision(db, {
        projectId: "mini",
        bodyYaml: SAMPLE_YAML,
        parsed: { projectId: "mini" },
        actor: "import-from-file",
        reason: "initial import",
        now: new Date("2026-05-24T12:00:00Z"),
      });
      expect(r.reusedExisting).toBe(false);
      expect(r.revision.version).toBe(1);
      expect(r.revision.bodySha256).toBe(sha256(SAMPLE_YAML));
      const cur = getCurrentProjectProfile(db, "mini");
      expect(cur?.version).toBe(1);
    } finally {
      db.close();
    }
  });

  it("recordRevision with same body sha returns reusedExisting=true (no new row)", () => {
    const db = freshDb();
    try {
      const a = recordProjectProfileRevision(db, {
        projectId: "mini",
        bodyYaml: SAMPLE_YAML,
        parsed: {},
        actor: "x",
      });
      const b = recordProjectProfileRevision(db, {
        projectId: "mini",
        bodyYaml: SAMPLE_YAML,
        parsed: {},
        actor: "y",
      });
      expect(b.reusedExisting).toBe(true);
      expect(b.revision.revisionId).toBe(a.revision.revisionId);
      const revs = listProjectProfileRevisions(db, "mini");
      expect(revs).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("changed body inserts version=2 + supersedes=previous + updates current pointer", () => {
    const db = freshDb();
    try {
      recordProjectProfileRevision(db, {
        projectId: "mini",
        bodyYaml: SAMPLE_YAML,
        parsed: {},
        actor: "a",
      });
      const modified = SAMPLE_YAML + "\n# updated\n";
      const r2 = recordProjectProfileRevision(db, {
        projectId: "mini",
        bodyYaml: modified,
        parsed: { v: 2 },
        actor: "b",
      });
      expect(r2.reusedExisting).toBe(false);
      expect(r2.revision.version).toBe(2);
      expect(r2.revision.supersedesRevisionId).not.toBeNull();
      const cur = getCurrentProjectProfile(db, "mini");
      expect(cur?.version).toBe(2);
      const v1 = getProjectProfileRevision(db, "mini", 1);
      expect(v1?.bodyYaml).toBe(SAMPLE_YAML);
    } finally {
      db.close();
    }
  });

  it("rolls back the canonical revision when write-through fails", () => {
    const db = freshDb();
    try {
      expect(() =>
        recordProjectProfileRevision(db, {
          projectId: "mini",
          bodyYaml: SAMPLE_YAML,
          parsed: {},
          actor: "a",
          writeThrough: () => {
            throw new Error("compat write failed");
          },
        }),
      ).toThrow(/compat write failed/);
      expect(getCurrentProjectProfile(db, "mini")).toBeNull();
      const rows = db
        .prepare(
          "SELECT count(*) AS n FROM project_profile_revisions WHERE project_id = ?",
        )
        .get("mini") as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
