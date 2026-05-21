import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { DbDashboardDataSource } from "../../../src/dashboard/data-source.js";

describe("DbDashboardDataSource", () => {
  it("delegates run queries to the DB read model", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-ds-"));
    const db = openDb(join(dir, ".harness", "harness.sqlite"));
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, started_at, source_meta_sha256, updated_at)
       VALUES ('run-1', 'demo', 'apps/web', 'domain-coding', 'main',
         'needs_review', '2026-05-21T00:00:00Z', 'x', '2026-05-22T00:00:00Z')`,
    ).run();

    const ds = new DbDashboardDataSource(db);
    const runs = ds.listRuns({ repoId: "demo" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-1");
    expect(ds.countRuns()).toBe(1);
    expect(ds.getRun("run-1")?.domain).toBe("apps/web");
    expect(ds.getRun("missing")).toBeNull();
    db.close();
  });
});
