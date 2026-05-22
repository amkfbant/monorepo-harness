import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[]): RunResult {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-index-removed-"));
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, HARNESS_ROOT: harnessRoot },
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

// Phase 8-7: index.sqlite / `harness index` were removed. The command is
// kept one phase as an explicit error stub so the CLI does not silently
// 404 — it must point at the harness.sqlite read model instead.
describe("harness index (removed stub)", () => {
  it("errors and points at the DB read model", () => {
    const r = run(["index"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/removed/i);
    expect(r.stderr).toContain("harness db status");
    expect(r.stderr).toContain("harness db check-consistency");
  });

  it("errors for the former subcommands too", () => {
    for (const sub of ["rebuild", "status", "show"]) {
      const r = run(["index", sub]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/removed/i);
    }
  });

  it("errors on a former subcommand invoked with its options", () => {
    // the operational form `index show --run-id <id>`: allowUnknownOption()
    // keeps commander from rejecting `--run-id` before the stub runs.
    const r = run(["index", "show", "--run-id", "run-abc"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/removed/i);
    expect(r.stderr).toContain("harness db status");
  });
});
