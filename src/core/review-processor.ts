import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMeta, RunStatus } from "../logging/run-log.js";
import {
  loadReviewDecision,
  writeReviewDecision,
} from "./review-decision-loader.js";
import type { ReviewDecisionValue } from "./review-decision-schema.js";

/**
 * Thrown when review processing is rejected for a reason the user can fix
 * (pending decision, mismatched runId/domain, status that isn't
 * needs_review, malformed review-decision.yaml, missing run dir).
 *
 * The CLI maps this to exit code 1; unexpected exceptions (e.g. unrelated
 * fs errors, programming bugs) propagate to exit code 2.
 */
export class ReviewGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewGateError";
  }
}

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

// Hand-written sentinel for user-facing FS errors. ENOENT on meta.json or
// review-decision.yaml almost always means "user typed wrong --run-id" or
// "forgot to edit the file"; treat as gate error.
function isUserFacingFsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EISDIR";
}

export async function processReviewDecision(
  opts: ProcessOpts,
): Promise<ProcessResult> {
  const runDir = join(opts.runsDir, opts.runId);
  const metaPath = join(runDir, "meta.json");
  const decisionPath = join(runDir, "review-decision.yaml");

  // Read + parse meta.json. Missing file or invalid JSON are user-fixable.
  let meta: RunMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
  } catch (e) {
    if (isUserFacingFsError(e) || e instanceof SyntaxError) {
      throw new ReviewGateError(
        `failed to read meta.json for ${opts.runId}: ${(e as Error).message}`,
      );
    }
    throw e;
  }

  // Load + validate review-decision.yaml. Any failure here (FS error,
  // YAML parse error, Zod validation error) is by definition user-fixable
  // since the reviewer just edited this file.
  let decision: Awaited<ReturnType<typeof loadReviewDecision>>;
  try {
    decision = await loadReviewDecision(decisionPath);
  } catch (e) {
    throw new ReviewGateError(
      `failed to read review-decision.yaml for ${opts.runId}: ${(e as Error).message}`,
    );
  }

  // 整合性 check — all gate errors.
  if (decision.runId !== opts.runId) {
    throw new ReviewGateError(
      `review-decision.yaml runId (${decision.runId}) does not match directory (${opts.runId})`,
    );
  }
  if (decision.domain !== meta.domain) {
    throw new ReviewGateError(
      `review-decision.yaml domain (${decision.domain}) does not match meta.json domain (${meta.domain})`,
    );
  }
  if (decision.decision === "pending") {
    throw new ReviewGateError(
      `decision is still pending in ${decisionPath}; reviewer must set it to approved | changes_requested | rejected`,
    );
  }
  if (meta.status !== "needs_review") {
    throw new ReviewGateError(
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
