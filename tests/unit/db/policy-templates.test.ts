import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordPolicyTemplate,
  recordEffectivePolicySnapshot,
  getCurrentPolicyTemplate,
  listPolicyTemplates,
} from "../../../src/db/repositories/policy-templates.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-pol-tmpl-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

const Y1 = "policy:\n  cmds: [build]\n";
const Y2 = "policy:\n  cmds: [build, test]\n";

describe("policy_templates repository (Phase 14-3)", () => {
  it("records v1 + retrieves current", () => {
    const db = freshDb();
    try {
      const r = recordPolicyTemplate(db, {
        scopeType: "repo",
        scopeId: "mini",
        bodyYaml: Y1,
        parsed: { cmds: ["build"] },
        actor: "x",
      });
      expect(r.template.version).toBe(1);
      expect(r.reusedExisting).toBe(false);
      expect(getCurrentPolicyTemplate(db, "repo", "mini")?.version).toBe(1);
    } finally {
      db.close();
    }
  });

  it("reuses same body sha (idempotent)", () => {
    const db = freshDb();
    try {
      recordPolicyTemplate(db, {
        scopeType: "repo",
        scopeId: "mini",
        bodyYaml: Y1,
        parsed: {},
        actor: "x",
      });
      const r2 = recordPolicyTemplate(db, {
        scopeType: "repo",
        scopeId: "mini",
        bodyYaml: Y1,
        parsed: {},
        actor: "y",
      });
      expect(r2.reusedExisting).toBe(true);
      expect(listPolicyTemplates(db, "repo", "mini")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("different body → v2", () => {
    const db = freshDb();
    try {
      recordPolicyTemplate(db, {
        scopeType: "repo",
        scopeId: "mini",
        bodyYaml: Y1,
        parsed: {},
        actor: "x",
      });
      const r2 = recordPolicyTemplate(db, {
        scopeType: "repo",
        scopeId: "mini",
        bodyYaml: Y2,
        parsed: {},
        actor: "x",
      });
      expect(r2.template.version).toBe(2);
      expect(listPolicyTemplates(db, "repo", "mini")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("recordEffectivePolicySnapshot stores generated + provenance", () => {
    const db = freshDb();
    try {
      const snap = recordEffectivePolicySnapshot(db, {
        repoId: "mini",
        domain: "apps/catalog",
        generatedPolicyYaml: "compiled:\n  cmds: [build]\n",
        provenance: { sources: ["repo:mini"] },
      });
      expect(snap.snapshotId).toBeGreaterThan(0);
      expect(snap.repoId).toBe("mini");
      const row = db
        .prepare("SELECT count(*) AS n FROM effective_policy_snapshots")
        .get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
