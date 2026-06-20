import { describe, expect, it } from "vitest";
import {
  splitHarnessFlags,
  injectJsonFlag,
  sniffModel,
  extractFinalMessage,
  runExternalCodex,
  type SpawnImpl,
} from "../../../src/codex/external-exec.js";

describe("splitHarnessFlags (single-token `=` form only)", () => {
  it("consumes --harness-*=value and passes the rest through verbatim", () => {
    const { wrapper, codexArgs } = splitHarnessFlags([
      "--harness-label=pr-review",
      "--harness-run-id=run-1",
      "-m", "gpt-5.5", "-s", "read-only", "-o", "out.txt", "the prompt",
    ]);
    expect(wrapper).toEqual({
      label: "pr-review", runId: "run-1", hitchId: null, courseId: null,
    });
    expect(codexArgs).toEqual([
      "-m", "gpt-5.5", "-s", "read-only", "-o", "out.txt", "the prompt",
    ]);
  });

  it("NEVER steals a following token: a codex flag value equal to a wrapper-flag NAME passes through", () => {
    // `codex exec -c --harness-label -m gpt-5.5 p` — the `-c` value is the bare
    // string `--harness-label`; it must reach codex untouched, and `-m gpt-5.5`
    // must survive. (Regression for the space-form token-stealing bug.)
    const { wrapper, codexArgs } = splitHarnessFlags([
      "-c", "--harness-label", "-m", "gpt-5.5", "p",
    ]);
    expect(wrapper.label).toBe("external"); // not hijacked
    expect(codexArgs).toEqual(["-c", "--harness-label", "-m", "gpt-5.5", "p"]);
  });

  it("a positional prompt equal to a bare wrapper-flag name passes through", () => {
    const { wrapper, codexArgs } = splitHarnessFlags(["--harness-label", "p"]);
    expect(wrapper.label).toBe("external"); // bare form (no '=') is not consumed
    expect(codexArgs).toEqual(["--harness-label", "p"]);
  });

  it("defaults label to 'external' and links to env when flags absent", () => {
    const prev = process.env.HARNESS_HITCH_ID;
    process.env.HARNESS_HITCH_ID = "hitch-9";
    try {
      const { wrapper } = splitHarnessFlags(["-m", "gpt-5.5", "p"]);
      expect(wrapper.label).toBe("external");
      expect(wrapper.hitchId).toBe("hitch-9");
    } finally {
      if (prev === undefined) delete process.env.HARNESS_HITCH_ID;
      else process.env.HARNESS_HITCH_ID = prev;
    }
  });
});

describe("injectJsonFlag", () => {
  it("adds --json once", () => {
    expect(injectJsonFlag(["-m", "x", "p"])).toEqual(["--json", "-m", "x", "p"]);
  });
  it("is idempotent when --json already present", () => {
    expect(injectJsonFlag(["--json", "-m", "x"])).toEqual(["--json", "-m", "x"]);
  });
});

describe("sniffModel", () => {
  it("reads -m / --model (space and `=` forms), null when absent", () => {
    expect(sniffModel(["-m", "gpt-5.5", "p"])).toBe("gpt-5.5");
    expect(sniffModel(["--model", "o3", "p"])).toBe("o3");
    expect(sniffModel(["-m=gpt-5.5", "p"])).toBe("gpt-5.5");
    expect(sniffModel(["--model=o3", "p"])).toBe("o3");
    expect(sniffModel(["-s", "read-only", "p"])).toBeNull();
  });
});

describe("extractFinalMessage", () => {
  it("returns the last assistant message text item", () => {
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
    ].join("\n");
    expect(extractFinalMessage(jsonl)).toBe("final answer");
  });
  it("is total: malformed/empty → empty string", () => {
    expect(extractFinalMessage("{broken")).toBe("");
    expect(extractFinalMessage("")).toBe("");
  });
  // P1: non-agent_message item AFTER the final agent_message must not override it
  it("ignores trailing non-agent_message items after the final agent_message", () => {
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "real answer" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "trailing" } }),
    ].join("\n");
    expect(extractFinalMessage(jsonl)).toBe("real answer");
  });
  // P1: fallback — only a non-agent text item present → returns it (schema-drift resilience)
  it("falls back to last non-empty text item when no agent_message is present", () => {
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "only text" } }),
    ].join("\n");
    expect(extractFinalMessage(jsonl)).toBe("only text");
  });
  // Fallback: no item with text → empty string
  it("returns empty string when no text items at all", () => {
    const jsonl = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n");
    expect(extractFinalMessage(jsonl)).toBe("");
  });
});

describe("runExternalCodex", () => {
  it("injects --json, forwards stderr, returns captured JSONL + exit code", async () => {
    const calls: { bin: string; args: string[] }[] = [];
    const stderrSeen: string[] = [];
    const fakeSpawn = async (
      bin: string,
      args: string[],
      onStderr: (c: string) => void,
    ) => {
      calls.push({ bin, args });
      onStderr("progress line\n");
      return { exitCode: 0, stdout: '{"type":"turn.completed","usage":{}}\n' };
    };
    const res = await runExternalCodex({
      codexArgs: ["-m", "gpt-5.5", "hi"],
      codexBin: "codex",
      onStderr: (c) => stderrSeen.push(c),
      spawnImpl: fakeSpawn,
    });
    expect(calls[0]?.args).toEqual(["exec", "--json", "-m", "gpt-5.5", "hi"]);
    expect(stderrSeen.join("")).toContain("progress line");
    expect(res.exitCode).toBe(0);
    expect(res.eventsContent).toContain("turn.completed");
  });

  it("returns a non-zero exit without throwing", async () => {
    const fakeSpawn: SpawnImpl = async () => ({ exitCode: 7, stdout: "" });
    const res = await runExternalCodex({
      codexArgs: ["x"], codexBin: "codex", spawnImpl: fakeSpawn,
    });
    expect(res.exitCode).toBe(7);
  });

  it("catches a spawn failure (ENOENT) as exit 127 + stderr, never throws", async () => {
    const stderrSeen: string[] = [];
    const failingSpawn: SpawnImpl = async () => {
      throw new Error("spawn codex ENOENT");
    };
    const res = await runExternalCodex({
      codexArgs: ["x"], codexBin: "codex",
      onStderr: (c) => stderrSeen.push(c), spawnImpl: failingSpawn,
    });
    expect(res.exitCode).toBe(127);
    expect(res.eventsContent).toBe("");
    expect(stderrSeen.join("")).toContain("failed to spawn codex");
  });
});
