import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promoteKnowledgeDbFirst,
  rejectKnowledgeDbFirst,
  type KnowledgeDbContext,
} from "../../../src/core/knowledge-db.js";
import { promoteKnowledge } from "../../../src/core/knowledge-promoter.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { runFullImport } from "../../../src/db/import-files.js";

/** Phase 7-9 — knowledge DB-first promote / reject orchestration. */

const RUN_ID = "run-20260522-apps-web-knw1";

function setup(): KnowledgeDbContext {
  const root = mkdtempSync(join(tmpdir(), "harness-knwdb-"));
  const runDir = join(root, "runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "knowledge-candidates.yaml"),
    [
      "candidates:",
      "  - kind: policy_improvement",
      "    domain: apps/web",
      "    title: needs a cross-domain step",
      "    content: codex tried to edit contracts",
      "    evidence: [e1]",
      "    confidence: medium",
      "    status: candidate",
      "  - kind: secret_suspect",
      "    domain: apps/web",
      "    title: env file appeared",
      "    content: filename heuristic hit",
      "    evidence: [e2]",
      "    confidence: low",
      "    status: candidate",
      "",
    ].join("\n"),
  );
  return {
    runsDir: join(root, "runs"),
    knowledgeDir: join(root, "docs", "knowledge"),
    dbPath: join(root, ".harness", "harness.sqlite"),
  };
}

function candidate(
  ctx: KnowledgeDbContext,
  index: number,
): Record<string, unknown> | undefined {
  const db = openDb(ctx.dbPath);
  runMigrations(db);
  const row = db
    .prepare("SELECT * FROM knowledge_candidates WHERE candidate_id = ?")
    .get(`${RUN_ID}:${index}`) as Record<string, unknown> | undefined;
  db.close();
  return row;
}

