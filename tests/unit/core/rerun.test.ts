import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareRerunFromReview,
  buildRerunChain,
  formatChain,
} from "../../../src/core/rerun.js";

interface SetupOpts {
  status?: string;
  decision?: string;
  required_changes?: string[];
  reviewer?: string | null;
  parentGoal?: string;
  runId?: string;
  parentRunId?: string;
  rootRunId?: string;
  rerunAttempt?: number;
  /** when set, the parent meta carries a project block (a --project run) */
  projectId?: string;
}

/** Write one run dir; returns its runId. */
function writeRun(runsDir: string, opts: SetupOpts = {}): string {
  const runId = opts.runId ?? "run-20260521-apps-user-aaa";
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
        ...(opts.parentRunId !== undefined
          ? { parentRunId: opts.parentRunId }
          : {}),
        ...(opts.rootRunId !== undefined
          ? { rootRunId: opts.rootRunId }
          : {}),
        ...(opts.rerunAttempt !== undefined
          ? { rerunAttempt: opts.rerunAttempt }
          : {}),
        ...(opts.projectId !== undefined
          ? {
              project: {
                projectId: opts.projectId,
                profilePath: `/tmp/projects/${opts.projectId}.yaml`,
                profileVersion: 1,
                commandPresetIds: [],
                contextPackIds: [],
              },
            }
          : {}),
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
  return runId;
}

