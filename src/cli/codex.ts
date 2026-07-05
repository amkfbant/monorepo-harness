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
import { runMigrations } from "../db/migrations.js";

interface CodexDeps {
  runExternalCodex: typeof defaultRunExternalCodex;
  writeStdout: (s: string) => void;
}

/**
 * External telemetry recording is best-effort and must not gate the transparent
 * wrapper's completion. Under a held EXCLUSIVE maintenance lock (e.g. db restore),
 * the default shared-lock acquire would wait up to DEFAULT_LOCK_TIMEOUT_MS (30s)
 * before failing open — delaying process exit even though stdout was already written.
 * 2 seconds is ample time for an uncontended lock; under contention we fail-open fast.
 */
const EXTERNAL_RECORD_LOCK_TIMEOUT_MS = 2000;

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
    `warning: external codex usage not recorded: ${e instanceof Error ? e.message : String(e)}\n`,
  );
}

/**
 * Record an out-of-harness codex invocation's usage. Fail-open and best-effort:
 * a missing DB is warned and swallowed, any write error is warned and swallowed,
 * so the codex result is never affected. Reuses `codexTurnInputs` (the same
 * per-turn / synthetic-unavailable mapping the internal forwarder uses) — no
 * parallel logic.
 */
function recordExternal(u: ExternalUsage): void {
  const dbPath = harnessDbPath();
  if (dbPath === undefined) {
    // missing DB → warn to stderr (fail-open: no throw, codex output unchanged)
    process.stderr.write("warning: external codex usage not recorded: no harness DB found\n");
    return;
  }
  try {
    const handle = openManagedDb({ dbPath, timeoutMs: EXTERNAL_RECORD_LOCK_TIMEOUT_MS });
    try {
      // Bring the DB to the current schema before writing. Without this, a DB
      // still at an older schema (e.g. v36 before the v37 source_size column)
      // makes the agent_invocation INSERT fail with "no such column" and the
      // external usage is silently lost. All sibling write paths (run workflow,
      // reviewer/evaluator, claude ingest) migrate first; this one must too.
      runMigrations(handle.db);
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
  // enablePositionalOptions scoped to the `codex` sub-command group only — does
  // NOT mutate the root program, so sibling commands (e.g. `project list --repo`)
  // keep their option-parsing behaviour unchanged.
  codex.enablePositionalOptions();
  codex
    .command("exec")
    .description("transparent `codex exec` wrapper that records usage telemetry")
    .allowUnknownOption(true)
    .passThroughOptions()
    // helpOption(false) was removed: --help/-h must be handled by Commander (exit 0),
    // not passed through to the real codex binary. In codex-absent environments (CI,
    // fresh clones) passing --help to the action would spawn codex → ENOENT → exit 127.
    // Users wanting codex's own help can use `harness codex exec -- --help` or run
    // `codex exec --help` directly; the `--` separator already passes args verbatim.
    .argument("[args...]", "codex exec arguments (passed through verbatim)")
    .action(async (_args: string[], _opts: unknown, _cmd: Command) => {
      // Derive the passthrough from program.rawArgs (Commander's copy of the
      // argv slice passed to parse/parseAsync) rather than cmd.args. cmd.args
      // is built AFTER Commander resolves options, so root options like -v/
      // --version or --repo are parsed and stolen before we see them. Slicing
      // rawArgs after the "exec" token gives the verbatim user tokens, meaning
      // root-option-named flags (e.g. `-v`, `--version`) reach codex intact.
      // NOTE: program here is the root Command captured in the outer closure.
      // rawArgs is set by Commander during parse/parseAsync but is absent from the
      // TypeScript type definition (it is a public runtime property). Cast as needed.
      const raw = (program as unknown as { rawArgs: string[] }).rawArgs; // set by Commander during parseAsync
      const codexIdx = raw.indexOf("codex");
      const execIdx = codexIdx !== -1 ? raw.indexOf("exec", codexIdx + 1) : -1;
      const rawSlice = execIdx !== -1 ? raw.slice(execIdx + 1) : _cmd.args;
      const { wrapper, codexArgs } = splitHarnessFlags(rawSlice);
      // Normalize an empty model (e.g. malformed `-m=`) to null so telemetry
      // honours the "absent → NULL" contract instead of storing "" (#351).
      const model = sniffModel(codexArgs) || null;
      // P2-e: skip spawn entirely when codex cannot be started — exitCode:127 +
      // eventsContent:"" is the exact shape runExternalCodex returns on ENOENT/
      // EACCES. Recording a row in that case would accumulate spurious
      // 'unavailable' rows in misconfigured environments where codex is absent.
      const { exitCode, eventsContent } = await runExternalCodex({
        codexArgs,
        stdinMode: wrapper.stdinMode,
        // P2-d: honour HARNESS_CODEX_BIN so callers can override the codex binary,
        // consistent with how the rest of the harness CLI resolves the binary path.
        codexBin: process.env.HARNESS_CODEX_BIN ?? "codex",
      });
      if (exitCode === 127 && eventsContent === "") {
        // Codex never spawned — propagate the exit code but do not write a row.
        process.exitCode = exitCode;
        return;
      }
      // P2-b: if the caller EXPLICITLY passed --json they expect the raw JSONL
      // event stream on stdout (e.g. for piping to `jq`). Detect whether the
      // flag was present in the original passthrough (before injectJsonFlag adds
      // it transparently). If yes: write the raw eventsContent verbatim. If no:
      // reconstruct the final message (existing wrapper behavior).
      // Recording is unchanged either way.
      const callerPassedJson = codexArgs.includes("--json");
      if (callerPassedJson) {
        writeStdout(eventsContent);
      } else {
        // ALWAYS echo the final message to stdout first. Bare codex prints the
        // final message to stdout even when `-o <file>` is given (golden-verified
        // on codex-cli 0.139.0); the `-o` file is written natively by codex and
        // the wrapper does not touch it. Raw JSONL never reaches stdout.
        // Recording must never change what the user sees — write stdout first, then
        // record so DB-lock contention cannot delay user-visible output.
        const msg = extractFinalMessage(eventsContent);
        if (msg.length > 0) writeStdout(msg.endsWith("\n") ? msg : msg + "\n");
      }
      // recordExternal is fail-open: cannot throw; any error is warned to stderr.
      recordExternal({
        eventsContent, label: wrapper.label, runId: wrapper.runId,
        hitchId: wrapper.hitchId, courseId: wrapper.courseId, model,
      });
      process.exitCode = exitCode;
    });
}
