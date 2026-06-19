import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReviewerInputDirHasNoVerdict,
  materializeReviewerInput,
  suppressRunDirVerdictFiles,
} from "../../../src/core/reviewer-artifact-isolation.js";
import { ReviewerAgentGateError } from "../../../src/core/reviewer-agent-errors.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-isoassert-"));
}

describe("assertReviewerInputDirHasNoVerdict (#272 fail-closed guard)", () => {
  it("rejects a verdict file at the root of the input dir", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "final-diff.patch"), "diff\n");
    writeFileSync(join(dir, "review-decision.yaml"), "decision: approved\n");
    await expect(assertReviewerInputDirHasNoVerdict(dir)).rejects.toThrow(
      ReviewerAgentGateError,
    );
    await expect(assertReviewerInputDirHasNoVerdict(dir)).rejects.toThrow(
      /review-decision\.yaml/,
    );
  });

  it("rejects a verdict nested under a reviewers/<id>/ subtree", async () => {
    const dir = tmpDir();
    const sib = join(dir, "reviewers", "bob");
    mkdirSync(sib, { recursive: true });
    writeFileSync(join(sib, "review-decision.yaml"), "decision: approved\n");
    await expect(assertReviewerInputDirHasNoVerdict(dir)).rejects.toThrow(
      ReviewerAgentGateError,
    );
  });

  it("rejects a stray review-auto-error.json at any depth", async () => {
    const dir = tmpDir();
    const nested = join(dir, "commands", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "review-auto-error.json"), "{}\n");
    await expect(assertReviewerInputDirHasNoVerdict(dir)).rejects.toThrow(
      ReviewerAgentGateError,
    );
  });

  it("resolves when only allowed inputs are present", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "final-diff.patch"), "diff\n");
    writeFileSync(join(dir, "review-request.md"), "# review\n");
    const cmds = join(dir, "commands");
    mkdirSync(cmds, { recursive: true });
    writeFileSync(join(cmds, "build.out.log"), "ok\n");
    writeFileSync(join(cmds, "test.out.log"), "ok\n");
    await expect(
      assertReviewerInputDirHasNoVerdict(dir),
    ).resolves.toBeUndefined();
  });

  it("matches only exact basenames (a command log named like a verdict is fine)", async () => {
    const dir = tmpDir();
    const cmds = join(dir, "commands");
    mkdirSync(cmds, { recursive: true });
    // not an exact basename match — must NOT trip the guard
    writeFileSync(join(cmds, "review-decision.yaml.out.log"), "log\n");
    writeFileSync(join(cmds, "my-review-decision.yaml"), "log\n");
    await expect(
      assertReviewerInputDirHasNoVerdict(dir),
    ).resolves.toBeUndefined();
  });
});

describe("materializeReviewerInput + guard integration (#272)", () => {
  it("does not copy a sibling/root verdict into the input dir, and the guard passes", async () => {
    const runDir = tmpDir();
    const inputDir = join(tmpDir(), "input");
    // run dir holds the verdict + a sibling reviewer verdict + allowed inputs
    writeFileSync(join(runDir, "final-diff.patch"), "diff\n");
    writeFileSync(join(runDir, "review-request.md"), "# review\n");
    writeFileSync(join(runDir, "review-decision.yaml"), "decision: approved\n");
    const sib = join(runDir, "reviewers", "bob");
    mkdirSync(sib, { recursive: true });
    writeFileSync(join(sib, "review-decision.yaml"), "decision: approved\n");

    await materializeReviewerInput(runDir, inputDir);
    // the allowlist already excludes verdicts; the guard is the deterministic
    // backstop and must pass on the correctly-materialized dir.
    await expect(
      assertReviewerInputDirHasNoVerdict(inputDir),
    ).resolves.toBeUndefined();
  });
});

describe("suppressRunDirVerdictFiles (#272 root + scoped cleanup)", () => {
  it("removes the root verdict and every scoped reviewer verdict", async () => {
    const runDir = tmpDir();
    writeFileSync(join(runDir, "review-decision.yaml"), "decision: approved\n");
    writeFileSync(join(runDir, "final-diff.patch"), "diff\n"); // must survive
    for (const r of ["alice", "bob"]) {
      const d = join(runDir, "reviewers", r);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "review-decision.yaml"), "decision: approved\n");
      writeFileSync(join(d, "reviewer-agent.out.log"), "log\n"); // must survive
    }

    const removed = await suppressRunDirVerdictFiles(runDir);

    expect(removed.sort()).toEqual([
      "review-decision.yaml",
      "reviewers/alice/review-decision.yaml",
      "reviewers/bob/review-decision.yaml",
    ]);
    expect(existsSync(join(runDir, "review-decision.yaml"))).toBe(false);
    expect(
      existsSync(join(runDir, "reviewers", "alice", "review-decision.yaml")),
    ).toBe(false);
    expect(
      existsSync(join(runDir, "reviewers", "bob", "review-decision.yaml")),
    ).toBe(false);
    // non-verdict artifacts are untouched
    expect(existsSync(join(runDir, "final-diff.patch"))).toBe(true);
    expect(
      existsSync(join(runDir, "reviewers", "alice", "reviewer-agent.out.log")),
    ).toBe(true);
  });

  it("is a no-op (no throw, empty result) when no verdict files exist", async () => {
    const runDir = tmpDir();
    writeFileSync(join(runDir, "final-diff.patch"), "diff\n");
    const removed = await suppressRunDirVerdictFiles(runDir);
    expect(removed).toEqual([]);
    expect(existsSync(join(runDir, "final-diff.patch"))).toBe(true);
  });
});
