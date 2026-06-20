import { describe, expect, it } from "vitest";
import {
  splitHarnessFlags,
  injectJsonFlag,
  sniffModel,
  extractFinalMessage,
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
});
