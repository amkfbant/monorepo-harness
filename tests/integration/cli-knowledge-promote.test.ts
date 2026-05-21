import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setup(): { root: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-knw-cli-"));
  mkdirSync(join(root, "runs"), { recursive: true });
  const runId = "run-20260521-apps-user-knw01";
  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "events.jsonl"), "");
  writeFileSync(
    join(runDir, "knowledge-candidates.yaml"),
    [
      "candidates:",
      "  - kind: policy_improvement",
      "    domain: apps/user",
      "    title: needs cross-domain step",
      "    content: codex tried to edit contracts",
      "    evidence:",
      `      - ${runId}`,
      "    confidence: medium",
      "    status: candidate",
      "  - kind: secret_suspect",
      "    domain: apps/user",
      "    title: env file appeared",
      "    content: filename heuristic hit",
      "    evidence:",
      `      - ${runId}`,
      "    confidence: low",
      "    status: candidate",
      "",
    ].join("\n"),
  );
  return { root, runId };
}

function run(
  args: string[],
  harnessRoot: string,
): { stdout: string; stderr: string; status: number } {
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

describe("harness knowledge list", () => {
  it("lists candidates with their status", () => {
    const { root, runId } = setup();
    const { stdout, status } = run(
      ["knowledge", "list", "--run-id", runId],
      root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/\[0\] candidate/);
    expect(stdout).toMatch(/\[1\] candidate/);
    expect(stdout).toMatch(/needs cross-domain step/);
  });

  it("--kind filters the listing", () => {
    const { root, runId } = setup();
    const { stdout } = run(
      ["knowledge", "list", "--run-id", runId, "--kind", "secret_suspect"],
      root,
    );
    expect(stdout).toMatch(/env file appeared/);
    expect(stdout).not.toMatch(/needs cross-domain step/);
  });
});

describe("harness knowledge reject", () => {
  it("records a reject decision and lists it as rejected", () => {
    const { root, runId } = setup();
    const rej = run(
      [
        "knowledge",
        "reject",
        "--run-id",
        runId,
        "--index",
        "1",
        "--reviewer",
        "knkn",
        "--reason",
        "too specific",
      ],
      root,
    );
    expect(rej.status).toBe(0);
    expect(rej.stdout).toMatch(/rejected candidate 1 by knkn/);
    expect(
      existsSync(join(root, "runs", runId, "knowledge-decisions.yaml")),
    ).toBe(true);
    const list = run(["knowledge", "list", "--run-id", runId], root);
    expect(list.stdout).toMatch(/\[1\] rejected \(by knkn\)/);
  });

  it("exit 1 on an out-of-range index", () => {
    const { root, runId } = setup();
    const r = run(
      [
        "knowledge",
        "reject",
        "--run-id",
        runId,
        "--index",
        "9",
        "--reviewer",
        "knkn",
      ],
      root,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/out of range/);
  });
});

describe("harness knowledge promote", () => {
  it("requires --reviewer (commander rejects a missing required option)", () => {
    const { root, runId } = setup();
    const r = run(["knowledge", "promote", "--run-id", runId], root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/reviewer/);
  });

  it("promotes candidates and writes md with frontmatter", () => {
    const { root, runId } = setup();
    const { stdout, status } = run(
      ["knowledge", "promote", "--run-id", runId, "--reviewer", "knkn"],
      root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/promoted=2 skipped=0/);
    const dir = join(root, "docs", "knowledge", "policy_improvement");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(dir, files[0]!), "utf8");
    expect(body).toMatch(/promoted_by: "knkn"/);
    expect(body).toMatch(/^hash: [0-9a-f]{16}$/m);
  });

  it("skips a rejected candidate", () => {
    const { root, runId } = setup();
    run(
      [
        "knowledge",
        "reject",
        "--run-id",
        runId,
        "--index",
        "0",
        "--reviewer",
        "knkn",
        "--reason",
        "x",
      ],
      root,
    );
    const { stdout } = run(
      ["knowledge", "promote", "--run-id", runId, "--reviewer", "knkn"],
      root,
    );
    expect(stdout).toMatch(/promoted=1 skipped=1/);
    expect(stdout).toMatch(/skipped \[0\] rejected/);
  });

  it("a second promote is idempotent (duplicate-index skip)", () => {
    const { root, runId } = setup();
    run(
      ["knowledge", "promote", "--run-id", runId, "--reviewer", "knkn"],
      root,
    );
    const { stdout } = run(
      ["knowledge", "promote", "--run-id", runId, "--reviewer", "knkn"],
      root,
    );
    expect(stdout).toMatch(/promoted=0 skipped=2/);
    expect(stdout).toMatch(/duplicate-index/);
  });
});
