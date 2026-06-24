import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKnowledgeDigest,
  formatDigest,
} from "../../src/core/knowledge-digest.js";

let seq = 0;

interface Root {
  runsDir: string;
  knowledgeDir: string;
}

function harnessRoot(): Root {
  const root = mkdtempSync(join(tmpdir(), "harness-kd-"));
  const r = {
    runsDir: join(root, "runs"),
    knowledgeDir: join(root, "docs", "knowledge"),
  };
  mkdirSync(r.runsDir, { recursive: true });
  mkdirSync(r.knowledgeDir, { recursive: true });
  return r;
}

function writeRun(
  r: Root,
  o: {
    startedAt?: string;
    domain?: string;
    candidates?: Array<{ kind: string; domain?: string }>;
    rejections?: Array<{ index: number; decidedAt: string }>;
  },
): string {
  const runId = `run-20260521-apps-user-kd${String(seq++).padStart(2, "0")}`;
  const dir = join(r.runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      domain: o.domain ?? "apps/user",
      status: "failed-policy-violation",
      startedAt: o.startedAt ?? "2026-05-21T00:00:00Z",
    }),
  );
  if (o.candidates) {
    const yaml = [
      "candidates:",
      ...o.candidates.flatMap((c) => [
        `  - kind: ${c.kind}`,
        `    domain: ${c.domain ?? o.domain ?? "apps/user"}`,
        `    title: t`,
        `    content: c`,
        `    evidence: []`,
        `    confidence: medium`,
      ]),
    ].join("\n");
    writeFileSync(join(dir, "knowledge-candidates.yaml"), yaml + "\n");
  }
  if (o.rejections) {
    const yaml = [
      "decisions:",
      ...o.rejections.flatMap((d) => [
        `  - index: ${d.index}`,
        `    decision: "rejected"`,
        `    reviewer: "knkn"`,
        `    reason: "x"`,
        `    decidedAt: "${d.decidedAt}"`,
      ]),
    ].join("\n");
    writeFileSync(join(dir, "knowledge-decisions.yaml"), yaml + "\n");
  }
  return runId;
}

function writePromoted(
  r: Root,
  kind: string,
  o: { domain: string; promotedAt: string },
): void {
  const dir = join(r.knowledgeDir, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `p${seq++}.md`),
    [
      "---",
      `kind: ${kind}`,
      `domain: ${JSON.stringify(o.domain)}`,
      `promoted_at: ${JSON.stringify(o.promotedAt)}`,
      "deprecated: false",
      "---",
      "",
      "# t",
      "",
    ].join("\n"),
  );
}

