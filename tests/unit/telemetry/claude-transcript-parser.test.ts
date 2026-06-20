import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  normalizeClaudeModel,
  discoverAndParse,
  claudeIdentityFromPath,
  listAgentTranscripts,
} from "../../../src/telemetry/claude-transcript-parser.js";

const FIXT = join(__dirname, "../../fixtures/claude-transcripts");

describe("normalizeClaudeModel", () => {
  it("strips -YYYYMMDD only when present", () => {
    expect(normalizeClaudeModel("claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5",
    );
    expect(normalizeClaudeModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeClaudeModel("<synthetic>")).toBe("<synthetic>");
  });
});

describe("listAgentTranscripts + claudeIdentityFromPath", () => {
  it("finds top-level and nested wf transcripts recursively", () => {
    const files = listAgentTranscripts(FIXT);
    expect(files.some((f) => f.endsWith("subagents/agent-aaa.jsonl"))).toBe(
      true,
    );
    expect(
      files.some((f) =>
        f.includes("subagents/workflows/wf_x/agent-bbb.jsonl"),
      ),
    ).toBe(true);
  });
  it("derives session/agent from the path (skip-before-read)", () => {
    const f = listAgentTranscripts(FIXT).find((x) =>
      x.endsWith("agent-aaa.jsonl"),
    )!;
    expect(claudeIdentityFromPath(FIXT, f)).toEqual({
      sessionId: "sess-1",
      agentId: "aaa",
    });
  });
});

describe("discoverAndParse", () => {
  const invs = discoverAndParse(FIXT);
  it("emits one invocation per agent file with per-message turns", () => {
    const aaa = invs.find((i) => i.agentId === "aaa")!;
    expect(aaa.sessionId).toBe("sess-1");
    expect(aaa.turns).toHaveLength(3);
    expect(aaa.turns[0].turnSeq).toBe(0);
    expect(aaa.turns[0].cacheCreation5mInputTokens).toBe(2);
    expect(aaa.turns[0].cacheCreation1hInputTokens).toBe(1);
    expect(aaa.turns[1].model).toBe("claude-haiku-4-5");
  });
  it("reads agentType/description from sibling meta (and attributionAgent fallback exists)", () => {
    expect(invs.find((i) => i.agentId === "aaa")!.agentType).toBe(
      "general-purpose",
    );
    expect(invs.find((i) => i.agentId === "aaa")!.description).toBe(
      "review pass",
    );
    expect(invs.find((i) => i.agentId === "bbb")!.agentType).toBe(
      "workflow-subagent",
    );
  });
  it("skips malformed lines without throwing", () => {
    expect(
      invs
        .find((i) => i.agentId === "aaa")!
        .turns.every((t) => Number.isFinite(t.inputTokens)),
    ).toBe(true);
  });
  it("NEVER surfaces message.usage.content (privacy — legacy field)", () => {
    expect(JSON.stringify(invs)).not.toContain("SECRET-SHOULD-NOT-BE-READ");
  });
  it("NEVER surfaces message.content (privacy — real assistant text field)", () => {
    // The fixture has message.content:[{type:"text",text:"SECRET-AT-REAL-CONTENT"}]
    // which is the sibling of message.usage (where real assistant text lives).
    // Parser must not read or surface it.
    expect(JSON.stringify(invs)).not.toContain("SECRET-AT-REAL-CONTENT");
  });
});
