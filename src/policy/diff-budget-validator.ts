import type { DiffStat } from "../git/diff.js";
import {
  DEFAULT_CHANGE_BUDGET,
  type ChangeBudget,
} from "./schema.js";

export type DiffBudgetMetric =
  | "deleted_lines"
  | "total_changed_lines"
  | "deleted_files"
  | "changed_files";

export interface DiffBudgetBreach {
  metric: DiffBudgetMetric;
  actual: number;
  limit: number;
}

export interface DiffBudgetInput {
  maxDeletedLines?: number;
  maxTotalChangedLines?: number;
  maxDeletedFiles?: number;
  maxChangedFiles?: number;
  enforce?: boolean;
}

export interface DiffBudgetValidationResult {
  status: "within" | "exceeded" | "exceeded-but-allowed";
  breaches: DiffBudgetBreach[];
}

export function normalizeDiffBudget(input: DiffBudgetInput): ChangeBudget {
  return {
    maxDeletedLines:
      input.maxDeletedLines ?? DEFAULT_CHANGE_BUDGET.maxDeletedLines,
    maxTotalChangedLines:
      input.maxTotalChangedLines ??
      DEFAULT_CHANGE_BUDGET.maxTotalChangedLines,
    maxDeletedFiles:
      input.maxDeletedFiles ?? DEFAULT_CHANGE_BUDGET.maxDeletedFiles,
    maxChangedFiles:
      input.maxChangedFiles ?? DEFAULT_CHANGE_BUDGET.maxChangedFiles,
    enforce: input.enforce ?? DEFAULT_CHANGE_BUDGET.enforce,
  };
}

export function validateDiffBudget(
  budgetInput: DiffBudgetInput,
  stat: DiffStat,
): DiffBudgetValidationResult {
  const budget = normalizeDiffBudget(budgetInput);

  const totalChangedLines = stat.insertions + stat.deletions;
  const breaches: DiffBudgetBreach[] = [];
  if (stat.deletions > budget.maxDeletedLines) {
    breaches.push({
      metric: "deleted_lines",
      actual: stat.deletions,
      limit: budget.maxDeletedLines,
    });
  }
  if (totalChangedLines > budget.maxTotalChangedLines) {
    breaches.push({
      metric: "total_changed_lines",
      actual: totalChangedLines,
      limit: budget.maxTotalChangedLines,
    });
  }
  if (stat.deletedFiles > budget.maxDeletedFiles) {
    breaches.push({
      metric: "deleted_files",
      actual: stat.deletedFiles,
      limit: budget.maxDeletedFiles,
    });
  }
  if (stat.filesChanged > budget.maxChangedFiles) {
    breaches.push({
      metric: "changed_files",
      actual: stat.filesChanged,
      limit: budget.maxChangedFiles,
    });
  }

  return {
    status:
      breaches.length === 0
        ? "within"
        : budget.enforce
          ? "exceeded"
          : "exceeded-but-allowed",
    breaches,
  };
}