/** Create a fresh runsDir with one run; returns { runsDir, runId }. */
function setup(opts: SetupOpts = {}): { runsDir: string; runId: string } {
  const runsDir = mkdtempSync(join(tmpdir(), "harness-rerun-"));
  const runId = writeRun(runsDir, opts);
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

  it("carries projectId when the parent was a --project run (Phase 6-1)", async () => {
    const { runsDir, runId } = setup({ projectId: "mini-commerce" });
    const r = await prepareRerunFromReview({ runsDir, parentRunId: runId });
    expect(r.projectId).toBe("mini-commerce");
  });

  it("omits projectId when the parent was a --repo-id run", async () => {
    const { runsDir, runId } = setup();
    const r = await prepareRerunFromReview({ runsDir, parentRunId: runId });
    expect(r.projectId).toBeUndefined();
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

  it("rejects when parent goal + required_changes would exceed the rerun prompt budget", async () => {
    const huge = "x".repeat(80 * 1024);
    const { runsDir, runId } = setup({ parentGoal: huge });
    await expect(
      prepareRerunFromReview({ runsDir, parentRunId: runId }),
    ).rejects.toThrow(/cap is/);
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

  describe("rootRunId / rerunAttempt", () => {
    it("from an original parent: rootRunId = parent, rerunAttempt = 1", async () => {
      const { runsDir, runId } = setup({}); // no rootRunId/rerunAttempt
      const r = await prepareRerunFromReview({ runsDir, parentRunId: runId });
      expect(r.rootRunId).toBe(runId);
      expect(r.rerunAttempt).toBe(1);
      expect(r.goal).toMatch(/Rerun attempt: 1/);
    });

    it("from a rerun parent: rootRunId carried, rerunAttempt incremented", async () => {
      const runsDir = mkdtempSync(join(tmpdir(), "harness-rerun-"));
      writeRun(runsDir, {
        runId: "run-20260521-apps-user-child",
        parentRunId: "run-20260521-apps-user-root",
        rootRunId: "run-20260521-apps-user-root",
        rerunAttempt: 1,
      });
      const r = await prepareRerunFromReview({
        runsDir,
        parentRunId: "run-20260521-apps-user-child",
      });
      expect(r.rootRunId).toBe("run-20260521-apps-user-root");
      expect(r.rerunAttempt).toBe(2);
    });
  });

  describe("--max-attempts gate", () => {
    it("refuses when the child would exceed max-attempts", async () => {
      const runsDir = mkdtempSync(join(tmpdir(), "harness-rerun-"));
      // parent already at attempt 2 → child would be 3
      writeRun(runsDir, {
        runId: "run-20260521-apps-user-c2",
        parentRunId: "run-20260521-apps-user-c1",
        rootRunId: "run-20260521-apps-user-root",
        rerunAttempt: 2,
      });
      await expect(
        prepareRerunFromReview({
          runsDir,
          parentRunId: "run-20260521-apps-user-c2",
          maxAttempts: 2,
        }),
      ).rejects.toThrow(/exceeding --max-attempts 2/);
    });

    it("allows the child exactly at the cap", async () => {
      const runsDir = mkdtempSync(join(tmpdir(), "harness-rerun-"));
      writeRun(runsDir, {
        runId: "run-20260521-apps-user-c1",
        parentRunId: "run-20260521-apps-user-root",
        rootRunId: "run-20260521-apps-user-root",
        rerunAttempt: 1,
      });
      const r = await prepareRerunFromReview({
        runsDir,
        parentRunId: "run-20260521-apps-user-c1",
        maxAttempts: 2,
      });
      expect(r.rerunAttempt).toBe(2);
    });

    it("rejects a non-positive max-attempts", async () => {
      const { runsDir, runId } = setup({});
      await expect(
        prepareRerunFromReview({
          runsDir,
          parentRunId: runId,
          maxAttempts: 0,
        }),
      ).rejects.toThrow(/maxAttempts must be a positive integer/);
    });

    it("reconstructs depth for a LEGACY chain (parentRunId but no chain fields)", async () => {
      const runsDir = mkdtempSync(join(tmpdir(), "harness-rerun-"));
      // root → c1 → c2, none carrying rootRunId / rerunAttempt (pre-2-7)
      writeRun(runsDir, { runId: "run-20260521-x-root" });
      writeRun(runsDir, {
        runId: "run-20260521-x-c1",
        parentRunId: "run-20260521-x-root",
      });
      writeRun(runsDir, {
        runId: "run-20260521-x-c2",
        parentRunId: "run-20260521-x-c1",
      });
      // rerun from the legacy leaf: parent depth is 2 → child attempt 3
      const r = await prepareRerunFromReview({
        runsDir,
        parentRunId: "run-20260521-x-c2",
        maxAttempts: 5,
      });
      expect(r.rerunAttempt).toBe(3);
      expect(r.rootRunId).toBe("run-20260521-x-root");
      // and --max-attempts can no longer be bypassed by a legacy chain
      await expect(
        prepareRerunFromReview({
          runsDir,
          parentRunId: "run-20260521-x-c2",
          maxAttempts: 2,
        }),
      ).rejects.toThrow(/exceeding --max-attempts 2/);
    });
  });

  describe("convergence advisory", () => {
    it("warns when required_changes are identical to the grandparent's", async () => {
      const runsDir = mkdtempSync(join(tmpdir(), "harness-rerun-"));
      const sameChanges = ["fix validation", "add test"];
      // grandparent (the previous rerun base) with the same changes
      writeRun(runsDir, {
        runId: "run-20260521-apps-user-gp",
        required_changes: sameChanges,
      });
      // parent points at the grandparent and asks for the SAME changes
      writeRun(runsDir, {
        runId: "run-20260521-apps-user-p",
        parentRunId: "run-20260521-apps-user-gp",
        rootRunId: "run-20260521-apps-user-gp",
        rerunAttempt: 1,
        required_changes: sameChanges,
      });
      const r = await prepareRerunFromReview({
        runsDir,
        parentRunId: "run-20260521-apps-user-p",
      });
      expect(r.warnings.some((w) => /not converging/.test(w))).toBe(true);
    });

    it("no warning when required_changes differ from the grandparent's", async () => {
      const runsDir = mkdtempSync(join(tmpdir(), "harness-rerun-"));
      writeRun(runsDir, {
        runId: "run-20260521-apps-user-gp",
        required_changes: ["original feedback"],
      });
      writeRun(runsDir, {
        runId: "run-20260521-apps-user-p",
        parentRunId: "run-20260521-apps-user-gp",
        rootRunId: "run-20260521-apps-user-gp",
        rerunAttempt: 1,
        required_changes: ["different feedback"],
      });
      const r = await prepareRerunFromReview({
        runsDir,
        parentRunId: "run-20260521-apps-user-p",
      });
      expect(r.warnings).toEqual([]);
    });
  });
});

describe("buildRerunChain / formatChain", () => {
  it("assembles a root → child → grandchild chain from any member", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-chain-"));
    writeRun(runsDir, {
      runId: "run-20260521-x-root",
      status: "changes_requested",
    });
    writeRun(runsDir, {
      runId: "run-20260521-x-c1",
      parentRunId: "run-20260521-x-root",
      rootRunId: "run-20260521-x-root",
      rerunAttempt: 1,
      status: "changes_requested",
    });
    writeRun(runsDir, {
      runId: "run-20260521-x-c2",
      parentRunId: "run-20260521-x-c1",
      rootRunId: "run-20260521-x-root",
      rerunAttempt: 2,
      status: "approved",
    });
    // building from the leaf should still produce the full chain
    const chain = await buildRerunChain({
      runsDir,
      runId: "run-20260521-x-c2",
    });
    expect(chain.runId).toBe("run-20260521-x-root");
    expect(chain.children).toHaveLength(1);
    expect(chain.children[0]?.runId).toBe("run-20260521-x-c1");
    expect(chain.children[0]?.children[0]?.runId).toBe("run-20260521-x-c2");
    const text = formatChain(chain);
    expect(text).toMatch(/run-20260521-x-root/);
    expect(text).toMatch(/run-20260521-x-c2.*approved/);
  });

  it("rejects an invalid runId", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-chain-"));
    await expect(
      buildRerunChain({ runsDir, runId: "../escape" }),
    ).rejects.toThrow(/invalid runId/);
  });

  it("rejects a runId with no run dir", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-chain-"));
    await expect(
      buildRerunChain({ runsDir, runId: "run-20260521-missing" }),
    ).rejects.toThrow(/not found/);
  });

  it("a standalone run is its own single-node chain", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-chain-"));
    writeRun(runsDir, { runId: "run-20260521-solo" });
    const chain = await buildRerunChain({
      runsDir,
      runId: "run-20260521-solo",
    });
    expect(chain.runId).toBe("run-20260521-solo");
    expect(chain.children).toEqual([]);
  });

  it("formatChain renders branches: ├─ for siblings, └─ for the last", () => {
    const text = formatChain({
      runId: "root",
      status: "changes_requested",
      parentRunId: null,
      rerunAttempt: null,
      children: [
        {
          runId: "child-a",
          status: "rejected",
          parentRunId: "root",
          rerunAttempt: 1,
          children: [],
        },
        {
          runId: "child-b",
          status: "approved",
          parentRunId: "root",
          rerunAttempt: 1,
          children: [
            {
              runId: "grandchild",
              status: "needs_review",
              parentRunId: "child-b",
              rerunAttempt: 2,
              children: [],
            },
          ],
        },
      ],
    });
    expect(text).toMatch(/├─ child-a/);
    expect(text).toMatch(/└─ child-b/);
    // grandchild sits under the last child, so its guide is spaces not │
    expect(text).toMatch(/ {3}└─ grandchild/);
  });
});
