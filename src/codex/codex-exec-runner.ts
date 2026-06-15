export interface CodexRunInputs {
  worktreePath: string;
  prompt: string;
  logPaths: {
    stdout: string;
    stderr: string;
    events: string;
  };
  /**
   * Abort the in-flight codex process (#132). When the course orchestrator loses
   * its lease mid-drive it aborts this signal; the runner SIGKILLs the codex
   * process tree (fail-closed — a killed codex exits non-zero, so the run is
   * finalized `failed-codex`). An already-aborted signal short-circuits before
   * spawn (no codex is launched once the lease is gone).
   */
  signal?: AbortSignal;
}

export interface CodexRunResult {
  exitCode: number;
  timedOut: boolean;
  /**
   * True when the run was killed (or never spawned) due to an AbortSignal (#132).
   * Optional: production finalizes a killed run via the non-zero exit code, not
   * this flag, so signal-unaware runners/fakes may omit it.
   */
  aborted?: boolean;
  durationMs: number;
}

export interface CodexExecRunner {
  run(inputs: CodexRunInputs): Promise<CodexRunResult>;
}
