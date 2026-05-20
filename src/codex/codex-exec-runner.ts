export interface CodexRunInputs {
  worktreePath: string;
  prompt: string;
  logPaths: {
    stdout: string;
    stderr: string;
  };
}

export interface CodexRunResult {
  exitCode: number;
}

export interface CodexExecRunner {
  run(inputs: CodexRunInputs): Promise<CodexRunResult>;
}
