import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promoteKnowledge,
  rejectKnowledge,
  listKnowledge,
} from "../../../src/core/knowledge-promoter.js";

interface Cand {
  kind: string;
  domain: string;
  title: string;
  content: string;
  evidence: string[];
  confidence: string;
  status: string;
}

function cand(over: Partial<Cand> = {}): Cand {
  return {
    kind: "policy_improvement",
    domain: "apps/user",
    title: "A reusable lesson",
    content: "Some content.",
    evidence: ["run-x"],
    confidence: "medium",
    status: "candidate",
    ...over,
  };
}

function candYaml(candidates: Cand[] | string): string {
  if (typeof candidates === "string") return candidates;
  return (
    "candidates:\n" +
    candidates
      .map(
        (c) =>
          `  - kind: ${c.kind}\n` +
          `    domain: ${c.domain}\n` +
          `    title: ${JSON.stringify(c.title)}\n` +
          `    content: ${JSON.stringify(c.content)}\n` +
          `    evidence:\n${c.evidence.map((e) => `      - ${e}`).join("\n") || "      []"}\n` +
          `    confidence: ${c.confidence}\n` +
          `    status: ${c.status}`,
      )
      .join("\n")
  );
}

function setup(
  candidates: Cand[] | string,
): { runsDir: string; runId: string; knowledgeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-knw-"));
  const runsDir = join(root, "runs");
  const knowledgeDir = join(root, "knowledge");
  const runId = "run-20260521-apps-user-knw1";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "events.jsonl"), "");
  writeFileSync(
    join(runDir, "knowledge-candidates.yaml"),
    candYaml(candidates) + "\n",
  );
  return { runsDir, runId, knowledgeDir };
}

describe("promoteKnowledge", () => {
  it("requires a reviewer", async () => {
    const { runsDir, runId, knowledgeDir } = setup([cand()]);
    await expect(
      promoteKnowledge({ runsDir, runId, knowledgeDir, reviewer: "  " }),
    ).rejects.toThrow(/reviewer is required/);
  });

  it("writes a md with YAML frontmatter (promoted_by / hash / source_run)", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      cand({ title: "Lesson one" }),
    ]);
    const r = await promoteKnowledge({
      runsDir,
      runId,
      knowledgeDir,
      reviewer: "knkn",
      now: new Date("2026-05-21T09:00:00Z"),
    });
    expect(r.promoted).toHaveLength(1);
    const body = readFileSync(r.promoted[0]!.path, "utf8");
    expect(body).toMatch(/^---\n/);
    expect(body).toMatch(/promoted_by: "knkn"/);
    expect(body).toMatch(/promoted_at: "2026-05-21T09:00:00.000Z"/);
    expect(body).toMatch(/source_run: run-20260521-apps-user-knw1/);
    expect(body).toMatch(/source_index: 0/);
    expect(body).toMatch(/^hash: [0-9a-f]{16}$/m);
    expect(body).toMatch(/# Lesson one/);
  });

  it("is idempotent: a second promote of the same (run,index) is skipped", async () => {
    const { runsDir, runId, knowledgeDir } = setup([cand()]);
    await promoteKnowledge({ runsDir, runId, knowledgeDir, reviewer: "knkn" });
    const r2 = await promoteKnowledge({
      runsDir,
      runId,
      knowledgeDir,
      reviewer: "knkn",
    });
    expect(r2.promoted).toHaveLength(0);
    expect(r2.skipped).toEqual([
      { index: 0, reason: "duplicate-index" },
    ]);
  });

  it("skips a candidate whose content hash already exists (cross-run dedup)", async () => {
    // run A promotes a candidate
    const a = setup([cand({ title: "Shared lesson" })]);
    await promoteKnowledge({
      runsDir: a.runsDir,
      runId: a.runId,
      knowledgeDir: a.knowledgeDir,
      reviewer: "knkn",
    });
    // a different run with an IDENTICAL candidate, same knowledgeDir
    const bRunsDir = join(a.knowledgeDir, "..", "runs");
    const bRunId = "run-20260521-apps-user-knw2";
    mkdirSync(join(bRunsDir, bRunId), { recursive: true });
    writeFileSync(join(bRunsDir, bRunId, "events.jsonl"), "");
    writeFileSync(
      join(bRunsDir, bRunId, "knowledge-candidates.yaml"),
      candYaml([cand({ title: "Shared lesson" })]) + "\n",
    );
    const r = await promoteKnowledge({
      runsDir: bRunsDir,
      runId: bRunId,
      knowledgeDir: a.knowledgeDir,
      reviewer: "knkn",
    });
    expect(r.promoted).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe("duplicate-hash");
  });

  it("--allow-duplicate creates the md despite a matching hash", async () => {
    const a = setup([cand({ title: "Shared lesson" })]);
    await promoteKnowledge({
      runsDir: a.runsDir,
      runId: a.runId,
      knowledgeDir: a.knowledgeDir,
      reviewer: "knkn",
    });
    const bRunsDir = join(a.knowledgeDir, "..", "runs");
    const bRunId = "run-20260521-apps-user-knw3";
    mkdirSync(join(bRunsDir, bRunId), { recursive: true });
    writeFileSync(join(bRunsDir, bRunId, "events.jsonl"), "");
    writeFileSync(
      join(bRunsDir, bRunId, "knowledge-candidates.yaml"),
      candYaml([cand({ title: "Shared lesson" })]) + "\n",
    );
    const r = await promoteKnowledge({
      runsDir: bRunsDir,
      runId: bRunId,
      knowledgeDir: a.knowledgeDir,
      reviewer: "knkn",
      allowDuplicate: true,
    });
    expect(r.promoted).toHaveLength(1);
  });

  it("skips a candidate that was rejected", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      cand({ title: "good" }),
      cand({ title: "bad" }),
    ]);
    await rejectKnowledge({
      runsDir,
      runId,
      index: 1,
      reviewer: "knkn",
      reason: "too specific",
    });
    const r = await promoteKnowledge({
      runsDir,
      runId,
      knowledgeDir,
      reviewer: "knkn",
    });
    expect(r.promoted).toHaveLength(1);
    expect(r.promoted[0]?.title).toBe("good");
    expect(r.skipped).toContainEqual(
      expect.objectContaining({ index: 1, reason: "rejected" }),
    );
  });

  it("--kind filters which candidates are promoted", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      cand({ kind: "policy_improvement", title: "p" }),
      cand({ kind: "secret_suspect", title: "s" }),
    ]);
    const r = await promoteKnowledge({
      runsDir,
      runId,
      knowledgeDir,
      reviewer: "knkn",
      kind: "secret_suspect",
    });
    expect(r.promoted).toHaveLength(1);
    expect(r.promoted[0]?.kind).toBe("secret_suspect");
  });

  it("knowledge-candidates.yaml is never modified", async () => {
    const { runsDir, runId, knowledgeDir } = setup([cand()]);
    const before = readFileSync(
      join(runsDir, runId, "knowledge-candidates.yaml"),
      "utf8",
    );
    await promoteKnowledge({ runsDir, runId, knowledgeDir, reviewer: "knkn" });
    const after = readFileSync(
      join(runsDir, runId, "knowledge-candidates.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("emits a knowledge_promoted event", async () => {
    const { runsDir, runId, knowledgeDir } = setup([cand()]);
    await promoteKnowledge({ runsDir, runId, knowledgeDir, reviewer: "knkn" });
    const events = readFileSync(join(runsDir, runId, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ev = events.find((e) => e.type === "knowledge_promoted");
    expect(ev?.reviewer).toBe("knkn");
    expect(ev?.promotedCount).toBe(1);
  });

  it("rejects an unsafe kind (path traversal)", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      cand({ kind: "../../escape" }),
    ]);
    await expect(
      promoteKnowledge({ runsDir, runId, knowledgeDir, reviewer: "knkn" }),
    ).rejects.toThrow(/unsafe 'kind'/);
  });
});

