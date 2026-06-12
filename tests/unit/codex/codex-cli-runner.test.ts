import { describe, it, expect } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexCliRunner,
  filterEnv,
  DEFAULT_CODEX_ENV_ALLOWLIST,
} from "../../../src/codex/codex-cli-runner.js";

describe("filterEnv", () => {
  it("includes only allowlisted variables", () => {
    const out = filterEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        SECRET_KEY: "leak-me",
        OPENAI_API_KEY: "leak-me-too",
      } as NodeJS.ProcessEnv,
      ["PATH", "HOME"],
    );
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(out).not.toHaveProperty("SECRET_KEY");
    expect(out).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("default allowlist excludes secrets-like env vars", () => {
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).toContain("PATH");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).toContain("HOME");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).not.toContain("OPENAI_API_KEY");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).not.toContain("AWS_SECRET_ACCESS_KEY");
  });
});

function writeExecutableScript(dir: string, body: string): string {
  const path = join(dir, "fake-codex.js");
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("createCodexCliRunner", () => {
  it("returns durationMs for elapsed successful work", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-codex-cli-"));
    const codexBin = writeExecutableScript(
      wt,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  setTimeout(() => {",
        "    process.stdout.write('ok\\n', () => process.exit(0));",
        "  }, 50);",
        "});",
      ].join("\n"),
    );
    const runner = createCodexCliRunner({
      codexBin,
      envAllowlist: ["PATH"],
    });

    const result = await runner.run({
      worktreePath: wt,
      prompt: "hello",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toEqual(expect.any(Number));
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
    expect(readFileSync(join(wt, "out.log"), "utf8")).toBe("ok\n");
  });

  it("returns durationMs on timeout", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-codex-cli-timeout-"));
    const codexBin = writeExecutableScript(
      wt,
      [
        "process.stdin.resume();",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const runner = createCodexCliRunner({
      codexBin,
      envAllowlist: ["PATH"],
      timeoutMs: 60,
    });

    const result = await runner.run({
      worktreePath: wt,
      prompt: "hello",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
      },
    });

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toEqual(expect.any(Number));
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });
});
