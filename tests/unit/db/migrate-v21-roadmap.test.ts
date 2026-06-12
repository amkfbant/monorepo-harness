import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { SCHEMA_VERSION } from "../../../src/db/schema.js";

describe("v21 roadmap migration", () => {
  it("creates courses/phases/phase_hitches with FKs + the hitch_id link PK", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    for (const t of ["courses", "phases", "phase_hitches"]) {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(t),
      ).toBeTruthy();
    }
    db.prepare(
      "INSERT INTO courses (course_id,title,status,created_at,updated_at) VALUES ('c1','C','active','t','t')",
    ).run();
    db.prepare(
      "INSERT INTO phases (phase_id,course_id,title,position,status,created_at,updated_at) VALUES ('p1','c1','P',0,'pending','t','t')",
    ).run();
    db.prepare(
      "INSERT INTO phases (phase_id,course_id,title,position,status,created_at,updated_at) VALUES ('p2','c1','P2',1,'pending','t','t')",
    ).run();
    // hitch_sessions has many NOT NULL columns (no defaults) — seed them all.
    db.prepare(
      `INSERT INTO hitch_sessions (hitch_id, title, status, scope_json, close_conditions_json, policy_json,
         max_iterations, max_review_cycles, max_reruns, max_total_new_findings, created_by, created_source, created_at, updated_at)
       VALUES ('h1','H','open','{}','[]','{}',3,3,2,12,'test','cli','t','t')`,
    ).run();
    db.prepare(
      "INSERT INTO phase_hitches (hitch_id,phase_id,linked_at) VALUES ('h1','p1','t')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO phase_hitches (hitch_id,phase_id,linked_at) VALUES ('h1','p2','t')",
        )
        .run(),
    ).toThrow(/UNIQUE|PRIMARY KEY/i);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("is present in the latest schema (re-running runMigrations does not throw)", () => {
    const db = new Database(":memory:");
    const r = runMigrations(db);
    expect(r.version).toBe(SCHEMA_VERSION);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
