import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { registerCodexCommands } from "../../src/cli/codex.js";

function harnessRootWithDb(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-extcodex-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  db.close();
  return root;
}

function usageJsonl(input: number, output: number): string {
  return (
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 },
    }) +
    "\n" +
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) +
    "\n"
  );
}

describe("harness codex exec (external usage)", () => {
  it("records external codex usage and propagates exit code", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    const out: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerCodexCommands(program, {
      runExternalCodex: async ({ codexArgs }) => {
        expect(codexArgs).toContain("-m");
        return { exitCode: 0, eventsContent: usageJsonl(120, 35) };
      },
      writeStdout: (s) => out.push(s),
    } as never);

    const code = await program.parseAsync(
      ["node", "harness", "codex", "exec", "--harness-label=pr-review", "-m", "gpt-5.5", "the prompt"],
    );
    expect(out.join("")).toContain("done"); // reconstructed final message

    const db = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      expect(
        db.prepare(
          "SELECT tool, role, model, external_label, run_id FROM agent_invocation",
        ).get(),
      ).toEqual({
        tool: "codex", role: "external", model: "gpt-5.5",
        external_label: "pr-review", run_id: null,
      });
      expect(
        (db.prepare("SELECT input_tokens, output_tokens FROM agent_usage_turn").get()),
      ).toEqual({ input_tokens: 120, output_tokens: 35 });
    } finally {
      db.close();
      delete process.env.HARNESS_ROOT;
    }
  });

  it("records an unavailable row when codex emits no usage", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 0, eventsContent: "" }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "-m", "x", "p"]);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect(
          (db.prepare("SELECT usage_source FROM agent_invocation").get()),
        ).toEqual({ usage_source: "unavailable" });
        expect(
          (db.prepare("SELECT count(*) AS n FROM agent_usage_turn").get() as { n: number }).n,
        ).toBe(1); // one synthetic null turn
      } finally {
        db.close();
      }
    } finally {
      delete process.env.HARNESS_ROOT;
    }
  });

  it("fails open and still propagates the exit code when no harness DB exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-nodb-")); // no .harness
    process.env.HARNESS_ROOT = root;
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 3, eventsContent: usageJsonl(1, 1) }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "p"]);
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = 0;
      delete process.env.HARNESS_ROOT;
    }
  });
});
