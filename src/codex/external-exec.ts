import { spawn } from "node:child_process";
import { resolveCodexBin } from "./resolve-codex-bin.js";

export interface WrapperFlags {
  label: string;
  runId: string | null;
  hitchId: string | null;
  courseId: string | null;
}

const HARNESS_FLAGS: Record<string, keyof WrapperFlags> = {
  "--harness-label": "label",
  "--harness-run-id": "runId",
  "--harness-hitch-id": "hitchId",
  "--harness-course-id": "courseId",
};

function envOr(name: string): string | null {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : null;
}

/**
 * Split the wrapper's own `--harness-*=value` flags (consumed) from the codex
 * passthrough args (verbatim). ONLY the single-token `=` form is recognized, so
 * the wrapper never consumes a FOLLOWING token — a positional walk that grabbed
 * the next arg as "the value" would corrupt passthrough when a codex flag value
 * (`-c <x>`, `-o <path>`, `--model <name>`) or the positional prompt equals a
 * `--harness-*` name. A bare `--harness-label` (no `=`) is NOT a wrapper flag and
 * passes straight through to codex.
 */
export function splitHarnessFlags(argv: string[]): {
  wrapper: WrapperFlags;
  codexArgs: string[];
} {
  const wrapper: WrapperFlags = {
    label: "external",
    runId: envOr("HARNESS_RUN_ID"),
    hitchId: envOr("HARNESS_HITCH_ID"),
    courseId: envOr("HARNESS_COURSE_ID"),
  };
  const codexArgs: string[] = [];
  for (const tok of argv) {
    if (tok.startsWith("--harness-")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        const key = HARNESS_FLAGS[tok.slice(0, eq)];
        if (key !== undefined) {
          const value = tok.slice(eq + 1);
          if (key === "label") wrapper.label = value || "external";
          else wrapper[key] = value || null;
          continue; // single token consumed; never touches the next token
        }
      }
      // unknown `--harness-*` or bare (no `=`) → pass through to codex verbatim
    }
    codexArgs.push(tok);
  }
  return { wrapper, codexArgs };
}

/** Add `--json` once so `turn.completed.usage` reaches stdout. */
export function injectJsonFlag(codexArgs: string[]): string[] {
  return codexArgs.includes("--json") ? codexArgs : ["--json", ...codexArgs];
}

/**
 * The model the user actually passed (`-m`/`--model`, space or `=` form) —
 * ground truth for external telemetry. Null when absent (codex then uses its
 * own config default, which the harness does not introspect = best-effort).
 */
export function sniffModel(codexArgs: string[]): string | null {
  for (let i = 0; i < codexArgs.length; i++) {
    const a = codexArgs[i] ?? "";
    if ((a === "-m" || a === "--model") && i + 1 < codexArgs.length) {
      return codexArgs[i + 1] ?? null;
    }
    if (a.startsWith("-m=")) return a.slice(3);
    if (a.startsWith("--model=")) return a.slice("--model=".length);
  }
  return null;
}

export type SpawnImpl = (
  bin: string,
  args: string[],
  onStderr: (chunk: string) => void,
) => Promise<{ exitCode: number; stdout: string }>;

export interface RunExternalCodexOpts {
  codexArgs: string[];
  codexBin?: string;
  onStderr?: (chunk: string) => void;
  spawnImpl?: SpawnImpl;
}

export interface ExternalCodexResult {
  exitCode: number;
  eventsContent: string;
}

const realSpawn: SpawnImpl = (bin, args, onStderr) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => onStderr(c));
    child.on("error", reject); // ENOENT/EACCES — caught by runExternalCodex
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
  });

/**
 * Run `codex exec --json <args>` transparently: capture stdout (JSONL) for
 * usage, stream stderr to `onStderr`, return the codex exit code. `--json` and
 * `-o` are independent, so any `-o` in `codexArgs` is honored natively by codex.
 *
 * NEVER throws: a non-zero codex exit is returned as `exitCode`; a spawn failure
 * (ENOENT/EACCES — `resolveCodexBin` does not check existence) is caught and
 * returned as `exitCode: 127` with a clear `onStderr` message. The CLI action
 * therefore always has an exit code to propagate and never leaks a raw throw.
 */
export async function runExternalCodex(
  opts: RunExternalCodexOpts,
): Promise<ExternalCodexResult> {
  const bin = resolveCodexBin(opts.codexBin ?? "codex");
  const args = ["exec", ...injectJsonFlag(opts.codexArgs)];
  const onStderr = opts.onStderr ?? ((c: string) => void process.stderr.write(c));
  const spawnImpl = opts.spawnImpl ?? realSpawn;
  try {
    const { exitCode, stdout } = await spawnImpl(bin, args, onStderr);
    return { exitCode, eventsContent: stdout };
  } catch (e) {
    onStderr(`harness codex exec: failed to spawn codex: ${(e as Error).message}\n`);
    return { exitCode: 127, eventsContent: "" };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The user-facing final message, reconstructed from the JSONL (because `--json`
 * replaces stdout with events). Total function.
 *
 * Preference order: last `item.completed` event whose `item.type === "agent_message"`
 * with a non-empty `text` string. Defensive fallback: if no `agent_message` item
 * is found, returns the last event with any non-empty `text` on its item — preserves
 * resilience against minor schema drift without corrupting the common case.
 */
export function extractFinalMessage(jsonl: string): string {
  let lastAgentMessage = "";
  let lastAnyText = "";
  for (const line of jsonl.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const ev = JSON.parse(line) as unknown;
      if (!isRecord(ev) || !isRecord(ev.item)) continue;
      const text = ev.item.text;
      if (typeof text !== "string" || text.length === 0) continue;
      lastAnyText = text;
      if (ev.item.type === "agent_message") lastAgentMessage = text;
    } catch {
      // skip malformed line — total function
    }
  }
  // prefer the last agent_message; fall back to any text item (schema-drift resilience)
  return lastAgentMessage !== "" ? lastAgentMessage : lastAnyText;
}
