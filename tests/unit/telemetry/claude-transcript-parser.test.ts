import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
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

// ---------------------------------------------------------------------------
// #350: untrusted-input hardening.
// ---------------------------------------------------------------------------
describe("parseAgentTranscriptFile — untrusted input hardening (#350)", () => {
  function fileWith(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "hard-test-"));
    const sessDir = join(dir, "sess-h", "subagents");
    mkdirSync(sessDir, { recursive: true });
    const p = join(sessDir, "agent-h.jsonl");
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }
  const VALID =
    '{"type":"assistant","sessionId":"sess-h","agentId":"h","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":2}}}';

  it("[#350a] a `null` (valid-JSON non-object) line does NOT throw and is skipped", () => {
    // Before the fix this threw `Cannot read properties of null` and aborted the
    // whole ingest pass. The valid line must still parse.
    const p = fileWith(["null", "123", '"str"', "[]", VALID]);
    let inv;
    expect(() => {
      inv = parseAgentTranscriptFile(p, null);
    }).not.toThrow();
    expect(inv).not.toBeNull();
    expect(inv!.turns).toHaveLength(1);
    expect(inv!.turns[0].inputTokens).toBe(5);
  });

  it("[#350b] num() clamps negative / fractional / huge token values to 0", () => {
    const BAD =
      '{"type":"assistant","sessionId":"sess-h","agentId":"h","message":{"model":"claude-opus-4-8","usage":{"input_tokens":-100,"output_tokens":1.5,"cache_read_input_tokens":1e308}}}';
    const inv = parseAgentTranscriptFile(fileWith([BAD]), null);
    expect(inv).not.toBeNull();
    const t = inv!.turns[0];
    expect(t.inputTokens).toBe(0); // negative → 0
    expect(t.outputTokens).toBe(0); // fractional → 0
    expect(t.cacheReadInputTokens).toBe(0); // non-integer/huge → 0
  });

  it("[#350d] cache_creation falls back to 5m+1h when the flat total is absent", () => {
    const SPLIT_ONLY =
      '{"type":"assistant","sessionId":"sess-h","agentId":"h","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":6}}}}';
    const inv = parseAgentTranscriptFile(fileWith([SPLIT_ONLY]), null);
    expect(inv).not.toBeNull();
    // flat absent → derived 4+6=10 so the flat-column aggregate is not zeroed
    expect(inv!.turns[0].cacheCreationInputTokens).toBe(10);
    expect(inv!.turns[0].cacheCreation5mInputTokens).toBe(4);
    expect(inv!.turns[0].cacheCreation1hInputTokens).toBe(6);
  });

  it("[#350d] cache_creation prefers the flat total when present (no double counting)", () => {
    const BOTH =
      '{"type":"assistant","sessionId":"sess-h","agentId":"h","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":6}}}}';
    const inv = parseAgentTranscriptFile(fileWith([BOTH]), null);
    expect(inv!.turns[0].cacheCreationInputTokens).toBe(10); // flat, not 10+10
  });

  it("[#350d] falls back to 5m+1h when the flat total is present but INVALID", () => {
    // flat is a number but negative → invalid → must fall back to the split.
    const BAD_FLAT =
      '{"type":"assistant","sessionId":"sess-h","agentId":"h","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":-5,"cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":6}}}}';
    const inv = parseAgentTranscriptFile(fileWith([BAD_FLAT]), null);
    expect(inv!.turns[0].cacheCreationInputTokens).toBe(10); // 4+6, not clamped-0
  });

  it("[#350b] caps a DERIVED cache_creation sum to MAX_SAFE_INTEGER (not 2x)", () => {
    const M = Number.MAX_SAFE_INTEGER;
    const SUM = `{"type":"assistant","sessionId":"sess-h","agentId":"h","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":${M},"ephemeral_1h_input_tokens":${M}}}}}`;
    const inv = parseAgentTranscriptFile(fileWith([SUM]), null);
    // each addend passes num() (=M); the fallback sum 2M is capped back to M
    expect(inv!.turns[0].cacheCreationInputTokens).toBe(M);
  });
});

describe("listAgentTranscripts — symlink safety (#350c)", () => {
  it("does NOT follow a symlinked directory or a symlinked file", () => {
    const project = mkdtempSync(join(tmpdir(), "proj-"));
    const real = join(project, "sess-r", "subagents");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "agent-real.jsonl"), "{}\n");

    // A transcript OUTSIDE the project tree that a symlink would otherwise reach.
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const outsideSub = join(outside, "sess-x", "subagents");
    mkdirSync(outsideSub, { recursive: true });
    writeFileSync(join(outsideSub, "agent-evil.jsonl"), "{}\n");

    // 1) symlinked DIRECTORY under the project pointing at the outside tree.
    symlinkSync(outside, join(project, "linked-session"));
    // 2) symlinked FILE under a real subagents dir.
    symlinkSync(
      join(outsideSub, "agent-evil.jsonl"),
      join(real, "agent-link.jsonl"),
    );

    const files = listAgentTranscripts(project);
    expect(files.some((f) => f.endsWith("agent-real.jsonl"))).toBe(true);
    expect(files.some((f) => f.includes("agent-evil.jsonl"))).toBe(false);
    expect(files.some((f) => f.endsWith("agent-link.jsonl"))).toBe(false);
  });

  it("[#350c] does NOT over-match when projectDir itself is named 'subagents'", () => {
    // The match is anchored on the path RELATIVE to projectDir, so a `subagents`
    // component in projectDir (or an ancestor) must not pull in a stray
    // agent-*.jsonl that is not actually under a <session>/subagents/ dir.
    const base = mkdtempSync(join(tmpdir(), "anc-"));
    const project = join(base, "subagents"); // last component is exactly 'subagents'
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "agent-stray.jsonl"), "{}\n"); // directly under projectDir
    const real = join(project, "sess-1", "subagents");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "agent-real.jsonl"), "{}\n");

    const files = listAgentTranscripts(project);
    expect(files.some((f) => f.endsWith("agent-real.jsonl"))).toBe(true);
    expect(files.some((f) => f.endsWith("agent-stray.jsonl"))).toBe(false);
  });
});
