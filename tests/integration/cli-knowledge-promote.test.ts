import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
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
  const root = mkdtempSync(join(tmpdir(), "harness-promote-cli-"));
  mkdirSync(join(root, "runs"), { recursive: true });
  const runId = "run-20260521-apps-user-promo01";
  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({ runId, domain: "apps/user" }),
  );
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
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: harnessRoot },
    }).toString();
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      status: err.status ?? 1,
    };
  }
}

describe("harness knowledge promote", () => {
  it("writes one md per candidate under docs/knowledge/<kind>/", () => {
    const { root, runId } = setup();
    const { stdout, status } = run(
      ["knowledge", "promote", "--run-id", runId],
      root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/promoted=2 skipped=0/);
    const outDir = join(root, "docs", "knowledge");
    expect(existsSync(join(outDir, "policy_improvement"))).toBe(true);
    expect(existsSync(join(outDir, "secret_suspect"))).toBe(true);
    expect(
      readdirSync(join(outDir, "policy_improvement")),
    ).toHaveLength(1);
  });

  it("--kind filters to a single category", () => {
    const { root, runId } = setup();
    const { stdout, status } = run(
      ["knowledge", "promote", "--run-id", runId, "--kind", "secret_suspect"],
      root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/promoted=1 skipped=1/);
    expect(
      existsSync(join(root, "docs", "knowledge", "policy_improvement")),
    ).toBe(false);
    expect(existsSync(join(root, "docs", "knowledge", "secret_suspect"))).toBe(
      true,
    );
  });

  it("--out overrides the destination root", () => {
    const { root, runId } = setup();
    const customOut = join(root, "custom-knowledge");
    const { status } = run(
      ["knowledge", "promote", "--run-id", runId, "--out", customOut],
      root,
    );
    expect(status).toBe(0);
    expect(existsSync(join(customOut, "policy_improvement"))).toBe(true);
    expect(existsSync(join(root, "docs", "knowledge"))).toBe(false);
  });

  it("exit 1 for invalid run id", () => {
    const { root } = setup();
    const { stdout, status } = run(
      ["knowledge", "promote", "--run-id", "../escape"],
      root,
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/invalid runId/);
  });

  it("exit 1 when knowledge-candidates.yaml is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-promote-cli-"));
    mkdirSync(join(root, "runs", "run-20260521-x-y"), { recursive: true });
    const { stdout, status } = run(
      ["knowledge", "promote", "--run-id", "run-20260521-x-y"],
      root,
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/not found/);
  });

  it("emits knowledge_promoted event into events.jsonl", () => {
    const { root, runId } = setup();
    run(["knowledge", "promote", "--run-id", runId], root);
    const lines = readFileSync(
      join(root, "runs", runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.find((e) => e.type === "knowledge_promoted")).toBeDefined();
  });
});
