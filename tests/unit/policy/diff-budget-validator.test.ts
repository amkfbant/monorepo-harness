import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANGE_BUDGET,
  type ChangeBudget,
} from "../../../src/policy/schema.js";
import {
  validateDiffBudget,
  type DiffBudgetInput,
} from "../../../src/policy/diff-budget-validator.js";

const BASE_STAT = {
  filesChanged: 1,
  insertions: 0,
  deletions: 0,
  deletedFiles: 0,
};

function budget(patch: Partial<ChangeBudget>): DiffBudgetInput {
  return { ...DEFAULT_CHANGE_BUDGET, ...patch };
}

describe("validateDiffBudget", () => {
  it("allows each metric exactly at its inclusive limit", () => {
    const r = validateDiffBudget(
      budget({
        maxDeletedLines: 10,
        maxTotalChangedLines: 30,
        maxDeletedFiles: 2,
        maxChangedFiles: 4,
      }),
      {
        filesChanged: 4,
        insertions: 20,
        deletions: 10,
        deletedFiles: 2,
      },
    );

    expect(r.status).toBe("within");
    expect(r.breaches).toEqual([]);
  });

  it("exceeds each metric at limit plus one", () => {
    const r = validateDiffBudget(
      budget({
        maxDeletedLines: 10,
        maxTotalChangedLines: 30,
        maxDeletedFiles: 2,
        maxChangedFiles: 4,
      }),
      {
        filesChanged: 5,
        insertions: 20,
        deletions: 11,
        deletedFiles: 3,
      },
    );

    expect(r.status).toBe("exceeded");
    expect(r.breaches).toEqual([
      { metric: "deleted_lines", actual: 11, limit: 10 },
      { metric: "total_changed_lines", actual: 31, limit: 30 },
      { metric: "deleted_files", actual: 3, limit: 2 },
      { metric: "changed_files", actual: 5, limit: 4 },
    ]);
  });

  it("aggregates simultaneous breaches", () => {
    const r = validateDiffBudget(
      budget({ maxDeletedLines: 1, maxChangedFiles: 1 }),
      { ...BASE_STAT, filesChanged: 2, deletions: 2 },
    );

    expect(r.status).toBe("exceeded");
    expect(r.breaches.map((b) => b.metric)).toEqual([
      "deleted_lines",
      "changed_files",
    ]);
  });

  it("falls back to default limits for unset metrics", () => {
    const r = validateDiffBudget(
      { enforce: true, maxDeletedLines: 1 },
      {
        filesChanged: DEFAULT_CHANGE_BUDGET.maxChangedFiles + 1,
        insertions: 0,
        deletions: 1,
        deletedFiles: 0,
      },
    );

    expect(r.status).toBe("exceeded");
    expect(r.breaches).toEqual([
      {
        metric: "changed_files",
        actual: DEFAULT_CHANGE_BUDGET.maxChangedFiles + 1,
        limit: DEFAULT_CHANGE_BUDGET.maxChangedFiles,
      },
    ]);
  });

  it("treats enforce:false as within", () => {
    const r = validateDiffBudget(
      { ...budget({ maxDeletedLines: 1 }), enforce: false },
      { ...BASE_STAT, deletions: 100 },
    );

    expect(r.status).toBe("within");
    expect(r.breaches).toEqual([]);
  });

  it("does not count binary-file numstat dashes as line changes but still applies file budgets", () => {
    const r = validateDiffBudget(
      budget({ maxDeletedLines: 1, maxTotalChangedLines: 1, maxChangedFiles: 1 }),
      {
        filesChanged: 2,
        insertions: 0,
        deletions: 0,
        deletedFiles: 0,
      },
    );

    expect(r.status).toBe("exceeded");
    expect(r.breaches).toEqual([
      { metric: "changed_files", actual: 2, limit: 1 },
    ]);
  });
});
