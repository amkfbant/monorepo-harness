import { buildInbox } from "./inbox.js";
import { listItems, type BacklogPriority } from "./backlog.js";

/** A single suggested step in a work session. Suggestion only — never run. */
export interface SessionItem {
  /** 1-based position in the recommended order */
  order: number;
  category:
    | "failed"
    | "needs_review"
    | "changes_requested"
    | "cleanup"
    | "backlog";
  /** runId or backlog item id */
  target: string;
  detail: string;
  /** the command the operator would run for this item */
  action: string;
}

export interface SessionPlan {
  items: SessionItem[];
  /** per-category counts of the full plan */
  counts: Record<SessionItem["category"], number>;
}

export interface SessionOpts {
  runsDir: string;
  workspacesDir: string;
  indexDbPath: string;
  backlogDir: string;
  knowledgeDir: string;
}

const PRIORITY_RANK: Record<BacklogPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Build a rule-ordered session plan from the current state. The order is
 * fixed (4-7.3): failures first, then the review queue, then reruns, then
 * cleanup, then high-priority backlog. This is advice — nothing is run.
 */
export async function buildSessionPlan(
  opts: SessionOpts,
): Promise<SessionPlan> {
  const inbox = await buildInbox({
    runsDir: opts.runsDir,
    workspacesDir: opts.workspacesDir,
    indexDbPath: opts.indexDbPath,
    knowledgeDir: opts.knowledgeDir,
  });
  const backlogOpen = (await listItems(opts.backlogDir, "open")).sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  );

  const items: SessionItem[] = [];
  const push = (
    category: SessionItem["category"],
    target: string,
    detail: string,
    action: string,
  ): void => {
    items.push({ order: items.length + 1, category, target, detail, action });
  };

  // 1. failures first — understand what broke
  for (const f of inbox.failed) {
    push("failed", f.runId, f.status, `harness run show --run-id ${f.runId}`);
  }
  // 2. the review queue
  for (const r of inbox.needsReview) {
    push(
      "needs_review",
      r.runId,
      r.detail,
      `harness review auto --run-id ${r.runId}`,
    );
  }
  // 3. changes_requested → rerun
  for (const r of inbox.changesRequested) {
    push(
      "changes_requested",
      r.runId,
      r.detail,
      `harness rerun --from-review ${r.runId}`,
    );
  }
  // 4. cleanup candidates
  for (const c of inbox.cleanupCandidates) {
    push(
      "cleanup",
      c.runId,
      c.detail,
      `harness cleanup --run-id ${c.runId}`,
    );
  }
  // 5. high-priority backlog (open items)
  for (const it of backlogOpen) {
    push(
      "backlog",
      it.id,
      `[${it.priority}] ${it.title}`,
      `harness backlog run --item-id ${it.id} --repo <path> --repo-id <id>`,
    );
  }

  const counts: SessionPlan["counts"] = {
    failed: inbox.failed.length,
    needs_review: inbox.needsReview.length,
    changes_requested: inbox.changesRequested.length,
    cleanup: inbox.cleanupCandidates.length,
    backlog: backlogOpen.length,
  };
  return { items, counts };
}

/** Render the plan, optionally capped to the first `limit` items. */
export function formatSessionPlan(plan: SessionPlan, limit?: number): string {
  const shown =
    limit !== undefined ? plan.items.slice(0, limit) : plan.items;
  const lines: string[] = ["Session plan (suggestion only — nothing is run):", ""];
  if (shown.length === 0) {
    // knowledge candidates are NOT part of the session plan — do not
    // claim the whole inbox is clear here.
    lines.push(
      "  No session-plan items (failed / needs_review / changes_requested / cleanup / backlog all clear).",
      "",
    );
    return lines.join("\n");
  }
  for (const it of shown) {
    lines.push(`  ${it.order}. [${it.category}] ${it.target}  — ${it.detail}`);
    lines.push(`     → ${it.action}`);
  }
  if (limit !== undefined && plan.items.length > limit) {
    lines.push("", `  … ${plan.items.length - limit} more (see 'session plan')`);
  }
  lines.push("");
  return lines.join("\n");
}

/** A compact one-block snapshot of what is pending right now. */
export function formatSessionSummary(plan: SessionPlan): string {
  const c = plan.counts;
  return [
    "Session summary:",
    `  failed:            ${c.failed}`,
    `  needs_review:      ${c.needs_review}`,
    `  changes_requested: ${c.changes_requested}`,
    `  cleanup pending:   ${c.cleanup}`,
    `  backlog (open):    ${c.backlog}`,
    "",
    `  ${plan.items.length} item(s) in the session plan.`,
    "",
  ].join("\n");
}
