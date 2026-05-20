import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  writeFileSync(join(root, "policies/global.yaml"), "always_deny_write: []\n");
  writeFileSync(
    join(root, "policies/repos/t.yaml"),
    [
      "repo_id: t",
      "read: []",
      "domains:",
      "  apps/user:",
      "    read: []",
      "    write: [apps/user/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );
  return root;
}

describe("CLI run --dry-run", () => {
  it("resolves policy and exits 0", () => {
    const harness = setupHarness();
    const out = execFileSync(
      "node",
      [
        "--import",
        "tsx",
        CLI,
        "run",
        "--repo",
        "/tmp/no-repo",
        "--repo-id",
        "t",
        "--domain",
        "apps/user",
        "--goal",
        "noop",
        "--dry-run",
      ],
      { env: { ...process.env, HARNESS_ROOT: harness } },
    ).toString();
    expect(out).toMatch(/resolved/i);
    expect(out).toMatch(/apps\/user/);
  });
});
