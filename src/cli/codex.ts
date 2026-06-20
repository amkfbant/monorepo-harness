import { existsSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { getHarnessRoot } from "./run-core.js";
import {
  runExternalCodex as defaultRunExternalCodex,
  splitHarnessFlags,
  sniffModel,
  extractFinalMessage,
} from "../codex/external-exec.js";
import { parseCodexTurns, sumCodexTurns } from "../codex/usage-parser.js";
import { recordAgentUsage } from "../db/repositories/agent-usage.js";
import { codexTurnInputs } from "../db/repositories/run-usage.js";

interface CodexDeps {
  runExternalCodex: typeof defaultRunExternalCodex;
  writeStdout: (s: string) => void;
}

interface ExternalUsage {
  eventsContent: string;
  label: string;
  runId: string | null;
  hitchId: string | null;
  courseId: string | null;
  model: string | null;
}

function harnessDbPath(): string | undefined {
  const dbPath = harnessPaths(getHarnessRoot()).dbPath;
  return existsSync(dbPath) ? dbPath : undefined;
}

function warnNotRecorded(e: unknown): void {
  process.stderr.write(
    `warning: external codex usage not recorded: ${(e as Error).message}\n`,
  );
}

/**
 * Record an out-of-harness codex invocation's usage. Fail-open and best-effort:
 * a missing DB or any write error is warned and swallowed so the codex result
 * is never affected. Reuses `codexTurnInputs` (the same per-turn / synthetic-
 * unavailable mapping the internal forwarder uses) — no parallel logic.
 */
function recordExternal(u: ExternalUsage): void {
  const dbPath = harnessDbPath();
  if (dbPath === undefined) return; // no harness DB → skip silently
  try {
    const handle = openManagedDb({ dbPath });
    try {
      const turns = parseCodexTurns(u.eventsContent);
      const summary = sumCodexTurns(turns);
      recordAgentUsage({
        db: handle.db,
        tool: "codex",
        role: "external",
        model: u.model,
        externalLabel: u.label,
        runId: u.runId,
        hitchId: u.hitchId,
        courseId: u.courseId,
        usageSource: summary.usageSource,
        turns: codexTurnInputs(turns, u.model, summary.usageSource),
        onError: warnNotRecorded,
      });
    } finally {
      handle.close();
    }
  } catch (e) {
    warnNotRecorded(e);
  }
}

export function registerCodexCommands(
  program: Command,
  deps?: Partial<CodexDeps>,
): void {
  const runExternalCodex = deps?.runExternalCodex ?? defaultRunExternalCodex;
  const writeStdout =
    deps?.writeStdout ?? ((s: string) => void process.stdout.write(s));

  const codex = program.command("codex").description("codex wrappers");
  codex
    .command("exec")
    .description("transparent `codex exec` wrapper that records usage telemetry")
    .allowUnknownOption(true)
    .helpOption(false)
    .argument("[args...]", "codex exec arguments (passed through verbatim)")
    .action(async (_args: string[], _opts: unknown, cmd: Command) => {
      // cmd.args holds the raw passthrough argv (commander, with
      // allowUnknownOption + enablePositionalOptions).
      const { wrapper, codexArgs } = splitHarnessFlags(cmd.args);
      const model = sniffModel(codexArgs);
      const { exitCode, eventsContent } = await runExternalCodex({ codexArgs });
      // Record FIRST (fail-open — recordExternal cannot throw), then reconstruct
      // output. Recording must never change what the user sees.
      recordExternal({
        eventsContent, label: wrapper.label, runId: wrapper.runId,
        hitchId: wrapper.hitchId, courseId: wrapper.courseId, model,
      });
      // ALWAYS echo the final message to stdout. Bare codex prints the final
      // message to stdout even when `-o <file>` is given (golden-verified on
      // codex-cli 0.139.0); the `-o` file is written natively by codex and the
      // wrapper does not touch it. Raw JSONL never reaches stdout.
      const msg = extractFinalMessage(eventsContent);
      if (msg.length > 0) writeStdout(msg.endsWith("\n") ? msg : msg + "\n");
      process.exitCode = exitCode;
    });
  program.enablePositionalOptions();
  codex.enablePositionalOptions();
}
