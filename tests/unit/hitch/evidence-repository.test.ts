import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { EvidenceRepository } from "../../../src/hitch/repositories/evidence-repository.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import type { HitchEvidence } from "../../../src/hitch/types.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "harness-evidence-"));
  const db = openDb(join(dir, "harness.sqlite"));
  runMigrations(db);
  return db;
}

/** Seed a hitch_session row using HitchRepository so all NOT NULL columns are satisfied. */
function seedHitch(db: ReturnType<typeof openDb>, hitchId: string): void {
  const repo = new HitchRepository(db);
  repo.createSession({
    hitchId,
    title: "Test hitch",
    projectId: "proj",
    domain: "test",
    scope: { targetFiles: ["src/**"] },
    closeConditions: [],
    createdBy: "test",
    createdSource: "cli",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function makeEvidence(overrides: Partial<HitchEvidence> = {}): HitchEvidence {
  return {
    evidenceId: "ev-001",
    hitchId: "hitch-a",
    runId: null,
    conditionId: null,
    kind: "command",
    attester: "operator",
    attesterLabel: "",
    label: "typecheck",
    command: null,
    exitCode: null,
    summaryMetrics: {},
    metricsSchema: 1,
    outputExcerpt: null,
    secretSuspect: false,
    redacted: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("EvidenceRepository", () => {
  it("round-trips a minimal evidence row (insert → get)", () => {
    const db = freshDb();
    seedHitch(db, "hitch-a");
    const repo = new EvidenceRepository(db);
    const evidence = makeEvidence();
    repo.insertEvidence(evidence);
    const got = repo.getEvidence("ev-001");
    expect(got).not.toBeNull();
    expect(got?.evidenceId).toBe("ev-001");
    expect(got?.hitchId).toBe("hitch-a");
    expect(got?.kind).toBe("command");
    expect(got?.attester).toBe("operator");
    expect(got?.label).toBe("typecheck");
    expect(got?.summaryMetrics).toEqual({});
    expect(got?.secretSuspect).toBe(false);
    expect(got?.redacted).toBe(false);
  });

  it("serializes / deserializes summaryMetrics (object survives round-trip)", () => {
    const db = freshDb();
    seedHitch(db, "hitch-a");
    const repo = new EvidenceRepository(db);
    const metrics = { passed: 42, failed: 0, skipped: 1 };
    repo.insertEvidence(
      makeEvidence({ evidenceId: "ev-metrics", summaryMetrics: metrics }),
    );
    const got = repo.getEvidence("ev-metrics");
    expect(got?.summaryMetrics).toEqual(metrics);
  });

  it("serializes / deserializes boolean fields (secretSuspect + redacted)", () => {
    const db = freshDb();
    seedHitch(db, "hitch-a");
    const repo = new EvidenceRepository(db);
    repo.insertEvidence(
      makeEvidence({
        evidenceId: "ev-bool",
        secretSuspect: true,
        redacted: true,
      }),
    );
    const got = repo.getEvidence("ev-bool");
    expect(got?.secretSuspect).toBe(true);
    expect(got?.redacted).toBe(true);
  });

  it("round-trips all nullable fields when populated", () => {
    const db = freshDb();
    seedHitch(db, "hitch-a");
    const repo = new EvidenceRepository(db);
    repo.insertEvidence(
      makeEvidence({
        evidenceId: "ev-full",
        runId: "run-99",
        conditionId: "cond-1",
        kind: "metrics",
        attester: "harness_auto",
        attesterLabel: "harness",
        command: "npm test",
        exitCode: 0,
        outputExcerpt: "PASS",
        summaryMetrics: { tests: 100 },
        metricsSchema: 2,
      }),
    );
    const got = repo.getEvidence("ev-full");
    expect(got?.runId).toBe("run-99");
    expect(got?.conditionId).toBe("cond-1");
    expect(got?.kind).toBe("metrics");
    expect(got?.attester).toBe("harness_auto");
    expect(got?.attesterLabel).toBe("harness");
    expect(got?.command).toBe("npm test");
    expect(got?.exitCode).toBe(0);
    expect(got?.outputExcerpt).toBe("PASS");
    expect(got?.summaryMetrics).toEqual({ tests: 100 });
    expect(got?.metricsSchema).toBe(2);
  });

  it("listEvidence returns rows in created_at ASC then evidence_id order", () => {
    const db = freshDb();
    seedHitch(db, "hitch-a");
    const repo = new EvidenceRepository(db);
    repo.insertEvidence(
      makeEvidence({ evidenceId: "ev-c", createdAt: "2026-01-03T00:00:00.000Z" }),
    );
    repo.insertEvidence(
      makeEvidence({ evidenceId: "ev-a", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    repo.insertEvidence(
      makeEvidence({ evidenceId: "ev-b", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    const list = repo.listEvidence("hitch-a");
    expect(list.map((e) => e.evidenceId)).toEqual(["ev-a", "ev-b", "ev-c"]);
  });

  it("listEvidence returns empty array for unknown hitch", () => {
    const db = freshDb();
    const repo = new EvidenceRepository(db);
    expect(repo.listEvidence("no-such-hitch")).toEqual([]);
  });

  it("getEvidence returns null for unknown evidenceId", () => {
    const db = freshDb();
    const repo = new EvidenceRepository(db);
    expect(repo.getEvidence("no-such-id")).toBeNull();
  });

  it("ON DELETE CASCADE removes evidence rows when parent hitch is deleted", () => {
    const db = freshDb();
    seedHitch(db, "hitch-a");
    const repo = new EvidenceRepository(db);
    repo.insertEvidence(makeEvidence({ evidenceId: "ev-cascade-1" }));
    repo.insertEvidence(makeEvidence({ evidenceId: "ev-cascade-2" }));
    expect(repo.listEvidence("hitch-a")).toHaveLength(2);
    db.prepare("DELETE FROM hitch_sessions WHERE hitch_id = ?").run("hitch-a");
    expect(repo.listEvidence("hitch-a")).toHaveLength(0);
    expect(repo.getEvidence("ev-cascade-1")).toBeNull();
  });

  it("listEvidence scopes to hitch — does not leak rows from other hitches", () => {
    const db = freshDb();
    seedHitch(db, "hitch-a");
    seedHitch(db, "hitch-b");
    const repo = new EvidenceRepository(db);
    repo.insertEvidence(makeEvidence({ evidenceId: "ev-a", hitchId: "hitch-a" }));
    repo.insertEvidence(
      makeEvidence({ evidenceId: "ev-b", hitchId: "hitch-b" }),
    );
    expect(repo.listEvidence("hitch-a").map((e) => e.evidenceId)).toEqual([
      "ev-a",
    ]);
    expect(repo.listEvidence("hitch-b").map((e) => e.evidenceId)).toEqual([
      "ev-b",
    ]);
  });

  it("stability sort: same created_at ordered by evidence_id ASC", () => {
    const db = freshDb();
    seedHitch(db, "hitch-a");
    const repo = new EvidenceRepository(db);
    const ts = "2026-01-01T12:00:00.000Z";
    repo.insertEvidence(makeEvidence({ evidenceId: "ev-z", createdAt: ts }));
    repo.insertEvidence(makeEvidence({ evidenceId: "ev-m", createdAt: ts }));
    repo.insertEvidence(makeEvidence({ evidenceId: "ev-a", createdAt: ts }));
    const ids = repo.listEvidence("hitch-a").map((e) => e.evidenceId);
    expect(ids).toEqual(["ev-a", "ev-m", "ev-z"]);
  });
});