describe("knowledge DB-first", () => {
  it("promote writes db-first decision + entry manifest + md file", async () => {
    const ctx = setup();
    const r = await promoteKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      reviewer: "kn",
      now: new Date("2026-05-22T00:00:00.000Z"),
    });
    expect(r.promoted).toHaveLength(2);

    const c0 = candidate(ctx, 0);
    expect(c0?.status).toBe("promoted");
    expect(c0?.source_mode).toBe("db-first");
    expect(c0?.reviewer).toBe("kn");

    const db = openDb(ctx.dbPath);
    runMigrations(db);
    const entries = db
      .prepare("SELECT entry_id, source_candidate_id FROM knowledge_entries")
      .all() as { entry_id: string; source_candidate_id: string }[];
    db.close();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.source_candidate_id).toBe(`${RUN_ID}:0`);
    // the md file is exported (the .md is the canonical artifact)
    for (const p of r.promoted) expect(existsSync(p.path)).toBe(true);
  });

  it("reject writes a db-first decision and the sidecar", async () => {
    const ctx = setup();
    const r = await rejectKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      index: 1,
      reviewer: "kn",
      reason: "too specific",
    });
    expect(r.index).toBe(1);
    const c1 = candidate(ctx, 1);
    expect(c1?.status).toBe("rejected");
    expect(c1?.source_mode).toBe("db-first");
    expect(c1?.reason).toBe("too specific");
    expect(
      existsSync(join(ctx.runsDir, RUN_ID, "knowledge-decisions.yaml")),
    ).toBe(true);
  });

  it("promote skips a candidate already rejected in the DB", async () => {
    const ctx = setup();
    await rejectKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      index: 0,
      reviewer: "kn",
      reason: "x",
    });
    const r = await promoteKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      reviewer: "kn",
    });
    expect(r.promoted).toHaveLength(1);
    expect(r.skipped.some((s) => s.index === 0 && s.reason === "rejected")).toBe(
      true,
    );
  });

  it("promote can target a single candidate index", async () => {
    const ctx = setup();
    const r = await promoteKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      index: 0,
      reviewer: "kn",
    });
    expect(r.promoted).toHaveLength(1);
    expect(r.promoted[0]?.index).toBe(0);
    expect(r.skipped.some((s) => s.index === 1 && s.reason === "index-filter")).toBe(
      true,
    );
    expect(candidate(ctx, 0)?.status).toBe("promoted");
    expect(candidate(ctx, 1)?.status).toBe("candidate");
    const db = openDb(ctx.dbPath);
    runMigrations(db);
    const entryCount = db
      .prepare("SELECT count(*) AS n FROM knowledge_entries")
      .get() as { n: number };
    db.close();
    expect(entryCount.n).toBe(1);
  });

  it("a second promote is idempotent (duplicate-index skip)", async () => {
    const ctx = setup();
    await promoteKnowledgeDbFirst(ctx, { runId: RUN_ID, reviewer: "kn" });
    const again = await promoteKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      reviewer: "kn",
    });
    expect(again.promoted).toHaveLength(0);
    expect(again.skipped.every((s) => s.reason === "duplicate-index")).toBe(
      true,
    );
  });

  it("reject is idempotent on the same candidate", async () => {
    const ctx = setup();
    await rejectKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      index: 0,
      reviewer: "kn",
      reason: "x",
    });
    // re-rejecting the same candidate is a no-op, not an error
    await rejectKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      index: 0,
      reviewer: "kn",
      reason: "x",
    });
    expect(candidate(ctx, 0)?.status).toBe("rejected");
  });

  it("a deleted .md drops its knowledge_entries row on --reset import (P1-5)", async () => {
    const ctx = setup();
    await promoteKnowledgeDbFirst(ctx, { runId: RUN_ID, reviewer: "kn" });
    const kindDir = join(ctx.knowledgeDir, "policy_improvement");
    const { rmSync } = await import("node:fs");
    // a human deletes the promoted .md (it is the canonical artifact)
    rmSync(join(kindDir, readdirSync(kindDir)[0] as string));
    const db = openDb(ctx.dbPath);
    runMigrations(db);
    runFullImport(db, { harnessRoot: join(ctx.runsDir, ".."), reset: true });
    const remaining = db
      .prepare("SELECT count(*) AS n FROM knowledge_entries")
      .get() as { n: number };
    db.close();
    // knowledge_entries is a file-derived read model — the deleted .md is gone
    expect(remaining.n).toBe(1); // only the other candidate's entry survives
  });

  it("reconciles a pre-Phase-7 promotion (md exists, DB still candidate)", async () => {
    const ctx = setup();
    // a legacy promote — writes the md files but never touches the DB
    await promoteKnowledge({
      runsDir: ctx.runsDir,
      knowledgeDir: ctx.knowledgeDir,
      runId: RUN_ID,
      reviewer: "legacy-kn",
    });
    expect(candidate(ctx, 0)).toBeUndefined(); // not in the DB yet

    // a DB-first promote sees the existing md (duplicate-index) and
    // reconciles the decision into the DB from the file's frontmatter
    const r = await promoteKnowledgeDbFirst(ctx, {
      runId: RUN_ID,
      reviewer: "kn",
    });
    expect(r.promoted).toHaveLength(0);
    expect(r.skipped.every((s) => s.reason === "duplicate-index")).toBe(true);
    const c0 = candidate(ctx, 0);
    expect(c0?.status).toBe("promoted");
    expect(c0?.source_mode).toBe("db-first");
    expect(c0?.reviewer).toBe("legacy-kn");
  });

  it("db import re-reads a knowledge entry from its file-backed .md", async () => {
    const ctx = setup();
    await promoteKnowledgeDbFirst(ctx, { runId: RUN_ID, reviewer: "kn" });
    const kindDir = join(ctx.knowledgeDir, "policy_improvement");
    const mdFile = join(kindDir, readdirSync(kindDir)[0] as string);
    // a promoted entry's .md body is file-backed (canonical) — a human edit
    // (e.g. fixing the body) is reflected by a normal `db import`.
    writeFileSync(mdFile, "---\nkind: policy_improvement\n---\nhand edited\n");
    const root = join(ctx.runsDir, "..");
    const db = openDb(ctx.dbPath);
    runMigrations(db);
    runFullImport(db, { harnessRoot: root });
    const entry = db
      .prepare(
        "SELECT body FROM knowledge_entries WHERE entry_id LIKE '%policy_improvement%' LIMIT 1",
      )
      .get() as { body: string } | undefined;
    db.close();
    expect(entry?.body).toContain("hand edited");
  });

  it("reject rejects an out-of-range index", async () => {
    const ctx = setup();
    await expect(
      rejectKnowledgeDbFirst(ctx, {
        runId: RUN_ID,
        index: 9,
        reviewer: "kn",
        reason: "x",
      }),
    ).rejects.toThrow(/out of range/);
  });
});
