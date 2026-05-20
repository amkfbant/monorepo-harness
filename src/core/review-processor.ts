import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMeta, RunStatus } from "../logging/run-log.js";
import {
  loadReviewDecision,
  writeReviewDecision,
} from "./review-decision-loader.js";
import type { ReviewDecisionValue } from "./review-decision-schema.js";

export interface ProcessOpts {
  runsDir: string;
  runId: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface ProcessResult {
  runId: string;
  previousStatus: RunStatus;
  newStatus: RunStatus;
  reviewer: string | null;
  reviewedAt: string;
  warnings: string[];
}

const DECISION_TO_STATUS: Record<
  Exclude<ReviewDecisionValue, "pending">,
  RunStatus
> = {
  approved: "approved",
  changes_requested: "changes_requested",
  rejected: "rejected",
};

export async function processReviewDecision(
  opts: ProcessOpts,
): Promise<ProcessResult> {
  const runDir = join(opts.runsDir, opts.runId);
  const metaPath = join(runDir, "meta.json");
  const decisionPath = join(runDir, "review-decision.yaml");

  const meta = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
  const decision = await loadReviewDecision(decisionPath);

  // 整合性 check
  if (decision.runId !== opts.runId) {
    throw new Error(
      `review-decision.yaml runId (${decision.runId}) does not match directory (${opts.runId})`,
    );
  }
  if (decision.domain !== meta.domain) {
    throw new Error(
      `review-decision.yaml domain (${decision.domain}) does not match meta.json domain (${meta.domain})`,
    );
  }
  if (decision.decision === "pending") {
    throw new Error(
      `decision is still pending in ${decisionPath}; reviewer must set it to approved | changes_requested | rejected`,
    );
  }
  if (meta.status !== "needs_review") {
    throw new Error(
      `run ${opts.runId} status is "${meta.status}", only needs_review can be processed`,
    );
  }

  const warnings: string[] = [];
  if (decision.reviewer === null) {
    warnings.push("reviewer field is null");
  }

  const newStatus = DECISION_TO_STATUS[decision.decision];
  const now = opts.now ?? new Date();
  const reviewedAt = decision.reviewed_at ?? now.toISOString();

  // reviewed_at が null だった場合のみ file に書き戻す
  if (decision.reviewed_at === null) {
    await writeReviewDecision(decisionPath, {
      ...decision,
      reviewed_at: reviewedAt,
    });
  }

  // meta 更新
  const updatedMeta: RunMeta = {
    ...meta,
    status: newStatus,
    reviewer: decision.reviewer,
    reviewedAt,
  };
  await writeFile(metaPath, `${JSON.stringify(updatedMeta, null, 2)}\n`, "utf8");

  // event 追記
  const event = {
    type: "review_processed",
    runId: opts.runId,
    decision: decision.decision,
    previousStatus: meta.status,
    newStatus,
    reviewer: decision.reviewer,
    reviewedAt,
  };
  await appendFile(
    join(runDir, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8",
  );

  return {
    runId: opts.runId,
    previousStatus: meta.status,
    newStatus,
    reviewer: decision.reviewer,
    reviewedAt,
    warnings,
  };
}
