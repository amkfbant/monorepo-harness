import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(root: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: root },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

/** `backlog add` an item; returns its item id. */
function addItem(root: string, extraArgs: string[]): string {
  const { out, code } = runCli(root, [
    "backlog",
    "add",
    "--title",
    "t",
    "--domain",
    "apps/web",
    "--goal",
    "g",
    ...extraArgs,
  ]);
  expect(code).toBe(0);
  const m = out.match(/added (item-\S+)/);
  if (!m) throw new Error(`could not parse item id from: ${out}`);
  return m[1] as string;
}

describe("CLI backlog run — mode selection (Phase 6-1)", () => {
  it("rejects --repo-id for an item that has a project", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blr-"));
    const itemId = addItem(root, ["--project", "demo"]);
    const { out, code } = runCli(root, [
      "backlog",
      "run",
      "--item-id",
      itemId,
      "--repo-id",
      "demo",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/--repo-id is not used/);
  });

  it("requires --repo + --repo-id for an item without a project", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blr-"));
    const itemId = addItem(root, []);
    const { out, code } = runCli(root, [
      "backlog",
      "run",
      "--item-id",
      itemId,
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/requires --repo \+ --repo-id/);
  });
});
