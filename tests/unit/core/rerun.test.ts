import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRerunFromReview } from "../../../src/core/rerun.js";

interface SetupOpts {
  status?: string;
  decision?: string;
  required_changes?: string[];
  reviewer?: string | null;
  parentGoal?: string;
}

function setup(opts: SetupOpts = {}): { runsDir: string; runId: string } {
  const runsDir = mkdtempSync(join(tmpdir(), "harness-rerun-"));
  const runId = "run-20260521-apps-user-aaa";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        runId,
        repoId: "t",
        repoPath: "/tmp/t",
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "abc",
        runBranch: "harness/x",
        status: opts.status ?? "changes_requested",
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  const reviewerLine =
    opts.reviewer === undefined
      ? "reviewer: alice"
      : opts.reviewer === null
        ? "reviewer: null"
        : `reviewer: ${opts.reviewer}`;
  const reqChanges =
    opts.required_changes ?? ["fix validation", "add test for empty input"];
  writeFileSync(
    join(runDir, "review-decision.yaml"),
    [
      `runId: ${runId}`,
      "domain: apps/user",
      `decision: ${opts.decision ?? "changes_requested"}`,
      reqChanges.length === 0
        ? "required_changes: []"
        : `required_changes:\n${reqChanges.map((c) => `  - "${c}"`).join("\n")}`,
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      reviewerLine,
      "reviewed_at: 2026-05-21T00:01:00Z",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(runDir, "codex-prompt.md"),
    [
      "You are working on a monorepo domain task.",
      "",
      "Goal:",
      opts.parentGoal ?? "Add category validation to product search.",
      "",
      "Target domain:",
      "apps/user",
      "",
      "You may edit only:",
      "- apps/user/**",
    ].join("\n"),
  );
  return { runsDir, runId };
}

describe("prepareRerunFromReview", () => {
  it("returns repoId / domain / baseBranch + a new goal that embeds parent context", async () => {
    const { runsDir, runId } = setup({
      parentGoal: "Add category validation to product search.",
      required_changes: ["fix the empty-string case", "use err() consistently"],
    });
    const r = await prepareRerunFromReview({ runsDir, parentRunId: runId });
    expect(r.parentRunId).toBe(runId);
    expect(r.repoId).toBe("t");
    expect(r.domain).toBe("apps/user");
    expect(r.baseBranch).toBe("main");
    expect(r.goal).toMatch(/Add category validation/);
    expect(r.goal).toMatch(/Required changes from the previous review/);
    expect(r.goal).toMatch(/fix the empty-string case/);
    expect(r.goal).toMatch(/use err\(\) consistently/);
    expect(r.goal).toMatch(/Previous run: run-20260521-apps-user-aaa/);
  });

  it("rejects parentRunId that does not match RUN_ID_RE", async () => {
    await expect(
      prepareRerunFromReview({ runsDir: "/tmp", parentRunId: "../escape" }),
    ).rejects.toThrow(/invalid parentRunId/);
  });

  it("rejects parent run whose status is not changes_requested", async () => {
    const { runsDir, runId } = setup({ status: "approved" });
    await expect(
      prepareRerunFromReview({ runsDir, parentRunId: runId }),
    ).rejects.toThrow(/changes_requested/);
  });

  it("rejects review-decision that is not changes_requested", async () => {
    const { runsDir, runId } = setup({ decision: "approved" });
    await expect(
      prepareRerunFromReview({ runsDir, parentRunId: runId }),
    ).rejects.toThrow(/decision=changes_requested/);
  });

  it("rejects when required_changes is empty (no actionable instructions)", async () => {
    const { runsDir, runId } = setup({ required_changes: [] });
    await expect(
      prepareRerunFromReview({ runsDir, parentRunId: runId }),
    ).rejects.toThrow(/required_changes/);
  });

  it("falls back to a stub when parent codex-prompt.md is missing or unparseable", async () => {
    const { runsDir, runId } = setup({});
    // remove the prompt file
    const { rmSync } = await import("node:fs");
    rmSync(join(runsDir, runId, "codex-prompt.md"));
    const r = await prepareRerunFromReview({ runsDir, parentRunId: runId });
    expect(r.goal).toMatch(/parent goal could not be recovered/);
    expect(r.goal).toMatch(/Required changes from the previous review/);
  });
});
