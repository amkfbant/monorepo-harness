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
