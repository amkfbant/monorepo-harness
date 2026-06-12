import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexCliRunner } from "../../src/codex/codex-cli-runner.js";

describe("createCodexCliRunner stdin robustness", () => {
  it("does not crash when codex exits before draining the prompt (EPIPE)", async () => {
    // A codex that ignores stdin and exits immediately — like a crashed or
    // fast-failing real codex, or the fake bins used in cli-rerun tests. With a
    // prompt larger than the OS pipe buffer, child.stdin.write cannot drain
    // before the child closes the pipe, surfacing EPIPE. Without a stdin error
    // handler that EPIPE is unhandled and crashes the harness (exit 1) — which
    // is exactly what failed on CI (Linux) while passing locally (macOS).
    const dir = mkdtempSync(join(tmpdir(), "harness-epipe-"));
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);

    const runner = createCodexCliRunner({ codexBin: bin });
    const result = await runner.run({
      prompt: "x".repeat(1_000_000), // exceeds the ~64KB pipe buffer
      worktreePath: dir,
      logPaths: {
        stdout: join(dir, "out.log"),
        stderr: join(dir, "err.log"),
        events: join(dir, "events.jsonl"),
      },
    });

    // The child's exit code is the source of truth; a closed stdin pipe must
    // not turn a clean exit into a harness crash.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });
});