describe("buildKnowledgeDigest", () => {
  it("E4-5-1: aggregates candidates by kind", async () => {
    const r = harnessRoot();
    writeRun(r, {
      candidates: [
        { kind: "policy_violation" },
        { kind: "policy_violation" },
        { kind: "secret_suspect" },
      ],
    });
    const d = await buildKnowledgeDigest(r);
    expect(d.candidatesByKind.policy_violation).toBe(2);
    expect(d.candidatesByKind.secret_suspect).toBe(1);
    expect(d.candidateTotal).toBe(3);
  });

  it("E4-5-2: counts promoted and rejected", async () => {
    const r = harnessRoot();
    writeRun(r, {
      candidates: [{ kind: "policy_violation" }, { kind: "secret_suspect" }],
      rejections: [{ index: 0, decidedAt: "2026-05-21T01:00:00Z" }],
    });
    writePromoted(r, "policy_violation", {
      domain: "apps/user",
      promotedAt: "2026-05-21T02:00:00Z",
    });
    const d = await buildKnowledgeDigest(r);
    expect(d.promoted).toBe(1);
    expect(d.rejected).toBe(1);
  });

  it("E4-5-3: --domain restricts the digest", async () => {
    const r = harnessRoot();
    writeRun(r, {
      domain: "apps/orders",
      candidates: [{ kind: "policy_violation", domain: "apps/orders" }],
    });
    writeRun(r, {
      domain: "apps/catalog",
      candidates: [{ kind: "secret_suspect", domain: "apps/catalog" }],
    });
    const d = await buildKnowledgeDigest({ ...r, domain: "apps/orders" });
    expect(d.candidateTotal).toBe(1);
    expect(d.candidatesByKind.policy_violation).toBe(1);
    expect(d.candidatesByKind.secret_suspect).toBeUndefined();
  });

  it("--since excludes older runs", async () => {
    const r = harnessRoot();
    writeRun(r, {
      startedAt: "2020-01-01T00:00:00Z",
      candidates: [{ kind: "policy_violation" }],
    });
    writeRun(r, {
      startedAt: "2026-05-21T00:00:00Z",
      candidates: [{ kind: "secret_suspect" }],
    });
    const d = await buildKnowledgeDigest({
      ...r,
      since: new Date("2026-05-01T00:00:00Z"),
    });
    expect(d.candidateTotal).toBe(1);
    expect(d.candidatesByKind.secret_suspect).toBe(1);
  });

  it("E4-5-4: suggests reviewing unactioned candidates", async () => {
    const r = harnessRoot();
    writeRun(r, { candidates: [{ kind: "policy_violation" }] });
    const d = await buildKnowledgeDigest(r);
    expect(d.suggestions.some((s) => /knowledge list --run-id/.test(s))).toBe(
      true,
    );
  });

  it("formatDigest renders the digest", async () => {
    const r = harnessRoot();
    writeRun(r, { candidates: [{ kind: "policy_violation" }] });
    const text = formatDigest(await buildKnowledgeDigest(r));
    expect(text).toMatch(/Knowledge digest/);
    expect(text).toMatch(/policy_violation: 1/);
  });

  it("counts a duplicate rejection of the same index only once", async () => {
    const r = harnessRoot();
    writeRun(r, {
      candidates: [{ kind: "policy_violation" }],
      rejections: [
        { index: 0, decidedAt: "2026-05-21T01:00:00Z" },
        { index: 0, decidedAt: "2026-05-21T02:00:00Z" },
      ],
    });
    const d = await buildKnowledgeDigest(r);
    expect(d.rejected).toBe(1);
  });

  it("ignores a rejected index that does not resolve to a candidate", async () => {
    const r = harnessRoot();
    const runId = writeRun(r, {
      candidates: [{ kind: "policy_violation" }],
      rejections: [{ index: 7, decidedAt: "2026-05-21T01:00:00Z" }],
    });
    const d = await buildKnowledgeDigest(r);
    expect(d.rejected).toBe(0);
    expect(d.suggestions.some((s) => s.includes(runId))).toBe(true);
  });

  it("ignores a rejection that resolves to a malformed candidate", async () => {
    const r = harnessRoot();
    const runId = `run-20260521-apps-user-kd${String(seq++).padStart(2, "0")}`;
    const dir = join(r.runsDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        runId,
        domain: "apps/user",
        startedAt: "2026-05-21T00:00:00Z",
      }),
    );
    writeFileSync(
      join(dir, "knowledge-candidates.yaml"),
      "candidates:\n  - kind: policy_violation\n    domain: apps/user\n    title: t\n",
    );
    writeFileSync(
      join(dir, "knowledge-decisions.yaml"),
      [
        "decisions:",
        "  - index: 0",
        '    decision: "rejected"',
        '    reviewer: "knkn"',
        '    reason: "x"',
        '    decidedAt: "2026-05-21T01:00:00Z"',
      ].join("\n") + "\n",
    );
    const d = await buildKnowledgeDigest(r);
    expect(d.candidateTotal).toBe(0);
    expect(d.rejected).toBe(0);
  });

  it("excludes a malformed candidate from the counts", async () => {
    const r = harnessRoot();
    const runId = `run-20260521-apps-user-kd${String(seq++).padStart(2, "0")}`;
    const dir = join(r.runsDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ runId, domain: "apps/user", startedAt: "2026-05-21T00:00:00Z" }),
    );
    // a candidate with kind+domain+title but NO content/evidence/confidence
    // — knowledge list/promote treat it as malformed, so the digest must
    // exclude it too (same isCandidate schema).
    writeFileSync(
      join(dir, "knowledge-candidates.yaml"),
      "candidates:\n  - kind: policy_violation\n    domain: apps/user\n    title: t\n",
    );
    const d = await buildKnowledgeDigest(r);
    expect(d.candidateTotal).toBe(0);
  });

  it("does not suggest a run whose candidate is already rejected", async () => {
    const r = harnessRoot();
    const runId = writeRun(r, {
      candidates: [{ kind: "policy_violation" }],
      rejections: [{ index: 0, decidedAt: "2026-05-21T01:00:00Z" }],
    });
    const d = await buildKnowledgeDigest(r);
    // the only candidate is rejected → no "review" suggestion for it
    expect(d.suggestions.some((s) => s.includes(runId))).toBe(false);
  });

  it("reports an empty digest cleanly", async () => {
    const r = harnessRoot();
    const d = await buildKnowledgeDigest(r);
    expect(d.candidateTotal).toBe(0);
    expect(formatDigest(d)).toMatch(/No new knowledge candidates/);
  });
});
