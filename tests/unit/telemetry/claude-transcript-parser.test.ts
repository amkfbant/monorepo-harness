import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeClaudeModel,
  discoverAndParse,
  claudeIdentityFromPath,
  listAgentTranscripts,
  parseAgentTranscriptFile,
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

// ---------------------------------------------------------------------------
// FIX 1 [P1]: streaming-snapshot dedup — multiple assistant lines sharing the
// same message.id must collapse to ONE turn using the LAST (final) snapshot.
// Verified against real Claude Code transcript data: 37 assistant lines but
// only 8 distinct message.id; naive per-line sum gives input=1469 vs CORRECT
// (final-per-message.id) input=318 — ~4.6x over-count.
// ---------------------------------------------------------------------------
describe("parseAgentTranscriptFile — streaming dedup by message.id", () => {
  function makeTranscriptFile(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "dedup-test-"));
    const sessDir = join(dir, "sess-x", "subagents");
    mkdirSync(sessDir, { recursive: true });
    const p = join(sessDir, "agent-msgid.jsonl");
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  // Three streaming snapshots for message.id "msg-1" (2 intermediate + 1 final)
  // and one distinct "msg-2". Parser must yield exactly 2 turns with FINAL usage.
  const MSG1_SNAP1 =
    '{"type":"assistant","sessionId":"sess-x","agentId":"msgid","message":{"id":"msg-1","model":"claude-opus-4-8","usage":{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}';
  const MSG1_SNAP2 =
    '{"type":"assistant","sessionId":"sess-x","agentId":"msgid","message":{"id":"msg-1","model":"claude-opus-4-8","usage":{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}';
  // Final snapshot: output jumps to 692 (authoritative)
  const MSG1_FINAL =
    '{"type":"assistant","sessionId":"sess-x","agentId":"msgid","message":{"id":"msg-1","model":"claude-opus-4-8","usage":{"input_tokens":3,"output_tokens":692,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}';
  const MSG2_ONLY =
    '{"type":"assistant","sessionId":"sess-x","agentId":"msgid","message":{"id":"msg-2","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}';

  it("[P1-dedup] collapses 3 snapshots of msg-1 to ONE turn with FINAL usage (out=692, not summed 694)", () => {
    const p = makeTranscriptFile([MSG1_SNAP1, MSG1_SNAP2, MSG1_FINAL, MSG2_ONLY]);
    const inv = parseAgentTranscriptFile(p, null);
    expect(inv).not.toBeNull();
    // Must produce exactly 2 turns — one per distinct message.id
    expect(inv!.turns).toHaveLength(2);
    // Turn 0 = msg-1 final snapshot: outputTokens MUST be 692 (not 1+1+692=694)
    expect(inv!.turns[0].outputTokens).toBe(692);
    expect(inv!.turns[0].inputTokens).toBe(3); // final snapshot value, not summed
    // Turn 1 = msg-2
    expect(inv!.turns[1].outputTokens).toBe(50);
    expect(inv!.turns[1].inputTokens).toBe(10);
    // turnSeq must be reassigned 0..N-1 over deduped turns
    expect(inv!.turns[0].turnSeq).toBe(0);
    expect(inv!.turns[1].turnSeq).toBe(1);
  });

  it("[P1-dedup] lines without message.id are NOT collapsed together (each is its own turn)", () => {
    // Two assistant lines with no message.id — they must remain as 2 separate turns.
    const NO_ID_A =
      '{"type":"assistant","sessionId":"sess-x","agentId":"msgid","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}';
    const NO_ID_B =
      '{"type":"assistant","sessionId":"sess-x","agentId":"msgid","message":{"model":"claude-opus-4-8","usage":{"input_tokens":7,"output_tokens":14,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}';
    const p = makeTranscriptFile([NO_ID_A, NO_ID_B]);
    const inv = parseAgentTranscriptFile(p, null);
    expect(inv).not.toBeNull();
    expect(inv!.turns).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 [P2]: agentId prefix strip — in-file agentId may have `agent-` prefix
// (REAL transcripts do NOT, but defensive strip makes idempotency robust).
// ---------------------------------------------------------------------------
describe("parseAgentTranscriptFile — agentId agent- prefix strip", () => {
  it("[P2-prefix] strips leading agent- from in-file agentId", () => {
    const dir = mkdtempSync(join(tmpdir(), "prefix-test-"));
    const sessDir = join(dir, "sess-p", "subagents");
    mkdirSync(sessDir, { recursive: true });
    const p = join(sessDir, "agent-pfx.jsonl");
    // In-file agentId has agent- prefix — defensive strip must remove it.
    writeFileSync(
      p,
      '{"type":"assistant","sessionId":"sess-p","agentId":"agent-pfx","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n',
    );
    const inv = parseAgentTranscriptFile(p, null);
    expect(inv).not.toBeNull();
    // After strip: agent-pfx → pfx (matching path-derived id "pfx")
    expect(inv!.agentId).toBe("pfx");
  });
});