describe("rejectKnowledge", () => {
  it("writes the decision into knowledge-decisions.yaml + event", async () => {
    const { runsDir, runId } = setup([cand(), cand({ title: "two" })]);
    const r = await rejectKnowledge({
      runsDir,
      runId,
      index: 1,
      reviewer: "knkn",
      reason: "not reusable",
      now: new Date("2026-05-21T09:00:00Z"),
    });
    expect(r.index).toBe(1);
    const sidecar = readFileSync(
      join(runsDir, runId, "knowledge-decisions.yaml"),
      "utf8",
    );
    expect(sidecar).toMatch(/index: 1/);
    expect(sidecar).toMatch(/decision: "rejected"/);
    expect(sidecar).toMatch(/reviewer: "knkn"/);
    const events = readFileSync(join(runsDir, runId, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === "knowledge_rejected")).toBeDefined();
  });

  it("requires a reviewer", async () => {
    const { runsDir, runId } = setup([cand()]);
    await expect(
      rejectKnowledge({ runsDir, runId, index: 0, reviewer: "", reason: "x" }),
    ).rejects.toThrow(/reviewer is required/);
  });

  it("rejects an out-of-range index", async () => {
    const { runsDir, runId } = setup([cand()]);
    await expect(
      rejectKnowledge({
        runsDir,
        runId,
        index: 5,
        reviewer: "knkn",
        reason: "x",
      }),
    ).rejects.toThrow(/out of range/);
  });

  it("a second reject of a different index keeps both decisions", async () => {
    const { runsDir, runId } = setup([
      cand({ title: "a" }),
      cand({ title: "b" }),
    ]);
    await rejectKnowledge({
      runsDir,
      runId,
      index: 0,
      reviewer: "knkn",
      reason: "one",
    });
    await rejectKnowledge({
      runsDir,
      runId,
      index: 1,
      reviewer: "knkn",
      reason: "two",
    });
    const sidecar = readFileSync(
      join(runsDir, runId, "knowledge-decisions.yaml"),
      "utf8",
    );
    expect(sidecar).toMatch(/index: 0/);
    expect(sidecar).toMatch(/index: 1/);
  });

  it("preserves an unrecognised decision entry across a rewrite", async () => {
    const { runsDir, runId } = setup([cand(), cand({ title: "two" })]);
    // a pre-existing decisions sidecar with a forward-compat decision type
    writeFileSync(
      join(runsDir, runId, "knowledge-decisions.yaml"),
      [
        "decisions:",
        "  - index: 0",
        '    decision: "deferred"',
        '    reviewer: "future"',
        "",
      ].join("\n"),
    );
    await rejectKnowledge({
      runsDir,
      runId,
      index: 1,
      reviewer: "knkn",
      reason: "x",
    });
    const sidecar = readFileSync(
      join(runsDir, runId, "knowledge-decisions.yaml"),
      "utf8",
    );
    // the unknown 'deferred' entry must survive
    expect(sidecar).toMatch(/decision: "deferred"/);
    expect(sidecar).toMatch(/index: 1/);
  });
});

