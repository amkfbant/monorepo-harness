import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("keeps per-turn rows for a multi-turn external run", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    try {
      const twoTurns =
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 } }) + "\n" +
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 0 } }) + "\n";
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 0, eventsContent: twoTurns }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "-m", "x", "p"]);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect(
          db.prepare("SELECT turn_seq, input_tokens, output_tokens FROM agent_usage_turn ORDER BY turn_seq").all(),
        ).toEqual([
          { turn_seq: 0, input_tokens: 100, output_tokens: 20 },
          { turn_seq: 1, input_tokens: 5, output_tokens: 9 },
        ]);
      } finally {
        db.close();
      }
    } finally {
      delete process.env.HARNESS_ROOT;
    }
  });

  it("reconstructs the final message to stdout EVEN WHEN -o is present", async () => {
    // bare codex prints the final message to stdout even with -o (golden); the
    // wrapper must too, regardless of -o / --output-last-message.
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    try {
      for (const outFlag of [["-o", "out.txt"], ["--output-last-message", "out.txt"]]) {
        const out: string[] = [];
        const program = new Command();
        registerCodexCommands(program, {
          runExternalCodex: async () => ({ exitCode: 0, eventsContent: usageJsonl(1, 1) }),
          writeStdout: (s) => out.push(s),
        } as never);
        await program.parseAsync([
          "node", "harness", "codex", "exec", ...outFlag, "-m", "x", "p",
        ]);
        expect(out.join("")).toBe("done\n"); // final message echoed despite -o
      }
    } finally {
      delete process.env.HARNESS_ROOT;
    }
  });

  it("links to --harness-hitch-id", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 0, eventsContent: usageJsonl(2, 2) }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync([
        "node", "harness", "codex", "exec", "--harness-hitch-id=hitch-7", "-m", "x", "p",
      ]);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect((db.prepare("SELECT hitch_id FROM agent_invocation").get())).toEqual({ hitch_id: "hitch-7" });
      } finally {
        db.close();
      }
    } finally {
      delete process.env.HARNESS_ROOT;
    }
  });

  // P0 regression: registerCodexCommands must NOT mutate root program's parsing
  it("does NOT break sibling command parsing after registerCodexCommands", async () => {
    // Simulates `harness other list --repo x` — sibling sub-commands must still
    // parse normally after registerCodexCommands is called on the root program.
    const program = new Command();
    program.exitOverride();
    program.option("--repo <p>", "repo path");

    let listCalled = false;
    let repoParsed: string | undefined;
    program
      .command("other")
      .command("list")
      .action(function () {
        listCalled = true;
        // root options are inherited via the command chain
        repoParsed = (program.opts() as { repo?: string }).repo;
      });

    // This is the call under test — must not corrupt root parsing
    registerCodexCommands(program);

    await program.parseAsync(["node", "h", "other", "list", "--repo", "x"]);
    expect(listCalled).toBe(true);
    expect(repoParsed).toBe("x");
  });

  // P1/P2 missing-DB warning: absent DB must emit one stderr warning, not be silent
  it("emits a stderr warning when no harness DB exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-nodb-warn-"));
    process.env.HARNESS_ROOT = root;
    const stderrLines: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    // Intercept stderr
    const stderrSpy = (s: string | Uint8Array): boolean => {
      stderrLines.push(typeof s === "string" ? s : Buffer.from(s).toString());
      return true;
    };
    process.stderr.write = stderrSpy as typeof process.stderr.write;
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 5, eventsContent: usageJsonl(1, 1) }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "p"]);
      expect(process.exitCode).toBe(5);
      const allStderr = stderrLines.join("");
      expect(allStderr).toContain("warning");
    } finally {
      process.stderr.write = origStderr;
      process.exitCode = 0;
      delete process.env.HARNESS_ROOT;
    }
  });

  // P1 fail-open DB-ERROR: corrupt DB must warn on stderr but not block exit/stdout
  it("fails open and warns when DB exists but is corrupt (not a valid sqlite file)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-baddb-"));
    // Create a non-sqlite file at the DB path to force an error on open
    const dotHarness = join(root, ".harness");
    mkdirSync(dotHarness, { recursive: true });
    writeFileSync(join(dotHarness, "harness.sqlite"), "not-a-sqlite-file");
    process.env.HARNESS_ROOT = root;
    const stderrLines: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array): boolean => {
      stderrLines.push(typeof s === "string" ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    const out: string[] = [];
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 9, eventsContent: usageJsonl(1, 1) }),
        writeStdout: (s) => out.push(s),
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "p"]);
      expect(process.exitCode).toBe(9);
      expect(out.join("")).toContain("done"); // stdout still emitted
      const allStderr = stderrLines.join("");
      expect(allStderr).toContain("warning"); // warning emitted
    } finally {
      process.stderr.write = origStderr;
      process.exitCode = 0;
      delete process.env.HARNESS_ROOT;
    }
  });

  // P1 non-zero exit + DB present + usage recorded
  it("records usage AND propagates non-zero exit code", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 7, eventsContent: usageJsonl(10, 5) }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "-m", "gpt-5.5", "p"]);
      expect(process.exitCode).toBe(7);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect(
          db.prepare("SELECT tool, role FROM agent_invocation").get(),
        ).toEqual({ tool: "codex", role: "external" });
      } finally {
        db.close();
      }
    } finally {
      process.exitCode = 0;
      delete process.env.HARNESS_ROOT;
    }
  });

  // P2/P3 focused asserts: usage_source='exact', default label, env linking, flag wins over env
  it("records usage_source=exact for a run with turn-level usage", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 0, eventsContent: usageJsonl(5, 3) }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "-m", "x", "p"]);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect(
          db.prepare("SELECT usage_source FROM agent_invocation").get(),
        ).toEqual({ usage_source: "exact" });
      } finally {
        db.close();
      }
    } finally {
      delete process.env.HARNESS_ROOT;
    }
  });

  it("defaults external_label to 'external' when no --harness-label flag", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 0, eventsContent: usageJsonl(1, 1) }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "-m", "x", "p"]);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect(
          db.prepare("SELECT external_label FROM agent_invocation").get(),
        ).toEqual({ external_label: "external" });
      } finally {
        db.close();
      }
    } finally {
      delete process.env.HARNESS_ROOT;
    }
  });

  it("env HARNESS_RUN_ID populates agent_invocation.run_id", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    process.env.HARNESS_RUN_ID = "run-env-42";
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 0, eventsContent: usageJsonl(1, 1) }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "-m", "x", "p"]);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect(
          db.prepare("SELECT run_id FROM agent_invocation").get(),
        ).toEqual({ run_id: "run-env-42" });
      } finally {
        db.close();
      }
    } finally {
      delete process.env.HARNESS_ROOT;
      delete process.env.HARNESS_RUN_ID;
    }
  });

  it("CLI flag --harness-hitch-id wins over env HARNESS_HITCH_ID", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    process.env.HARNESS_HITCH_ID = "hitch-env-99";
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 0, eventsContent: usageJsonl(1, 1) }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync([
        "node", "harness", "codex", "exec", "--harness-hitch-id=hitch-flag-X", "-m", "x", "p",
      ]);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect(
          db.prepare("SELECT hitch_id FROM agent_invocation").get(),
        ).toEqual({ hitch_id: "hitch-flag-X" });
      } finally {
        db.close();
      }
    } finally {
      delete process.env.HARNESS_ROOT;
      delete process.env.HARNESS_HITCH_ID;
    }
  });

  // P0 regression: `harness codex exec --help` must exit 0 without spawning the
  // real codex binary. Commander must handle --help itself (not pass through to action).
  // Without this fix (.helpOption(false) present), Commander delegates --help to the
  // action which spawns `codex exec --json --help`; in CI there is no codex → ENOENT →
  // exit 127. Pins: helpOption(false) reintroduction is caught without needing codex.
  it("codex exec --help is handled by Commander (action is NOT called)", async () => {
    const program = new Command();
    program.exitOverride(); // make Commander throw instead of process.exit

    let actionCalled = false;
    registerCodexCommands(program, {
      runExternalCodex: async () => {
        actionCalled = true;
        return { exitCode: 0, eventsContent: "" };
      },
      writeStdout: () => {},
    } as never);

    // Commander throws a CommanderError with exitCode 0 and code 'commander.helpDisplayed'
    // when help is printed. If the action ran instead, actionCalled would be true and
    // the error code would not be 'commander.helpDisplayed'.
    let thrownError: { exitCode?: number; code?: string } | undefined;
    try {
      await program.parseAsync(["node", "h", "codex", "exec", "--help"]);
    } catch (e) {
      thrownError = e as { exitCode?: number; code?: string };
    }

    expect(actionCalled).toBe(false);
    expect(thrownError).toBeDefined();
    expect(thrownError?.code).toBe("commander.helpDisplayed");
    expect(thrownError?.exitCode).toBe(0);
  });

  // P2-c: root-level options like --repo or --project are parsed by Commander and
  // consumed before the action sees cmd.args. Without rawArgs passthrough, they
  // disappear from the codex passthrough. Using program.rawArgs (sliced after "exec")
  // recovers them verbatim so they reach codex.
  // Note: -v/--version causes Commander to exit immediately (by design) before the
  // action runs — that is Commander behavior, not a wrapper bug. The fix targets the
  // more common case of non-exit root options (--repo, --project, etc.).
  it("passes root-option-named args (e.g. --repo) through to codex verbatim via rawArgs", async () => {
    const program = new Command();
    program.exitOverride();
    // Declare a root-level --repo option to simulate the real harness behavior
    program.option("--repo <path>", "repo path");
    let capturedCodexArgs: string[] | undefined;
    registerCodexCommands(program, {
      runExternalCodex: async ({ codexArgs }) => {
        capturedCodexArgs = codexArgs;
        return { exitCode: 0, eventsContent: "" };
      },
      writeStdout: () => {},
    } as never);
    // --repo is a root option that would be consumed by Commander, losing it from cmd.args
    await program.parseAsync(["node", "harness", "codex", "exec", "--repo", "/some/path", "hi"]);
    // With rawArgs passthrough: --repo and its value reach codex verbatim
    expect(capturedCodexArgs).toContain("--repo");
    expect(capturedCodexArgs).toContain("/some/path");
    expect(capturedCodexArgs).toContain("hi");
  });

  // P2-c gate: `harness run --version` behavior is unchanged (root NOT mutated).
  // Sibling commands' root-level options still work after registerCodexCommands.
  it("sibling command's root --version still works after registerCodexCommands (root NOT mutated)", async () => {
    const program = new Command();
    program.exitOverride();
    program.version("0.7.17-test", "-v, --version");

    registerCodexCommands(program, {
      runExternalCodex: async () => ({ exitCode: 0, eventsContent: "" }),
      writeStdout: () => {},
    } as never);

    // Invoke root --version (simulates `harness --version` or `harness run --version` via root)
    let caughtErr: { code?: string; exitCode?: number } | undefined;
    try {
      await program.parseAsync(["node", "harness", "--version"]);
    } catch (e) {
      caughtErr = e as { code?: string; exitCode?: number };
    }
    expect(caughtErr?.code).toBe("commander.version");
    expect(caughtErr?.exitCode).toBe(0);
  });

  // P2-d: HARNESS_CODEX_BIN env var must be honoured — the exec action must forward
  // it to runExternalCodex so the correct binary is used instead of literal "codex".
  it("forwards HARNESS_CODEX_BIN to runExternalCodex as codexBin", async () => {
    const sentinel = "/custom/path/to/codex-sentinel";
    const origBin = process.env.HARNESS_CODEX_BIN;
    process.env.HARNESS_CODEX_BIN = sentinel;
    let capturedBin: string | undefined;
    try {
      const program = new Command();
      program.exitOverride();
      registerCodexCommands(program, {
        runExternalCodex: async (opts) => {
          capturedBin = opts.codexBin;
          return { exitCode: 0, eventsContent: "" };
        },
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "hello"]);
      expect(capturedBin).toBe(sentinel);
    } finally {
      if (origBin === undefined) delete process.env.HARNESS_CODEX_BIN;
      else process.env.HARNESS_CODEX_BIN = origBin;
    }
  });

  // P2-b: explicit --json in passthrough → raw JSONL on stdout (not reconstructed message).
  // Without explicit --json → reconstructed final message (existing behavior, still green).
  it("emits raw JSONL to stdout when caller explicitly passes --json", async () => {
    const rawJsonl = '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}\n{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}\n';
    const out: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerCodexCommands(program, {
      runExternalCodex: async () => ({ exitCode: 0, eventsContent: rawJsonl }),
      writeStdout: (s) => out.push(s),
    } as never);
    await program.parseAsync(["node", "harness", "codex", "exec", "--json", "-m", "x", "p"]);
    // When --json is explicit: raw JSONL is written as-is (not the extracted message "hello")
    expect(out.join("")).toBe(rawJsonl);
  });

  it("emits reconstructed final message (not raw JSONL) when --json is absent", async () => {
    const rawJsonl = '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}\n{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}\n';
    const out: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerCodexCommands(program, {
      runExternalCodex: async () => ({ exitCode: 0, eventsContent: rawJsonl }),
      writeStdout: (s) => out.push(s),
    } as never);
    await program.parseAsync(["node", "harness", "codex", "exec", "-m", "x", "p"]);
    // Without explicit --json: reconstructed final message (wrapper behavior)
    expect(out.join("")).toBe("final answer\n");
  });

  // P2-e: when codex cannot spawn (exitCode:127 + eventsContent:""), do NOT record
  // an agent_invocation row. The exit code must still propagate.
  // Rationale: a spawn failure (ENOENT/codex-not-installed) means codex never ran —
  // recording an 'unavailable' row would accumulate spurious rows in misconfigured envs.
  it("does NOT record agent_invocation when codex fails to spawn (exitCode:127, eventsContent:'')", async () => {
    const root = harnessRootWithDb();
    process.env.HARNESS_ROOT = root;
    try {
      const program = new Command();
      registerCodexCommands(program, {
        runExternalCodex: async () => ({ exitCode: 127, eventsContent: "" }),
        writeStdout: () => {},
      } as never);
      await program.parseAsync(["node", "harness", "codex", "exec", "p"]);
      expect(process.exitCode).toBe(127);
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      try {
        expect(
          (db.prepare("SELECT count(*) AS n FROM agent_invocation").get() as { n: number }).n,
        ).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      process.exitCode = 0;
      delete process.env.HARNESS_ROOT;
    }
  });
});
