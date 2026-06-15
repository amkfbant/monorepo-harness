import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "./codex-exec-runner.js";

export interface FakeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface FakeOpts {
  edit?: (cwd: string, prompt: string) => Promise<void>;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  usage?: FakeUsage;
}

/**
 * Result for an already-aborted signal: no edit runs (mirrors the real runner).
 * A killed/short-circuited codex is always a failure, so the exit code is forced
 * non-zero regardless of `opts.exitCode` — matching the real runner's fail-closed
 * behavior so abort tests don't pass vacuously under `{ exitCode: 0 }`.
 */
function abortedResult(): CodexRunResult {
  return { exitCode: -1, timedOut: false, aborted: true, durationMs: 0 };
}

const DEFAULT_USAGE: FakeUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

function fakeCodexEvents(finalMessage: string, usage: FakeUsage): string {
  return [
    { type: "thread.started", thread_id: "fake-thread" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: { type: "agent_message" },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: finalMessage },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.reasoningOutputTokens,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")
    .concat("\n");
}

export function createFakeCodexRunner(opts: FakeOpts = {}): CodexExecRunner {
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      // Fail-closed: an already-aborted signal short-circuits before any edit,
      // mirroring the real runner not spawning codex once the lease is gone.
      if (input.signal?.aborted === true) return abortedResult();
      let exitCode = opts.exitCode ?? 0;
      let stderr = opts.stderr ?? "";
      try {
        if (opts.edit) await opts.edit(input.worktreePath, input.prompt);
      } catch (e) {
        exitCode = opts.exitCode ?? 1;
        stderr += `${(e as Error).message}\n`;
      }
      await mkdir(dirname(input.logPaths.stdout), { recursive: true });
      await mkdir(dirname(input.logPaths.stderr), { recursive: true });
      await mkdir(dirname(input.logPaths.events), { recursive: true });
      const stdout = opts.stdout ?? "";
      await writeFile(input.logPaths.stdout, stdout, "utf8");
      await writeFile(input.logPaths.stderr, stderr, "utf8");
      await writeFile(
        input.logPaths.events,
        fakeCodexEvents(stdout, opts.usage ?? DEFAULT_USAGE),
        "utf8",
      );
      return {
        exitCode,
        timedOut: opts.timedOut ?? false,
        aborted: false,
        durationMs: opts.durationMs ?? 0,
      };
    },
  };
}
