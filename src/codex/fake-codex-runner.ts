import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "./codex-exec-runner.js";

export interface FakeOpts {
  edit?: (cwd: string, prompt: string) => Promise<void>;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
}

export function createFakeCodexRunner(opts: FakeOpts = {}): CodexExecRunner {
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      let exitCode = opts.exitCode ?? 0;
      let stderr = opts.stderr ?? "";
      try {
        if (opts.edit) await opts.edit(input.worktreePath, input.prompt);
      } catch (e) {
        exitCode = opts.exitCode ?? 1;
        stderr += `${(e as Error).message}\n`;
      }
      await mkdir(dirname(input.logPaths.stdout), { recursive: true });
      await writeFile(input.logPaths.stdout, opts.stdout ?? "", "utf8");
      await writeFile(input.logPaths.stderr, stderr, "utf8");
      return { exitCode, timedOut: opts.timedOut ?? false };
    },
  };
}
