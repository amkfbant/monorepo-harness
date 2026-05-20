import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitCli } from "../../../src/git/git-cli.js";

let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "harness-git-"));
  const r = (args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "test@example.com"]);
  r(["config", "user.name", "Test"]);
  writeFileSync(join(repoRoot, "README.md"), "hi\n");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);
});

describe("gitCli", () => {
  it("runs `git rev-parse --abbrev-ref HEAD`", async () => {
    const { stdout, exitCode } = await gitCli(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoRoot },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("main");
  });

  it("captures stderr and non-zero exit on failure", async () => {
    const r = await gitCli(["rev-parse", "--abbrev-ref", "no-such-ref"], {
      cwd: repoRoot,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown|fatal|ambiguous/i);
  });
});
