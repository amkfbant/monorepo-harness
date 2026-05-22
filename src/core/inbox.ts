import { existsSync } from "node:fs";
import { join } from "node:path";
import { scanAllRuns, type ReviewListEntry } from "./review-lister.js";
import {
  scanPromotedKeys,
  countUnactionedCandidates,
} from "./knowledge-digest.js";

/** One actionable line in the inbox. */
export interface InboxItem {
  runId: string;
  domain: string;
  status: string;
  /** short context shown after the runId */
  detail: string;
}

export interface Inbox {
  needsReview: InboxItem[];
  changesRequested: InboxItem[];
  failed: InboxItem[];
  cleanupCandidates: InboxItem[];
  knowledge: InboxItem[];
}

export type InboxSection =
  | "needsReview"
  | "changesRequested"
  | "failed"
  | "cleanupCandidates"
  | "knowledge";

export interface BuildInboxOpts {
  runsDir: string;
  workspacesDir: string;
  /** docs/knowledge — needed to tell actioned candidates from open ones */
  knowledgeDir: string;
  /** when set, only runs started on this calendar day are included */
  today?: Date;
}

/**
 * Aggregate everything an operator should look at today: the review
 * queue, failures, runs whose worktree still needs cleanup, and runs
 * that produced knowledge candidates.
 */
export async function buildInbox(opts: BuildInboxOpts): Promise<Inbox> {
  const result = await scanAllRuns(opts.runsDir);
  let runs = result.valid;
  if (opts.today) {
    const day = opts.today.toISOString().slice(0, 10);
    runs = runs.filter((r) => {
      // normalise to a UTC calendar day — startedAt may carry an offset
      // (e.g. +09:00) that shifts the date across the UTC boundary.
      if (!r.startedAt) return false;
      const d = new Date(r.startedAt);
      if (Number.isNaN(d.getTime())) return false;
      return d.toISOString().slice(0, 10) === day;
    });
  }

  const inbox: Inbox = {
    needsReview: [],
    changesRequested: [],
    failed: [],
    cleanupCandidates: [],
    knowledge: [],
  };
  // promoted keys are scanned once so per-run knowledge counting only
  // surfaces candidates that still need a decision.
  const promotedKeys = await scanPromotedKeys(opts.knowledgeDir);

  for (const r of runs) {
    if (r.status === "needs_review") {
      inbox.needsReview.push(item(r, commandDetail(r)));
    } else if (r.status === "changes_requested") {
      inbox.changesRequested.push(
        item(r, `reviewer=${r.reviewer ?? "(none)"}`),
      );
    } else if (r.status.startsWith("failed-")) {
      inbox.failed.push(item(r, r.status));
    }

    // cleanup candidate: a finished run whose worktree still exists.
    if (
      (r.status === "approved" || r.status === "rejected") &&
      existsSync(join(opts.workspacesDir, r.runId, "repo"))
    ) {
      inbox.cleanupCandidates.push(item(r, "worktree_exists=true"));
    }

    // knowledge candidates still needing a decision (promoted / rejected
    // ones are excluded — parity with `harness knowledge digest`).
    const n = await countUnactionedCandidates(
      join(opts.runsDir, r.runId),
      r.runId,
      promotedKeys,
    );
    if (n > 0) {
      inbox.knowledge.push(
        item(r, `${n} unactioned candidate${n === 1 ? "" : "s"}`),
      );
    }
  }
  return inbox;
}

function item(r: ReviewListEntry, detail: string): InboxItem {
  return { runId: r.runId, domain: r.domain, status: r.status, detail };
}

function commandDetail(r: ReviewListEntry): string {
  const changed = `changed=${r.changedFilesCount ?? 0}`;
  if (!r.commandSummary) return changed;
  return `${changed} commands=${r.commandSummary.ok}/${r.commandSummary.total}`;
}


const SECTION_TITLES: Record<InboxSection, string> = {
  needsReview: "Needs review",
  changesRequested: "Changes requested",
  failed: "Failed",
  cleanupCandidates: "Cleanup candidates",
  knowledge: "Knowledge",
};

/** The next-step command hints shown under each non-empty section. */
const SECTION_HINTS: Record<InboxSection, string[]> = {
  needsReview: [
    "harness review auto --run-id <id>",
    "harness review process --run-id <id>",
  ],
  changesRequested: ["harness rerun --from-review <id>"],
  failed: [
    "harness run show --run-id <id>",
    "harness knowledge list --run-id <id>",
  ],
  // this section mixes approved + rejected runs — `pr create` only
  // applies to approved ones, so it is explicitly qualified.
  cleanupCandidates: [
    "harness cleanup --run-id <id>",
    "harness pr create --run-id <id>  (approved の run のみ)",
  ],
  knowledge: ["harness knowledge list --run-id <id>"],
};

const ALL_SECTIONS: InboxSection[] = [
  "needsReview",
  "changesRequested",
  "failed",
  "cleanupCandidates",
  "knowledge",
];

/** Render the inbox as text, optionally restricted to certain sections. */
export function formatInbox(
  inbox: Inbox,
  sections: InboxSection[] = ALL_SECTIONS,
): string {
  const lines: string[] = [];
  let anything = false;
  for (const s of sections) {
    const items = inbox[s];
    if (items.length === 0) continue;
    anything = true;
    lines.push(`${SECTION_TITLES[s]}:`);
    for (const it of items) {
      lines.push(`  ${it.runId} ${it.domain}  ${it.detail}`);
    }
    for (const h of SECTION_HINTS[s]) lines.push(`  → ${h}`);
    lines.push("");
  }
  if (!anything) lines.push("Inbox is empty — nothing to do.", "");
  return lines.join("\n");
}

/**
 * Render the inbox as JSON. When `sections` is given, only those section
 * arrays are populated (others are emitted empty) so a `--failed --json`
 * style invocation is consistent with the text output.
 */
export function formatInboxJson(
  inbox: Inbox,
  sections: InboxSection[] = ALL_SECTIONS,
): string {
  const selected = new Set(sections);
  const out: Inbox = {
    needsReview: selected.has("needsReview") ? inbox.needsReview : [],
    changesRequested: selected.has("changesRequested")
      ? inbox.changesRequested
      : [],
    failed: selected.has("failed") ? inbox.failed : [],
    cleanupCandidates: selected.has("cleanupCandidates")
      ? inbox.cleanupCandidates
      : [],
    knowledge: selected.has("knowledge") ? inbox.knowledge : [],
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