describe("promote — (run,index) duplicate detection is frontmatter-based", () => {
  it("does not confuse run-a / run-a-00 (ambiguous filename prefixes)", async () => {
    // promote run-a index 0 → file run-a-00-<slug>.md
    const root = mkdtempSync(join(tmpdir(), "harness-knw-"));
    const runsDir = join(root, "runs");
    const knowledgeDir = join(root, "knowledge");
    function writeRunDir(runId: string): void {
      const d = join(runsDir, runId);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "events.jsonl"), "");
      writeFileSync(
        join(d, "knowledge-candidates.yaml"),
        candYaml([cand({ title: `lesson for ${runId}` })]) + "\n",
      );
    }
    writeRunDir("run-a");
    writeRunDir("run-a-00");
    await promoteKnowledge({
      runsDir,
      runId: "run-a",
      knowledgeDir,
      reviewer: "knkn",
    });
    // run-a-00 index 0 must still promote — it is a different run, even
    // though run-a's file (run-a-00-…md) shares a filename prefix.
    const r = await promoteKnowledge({
      runsDir,
      runId: "run-a-00",
      knowledgeDir,
      reviewer: "knkn",
    });
    expect(r.promoted).toHaveLength(1);
    expect(r.skipped).toEqual([]);
  });
});

describe("listKnowledge", () => {
  it("lists candidates with status candidate / promoted / rejected", async () => {
    // index 0: promoted, index 1: rejected, index 2: stays a candidate
    // (different kind, excluded from the --kind-filtered promote).
    const { runsDir, runId, knowledgeDir } = setup([
      cand({ kind: "policy_improvement", title: "to-promote" }),
      cand({ kind: "policy_improvement", title: "to-reject" }),
      cand({ kind: "secret_suspect", title: "untouched" }),
    ]);
    await rejectKnowledge({
      runsDir,
      runId,
      index: 1,
      reviewer: "knkn",
      reason: "too specific",
    });
    await promoteKnowledge({
      runsDir,
      runId,
      knowledgeDir,
      reviewer: "knkn",
      kind: "policy_improvement",
    });
    const list = await listKnowledge({ runsDir, runId, knowledgeDir });
    expect(list[0]?.status).toBe("promoted");
    expect(list[1]?.status).toBe("rejected");
    expect(list[1]?.rejectedBy).toBe("knkn");
    expect(list[2]?.status).toBe("candidate");
  });

  it("reflects promoted status after a promote", async () => {
    const { runsDir, runId, knowledgeDir } = setup([cand({ title: "x" })]);
    await promoteKnowledge({ runsDir, runId, knowledgeDir, reviewer: "knkn" });
    const list = await listKnowledge({ runsDir, runId, knowledgeDir });
    expect(list[0]?.status).toBe("promoted");
  });

  it("filters by --kind and --domain", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      cand({ kind: "policy_improvement", domain: "apps/a", title: "p" }),
      cand({ kind: "secret_suspect", domain: "apps/b", title: "s" }),
    ]);
    const byKind = await listKnowledge({
      runsDir,
      runId,
      knowledgeDir,
      kind: "secret_suspect",
    });
    expect(byKind.map((e) => e.title)).toEqual(["s"]);
    const byDomain = await listKnowledge({
      runsDir,
      runId,
      knowledgeDir,
      domain: "apps/a",
    });
    expect(byDomain.map((e) => e.title)).toEqual(["p"]);
  });

  it("rejects an invalid runId", async () => {
    await expect(
      listKnowledge({
        runsDir: "/tmp",
        runId: "../escape",
        knowledgeDir: "/tmp/k",
      }),
    ).rejects.toThrow(/invalid runId/);
  });
});
