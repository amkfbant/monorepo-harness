import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(
  root: string,
  args: string[],
): { out: string; stderr: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: root },
    }).toString();
    return { out, stderr: "", code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      code: err.status ?? 1,
    };
  }
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-goal-stub-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  return root;
}

describe("removed goal command", () => {
  it("is rejected by commander as an unknown command", () => {
    const root = newRoot();
    const { code, stderr } = runCli(root, ["goal"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/error: unknown command 'goal'/i);
  });
});
