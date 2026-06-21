import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resolveAgentBackend,
  resolveAgentRunner,
  resolveClaudeModel,
} from "../../../src/core/agent-runner.js";

afterEach(() => vi.unstubAllEnvs());

describe("resolveAgentBackend", () => {
  it("defaults to codex (claude is opt-in)", () => {
    vi.stubEnv("HARNESS_CODER_BACKEND", "");
    vi.stubEnv("HARNESS_REVIEWER_BACKEND", "");
    expect(resolveAgentBackend("coder")).toBe("codex");
    expect(resolveAgentBackend("reviewer")).toBe("codex");
  });

  it("opts into claude only on the exact string 'claude' (per role)", () => {
    vi.stubEnv("HARNESS_CODER_BACKEND", "claude");
    vi.stubEnv("HARNESS_REVIEWER_BACKEND", "");
    expect(resolveAgentBackend("coder")).toBe("claude");
    expect(resolveAgentBackend("reviewer")).toBe("codex");
  });

  it("fail-closes any other value to codex", () => {
    vi.stubEnv("HARNESS_CODER_BACKEND", "Claude"); // wrong case
    expect(resolveAgentBackend("coder")).toBe("codex");
    vi.stubEnv("HARNESS_CODER_BACKEND", "gpt");
    expect(resolveAgentBackend("coder")).toBe("codex");
  });
});

describe("resolveClaudeModel", () => {
  it("prefers the policy model, else HARNESS_CLAUDE_MODEL, else null", () => {
    vi.stubEnv("HARNESS_CLAUDE_MODEL", "");
    expect(resolveClaudeModel("opus-policy")).toBe("opus-policy");
    expect(resolveClaudeModel()).toBeNull();
    expect(resolveClaudeModel("")).toBeNull();
    vi.stubEnv("HARNESS_CLAUDE_MODEL", "env-model");
    expect(resolveClaudeModel()).toBe("env-model");
    expect(resolveClaudeModel("policy-wins")).toBe("policy-wins");
  });
});

describe("resolveAgentRunner", () => {
  it("returns the runner AND the backend it was built from (one value, per env)", () => {
    vi.stubEnv("HARNESS_CODER_BACKEND", "");
    const codex = resolveAgentRunner({ role: "coder", codexBin: "codex" });
    expect(codex.backend).toBe("codex");
    expect(typeof codex.runner.run).toBe("function");
    vi.stubEnv("HARNESS_CODER_BACKEND", "claude");
    const claude = resolveAgentRunner({ role: "coder", codexBin: "codex" });
    expect(claude.backend).toBe("claude");
    expect(typeof claude.runner.run).toBe("function");
    expect(claude.runner).not.toBe(codex.runner);
  });

  it("returns the EXACT backend used so the dispatch can't diverge (R1-P1b)", () => {
    // env says codex, but an explicit override is honoured AND reported back, so
    // the caller threads the same backend it actually built the runner with.
    vi.stubEnv("HARNESS_CODER_BACKEND", "");
    const forced = resolveAgentRunner({
      role: "coder",
      codexBin: "codex",
      backend: "claude",
    });
    expect(forced.backend).toBe("claude");
    expect(typeof forced.runner.run).toBe("function");
  });
});
