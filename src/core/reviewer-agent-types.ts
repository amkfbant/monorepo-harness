// reviewer agent の公開 API 型（leaf）。runReviewerAgent の入出力契約と
// reviewer lens プロンプトの shape。値を持たない純粋な型 leaf ゆえ循環の起点に
// ならない（reviewer-agent.ts ← prompt/decision ← types の単方向 DAG）。
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import type { ReviewDecisionFile } from "./review-decision-schema.js";

export interface ReviewerAgentInputs {
  runsDir: string;
  runId: string;
  /**
   * harness DB path. When set, a db-first run with no exported files is
   * materialized from the DB before the reviewer runs (Phase 8-13) so
   * `review auto` works in DB-only mode.
   */
  dbPath?: string;
  /**
   * Reviewer identity stamped into review-decision.yaml. Defaults to
   * "codex-reviewer". Operators can pass e.g. "codex-reviewer-gpt-5.5"
   * to distinguish models.
   */
  reviewerName?: string;
  /**
   * Optional reviewer lens metadata from the reviewer registry. The lens prompt
   * is operator-provided and therefore treated as untrusted advisory context.
   */
  reviewerLens?: ReviewerLensPrompt;
  /**
   * When review-decision.yaml already has a non-pending decision, the run
   * is refused unless this is set. Protects a human/earlier verdict from
   * being clobbered by a re-run of `review auto`.
   */
  allowOverwrite?: boolean;
  /**
   * Run codex and validate the output, but do NOT write
   * review-decision.yaml (or review-auto-error.json). For inspection.
   */
  dryRun?: boolean;
  codexRunner: CodexExecRunner;
  /** Abort the in-flight reviewer codex run on course-lease loss (#132). */
  signal?: AbortSignal;
  now?: Date;
}

export interface ReviewerAgentResult {
  runId: string;
  decision: ReviewDecisionFile["decision"];
  reviewer: string;
  reviewedAt: string;
  rawOutputPath: string;
  /** true when dryRun was set — review-decision.yaml was NOT written */
  dryRun: boolean;
}

export interface ReviewerLensPrompt {
  lens: string;
  lensPrompt?: string;
}
