import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processReviewDecision } from "../../../src/core/review-processor.js";

interface FakeMeta {
  runId: string;
  repoId: string;
  repoPath: string;
  domain: string;
  workflow: string;
  baseBranch: string;
  baseSha: string;
  runBranch: string;
  status: string;
  safetyStatus?: string;
  ignoredUntrackedCount?: number;
  secretSuspectCount?: number;
  startedAt: string;
  finishedAt?: string;
  reviewer?: string | null;
  reviewedAt?: string | null;
}

function writeFakeRun(
  runsDir: string,
  runId: string,
  meta: Partial<FakeMeta>,
  decisionFile: Record<string, unknown>,
): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const fullMeta: FakeMeta = {
    runId,
    repoId: "mini-commerce",
    repoPath: "/tmp/mini",
    domain: "apps/user",
    workflow: "domain-coding",
    baseBranch: "main",
    baseSha: "abc",
    runBranch: "harness/x",
    status: "needs_review",
    startedAt: "2026-05-20T00:00:00Z",
    ...meta,
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(fullMeta, null, 2));
  writeFileSync(join(runDir, "events.jsonl"), "");
  const decision = {
    runId,
    domain: fullMeta.domain,
    required_changes: [],
    non_blocking_comments: [],
    out_of_scope_suggestions: [],
    reviewer: null,
    reviewed_at: null,
    ...decisionFile,
  };
  const yamlLines = Object.entries(decision)
    .map(([k, v]) => {
      if (v === null) return `${k}: null`;
      if (Array.isArray(v))
        return v.length === 0
          ? `${k}: []`
          : `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("\n");
  writeFileSync(join(runDir, "review-decision.yaml"), yamlLines + "\n");
  return runDir;
}

describe("processReviewDecision", () => {
  it("transitions needs_review → approved when decision=approved + reviewer set", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-A", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, runId: "run-A" });
    expect(r.previousStatus).toBe("needs_review");
    expect(r.newStatus).toBe("approved");
    expect(r.reviewer).toBe("alice");
    const meta = JSON.parse(
      readFileSync(join(runsDir, "run-A", "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("approved");
    expect(meta.reviewer).toBe("alice");
    expect(meta.reviewedAt).toBe("2026-05-20T12:00:00Z");
  });

  it("transitions to changes_requested and rejected likewise", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-B", {}, {
      decision: "changes_requested",
      reviewer: "bob",
      reviewed_at: "2026-05-20T13:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, runId: "run-B" });
    expect(r.newStatus).toBe("changes_requested");

    writeFakeRun(runsDir, "run-C", {}, {
      decision: "rejected",
      reviewer: "carol",
      reviewed_at: "2026-05-20T14:00:00Z",
    });
    const r2 = await processReviewDecision({ runsDir, runId: "run-C" });
    expect(r2.newStatus).toBe("rejected");
  });

  it("auto-fills reviewed_at when null and writes back to file", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-D", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: null,
    });
    const before = new Date().getTime();
    const r = await processReviewDecision({ runsDir, runId: "run-D" });
    const after = new Date().getTime();
    const ts = new Date(r.reviewedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    const raw = readFileSync(
      join(runsDir, "run-D", "review-decision.yaml"),
      "utf8",
    );
    expect(raw).not.toMatch(/reviewed_at: null/);
  });

  it("rejects when decision is still pending", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-E", {}, { decision: "pending" });
    await expect(
      processReviewDecision({ runsDir, runId: "run-E" }),
    ).rejects.toThrow(/pending/);
  });

  it("rejects when current meta.status is not needs_review", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-F", { status: "approved" }, {
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, runId: "run-F" }),
    ).rejects.toThrow(/status is "approved"/);
  });

  it("rejects when runId in file does not match dir name", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-G", {}, {
      runId: "run-different",
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, runId: "run-G" }),
    ).rejects.toThrow(/runId/);
  });

  it("rejects when domain in file does not match meta.json", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-H", { domain: "apps/user" }, {
      domain: "apps/other",
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, runId: "run-H" }),
    ).rejects.toThrow(/domain/);
  });

  it("appends a review_processed event", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-I", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    await processReviewDecision({ runsDir, runId: "run-I" });
    const events = readFileSync(
      join(runsDir, "run-I", "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ev = events.find((e) => e.type === "review_processed");
    expect(ev).toBeDefined();
    expect(ev?.decision).toBe("approved");
    expect(ev?.reviewer).toBe("alice");
  });

  it("rejects path-traversal runId (../)", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    await expect(
      processReviewDecision({ runsDir, runId: "../escape" }),
    ).rejects.toThrow(/invalid runId/);
  });

  it("rejects malformed meta.json (not an object) as gate error", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    const runDir = join(runsDir, "run-bad-meta-001");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "meta.json"), '"just a string"');
    writeFileSync(join(runDir, "events.jsonl"), "");
    writeFileSync(
      join(runDir, "review-decision.yaml"),
      [
        "runId: run-bad-meta-001",
        "domain: apps/user",
        "decision: approved",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: alice",
        "reviewed_at: 2026-05-21T00:00:00Z",
      ].join("\n"),
    );
    await expect(
      processReviewDecision({ runsDir, runId: "run-bad-meta-001" }),
    ).rejects.toThrow(/not an object/);
  });

  it("returns a warning flag when reviewer is null", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-J", {}, {
      decision: "approved",
      reviewer: null,
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, runId: "run-J" });
    expect(r.reviewer).toBeNull();
    expect(r.warnings).toContain("reviewer field is null");
  });
});
