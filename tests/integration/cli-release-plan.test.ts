import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

describe("harness release plan", () => {
  // v0.3.0 / v0.5.0 are immutable tags, so these facts are stable forever.
  it("computes the schema delta + surface diff for a historical tag range", () => {
    const r = run(["release", "plan", "--since", "v0.3.0", "--to", "v0.5.0", "--json"]);
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.schema.fromVersion).toBe(18);
    expect(plan.schema.toVersion).toBe(19);
    expect(plan.schema.changed).toBe(true);
    expect(plan.schema.noDowngrade).toBe(true);
    expect(plan.schema.destructive).toBe(false);
    expect(plan.mcpTools.added).toContain("harness.ops_knowledge.search");
    expect(plan.mcpTools.removed).toEqual([]); // no breaking surface removal
  });

  it("reports nothing for an empty range (since == to)", () => {
    const r = run(["release", "plan", "--since", "v0.5.0", "--to", "v0.5.0", "--json"]);
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.commits).toEqual([]);
    expect(plan.recommendedBump).toBe("none");
    expect(plan.schema.changed).toBe(false);
  });

  it("text output is readable and labels the no-downgrade caveat", () => {
    const r = run(["release", "plan", "--since", "v0.3.0", "--to", "v0.5.0"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/schema: 18 → 19/);
    expect(r.stdout).toMatch(/no downgrade/i);
  });

  it("exits 1 on an unresolvable --since ref", () => {
    const r = run(["release", "plan", "--since", "v999.999.999"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot resolve/i);
  });
});
