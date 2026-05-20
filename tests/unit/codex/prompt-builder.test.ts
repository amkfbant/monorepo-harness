import { describe, it, expect } from "vitest";
import { buildCodexPrompt } from "../../../src/codex/prompt-builder.js";
import type { ResolvedPolicy } from "../../../src/policy/schema.js";

const POLICY: ResolvedPolicy = {
  repoId: "sample",
  domain: "apps/user",
  read: ["apps/user/**", "docs/**"],
  write: ["apps/user/**"],
  denyWrite: ["package.json", "packages/shared/**"],
  allowedCommands: [],
  commandDefaults: { timeoutMs: 300_000 },
  ignoreUntracked: [],
  codex: { sandbox: "workspace-write" },
  limits: { gitTimeoutMs: 30_000 },
};

describe("buildCodexPrompt", () => {
  it("includes goal, domain, write and deny lists", () => {
    const p = buildCodexPrompt({
      goal: "プロフィール更新APIに入力バリデーションを追加する",
      policy: POLICY,
    });
    expect(p).toMatch(/Goal:/);
    expect(p).toMatch(/プロフィール更新API/);
    expect(p).toMatch(/Target domain:\s*\n\s*apps\/user/);
    expect(p).toMatch(/apps\/user\/\*\*/);
    expect(p).toMatch(/package\.json/);
    expect(p).toMatch(/packages\/shared\/\*\*/);
  });

  it("includes a 'do not edit' section even when deny list is empty", () => {
    const p = buildCodexPrompt({
      goal: "x",
      policy: { ...POLICY, denyWrite: [] },
    });
    expect(p).toMatch(/Do not edit:/);
  });
});
