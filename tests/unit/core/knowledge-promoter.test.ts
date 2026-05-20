import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteKnowledge } from "../../../src/core/knowledge-promoter.js";

interface Cand {
  kind: string;
  domain: string;
  title: string;
  content: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  status: string;
}

function setup(
  candidates: Cand[] | string,
): { runsDir: string; runId: string; knowledgeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-promote-"));
  const runsDir = join(root, "runs");
  const knowledgeDir = join(root, "knowledge");
  mkdirSync(runsDir, { recursive: true });
  const runId = "run-20260521-apps-user-promo1";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "events.jsonl"), "");
  const yamlBody =
    typeof candidates === "string"
      ? candidates
      : `candidates:\n${candidates
          .map(
            (c) =>
              `  - kind: ${c.kind}\n    domain: ${c.domain}\n    title: ${JSON.stringify(c.title)}\n    content: ${JSON.stringify(c.content)}\n    evidence:\n${c.evidence.map((e) => `      - ${e}`).join("\n") || "      []"}\n    confidence: ${c.confidence}\n    status: ${c.status}`,
          )
          .join("\n")}`;
  writeFileSync(join(runDir, "knowledge-candidates.yaml"), yamlBody + "\n");
  return { runsDir, runId, knowledgeDir };
}

describe("promoteKnowledge", () => {
  it("creates one markdown file per candidate, grouped by kind", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      {
        kind: "policy_improvement",
        domain: "apps/user",
        title: "Need cross-domain step",
        content: "Codex tried to edit contracts.",
        evidence: ["sample-evidence-1"],
        confidence: "medium",
        status: "candidate",
      },
      {
        kind: "secret_suspect",
        domain: "apps/user",
        title: "env.local appeared in catalog",
        content: "Detected by filename heuristic.",
        evidence: ["sample-evidence-2"],
        confidence: "low",
        status: "candidate",
      },
    ]);
    const r = await promoteKnowledge({ runsDir, knowledgeDir, runId });
    expect(r.promoted).toHaveLength(2);
    expect(r.skipped).toBe(0);
    expect(existsSync(join(knowledgeDir, "policy_improvement"))).toBe(true);
    expect(existsSync(join(knowledgeDir, "secret_suspect"))).toBe(true);
    // file content includes the source-run header and the candidate content
    const files = readdirSync(join(knowledgeDir, "policy_improvement"));
    expect(files).toHaveLength(1);
    const body = readFileSync(
      join(knowledgeDir, "policy_improvement", files[0]!),
      "utf8",
    );
    expect(body).toMatch(/# Need cross-domain step/);
    expect(body).toMatch(/source run.*run-20260521/);
  });

  it("filters by --kind when given", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      {
        kind: "policy_improvement",
        domain: "x",
        title: "A",
        content: "a",
        evidence: [],
        confidence: "low",
        status: "candidate",
      },
      {
        kind: "secret_suspect",
        domain: "x",
        title: "B",
        content: "b",
        evidence: [],
        confidence: "low",
        status: "candidate",
      },
    ]);
    const r = await promoteKnowledge({
      runsDir,
      knowledgeDir,
      runId,
      kind: "secret_suspect",
    });
    expect(r.promoted).toHaveLength(1);
    expect(r.promoted[0]?.kind).toBe("secret_suspect");
    expect(r.skipped).toBe(1);
    expect(existsSync(join(knowledgeDir, "policy_improvement"))).toBe(false);
  });

  it("appends a knowledge_promoted event to events.jsonl", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      {
        kind: "policy_improvement",
        domain: "x",
        title: "Test",
        content: "c",
        evidence: [],
        confidence: "low",
        status: "candidate",
      },
    ]);
    await promoteKnowledge({ runsDir, knowledgeDir, runId });
    const events = readFileSync(
      join(runsDir, runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ev = events.find((e) => e.type === "knowledge_promoted");
    expect(ev).toBeDefined();
    expect(ev?.promotedCount).toBe(1);
    expect(ev?.skipped).toBe(0);
  });

  it("leaves knowledge-candidates.yaml untouched (audit trail)", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      {
        kind: "policy_improvement",
        domain: "x",
        title: "A",
        content: "a",
        evidence: [],
        confidence: "low",
        status: "candidate",
      },
    ]);
    const original = readFileSync(
      join(runsDir, runId, "knowledge-candidates.yaml"),
      "utf8",
    );
    await promoteKnowledge({ runsDir, knowledgeDir, runId });
    const after = readFileSync(
      join(runsDir, runId, "knowledge-candidates.yaml"),
      "utf8",
    );
    expect(after).toBe(original);
  });

  it("handles an empty candidates list gracefully", async () => {
    const { runsDir, runId, knowledgeDir } = setup("candidates: []");
    const r = await promoteKnowledge({ runsDir, knowledgeDir, runId });
    expect(r.promoted).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it("rejects path-traversal runId", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-promote-"));
    await expect(
      promoteKnowledge({
        runsDir: join(root, "runs"),
        knowledgeDir: join(root, "knowledge"),
        runId: "../escape",
      }),
    ).rejects.toThrow(/invalid runId/);
  });

  it("rejects when knowledge-candidates.yaml is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-promote-"));
    const runsDir = join(root, "runs");
    const runId = "run-20260521-apps-user-promo2";
    mkdirSync(join(runsDir, runId), { recursive: true });
    await expect(
      promoteKnowledge({
        runsDir,
        knowledgeDir: join(root, "knowledge"),
        runId,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("rejects malformed yaml", async () => {
    const { runsDir, runId, knowledgeDir } = setup("this: is: not: yaml: {{");
    await expect(
      promoteKnowledge({ runsDir, knowledgeDir, runId }),
    ).rejects.toThrow(/parse/i);
  });

  it("skips entries that don't look like candidates", async () => {
    const { runsDir, runId, knowledgeDir } = setup(
      "candidates:\n  - just a string\n  - 42\n",
    );
    const r = await promoteKnowledge({ runsDir, knowledgeDir, runId });
    expect(r.promoted).toHaveLength(0);
    expect(r.skipped).toBe(2);
  });

  it("rejects a candidate whose kind has a path separator (path traversal guard)", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      {
        kind: "../../outside",
        domain: "x",
        title: "evil",
        content: "x",
        evidence: [],
        confidence: "low",
        status: "candidate",
      },
    ]);
    await expect(
      promoteKnowledge({ runsDir, knowledgeDir, runId }),
    ).rejects.toThrow(/unsafe 'kind'/);
  });

  it("Unicode (Japanese) title produces a discriminating filename, not 'untitled'", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      {
        kind: "policy_improvement",
        domain: "x",
        title: "日本語タイトルの候補",
        content: "x",
        evidence: [],
        confidence: "low",
        status: "candidate",
      },
    ]);
    const r = await promoteKnowledge({ runsDir, knowledgeDir, runId });
    expect(r.promoted).toHaveLength(1);
    const fname = r.promoted[0]!.path.split("/").pop()!;
    // either the unicode body survived, or there's at least a hash suffix
    // so files don't collapse to a single "untitled.md"
    expect(fname).not.toMatch(/untitled\.md$/);
    expect(fname).toMatch(/-[a-f0-9]{6}\.md$/);
  });

  it("two different long titles produce distinct filenames (hash discriminator)", async () => {
    const { runsDir, runId, knowledgeDir } = setup([
      {
        kind: "policy_improvement",
        domain: "x",
        title: "long title aaa aaa aaa aaa aaa aaa aaa aaa version one",
        content: "a",
        evidence: [],
        confidence: "low",
        status: "candidate",
      },
      {
        kind: "policy_improvement",
        domain: "x",
        title: "long title aaa aaa aaa aaa aaa aaa aaa aaa version two",
        content: "b",
        evidence: [],
        confidence: "low",
        status: "candidate",
      },
    ]);
    const r = await promoteKnowledge({ runsDir, knowledgeDir, runId });
    expect(r.promoted).toHaveLength(2);
    expect(r.promoted[0]!.path).not.toBe(r.promoted[1]!.path);
  });
});
