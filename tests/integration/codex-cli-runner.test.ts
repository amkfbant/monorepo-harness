import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexCliRunner } from "../../src/codex/codex-cli-runner.js";

const HAS_CODEX = process.env.HARNESS_E2E_CODEX === "1";

describe.skipIf(!HAS_CODEX)("codex-cli-runner (real codex)", () => {
  it("invokes codex exec and writes stdout/stderr logs", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-codex-"));
    const runner = createCodexCliRunner({ codexBin: "codex" });
    const r = await runner.run({
      worktreePath: wt,
      prompt: "print 'hello' and exit",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
        events: join(wt, "events.jsonl"),
      },
    });
    expect(typeof r.exitCode).toBe("number");
  });
});
