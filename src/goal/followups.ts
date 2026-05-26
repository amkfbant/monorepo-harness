import {
  addBacklogItem,
  type BacklogDbContext,
  type BacklogWriteResult,
} from "../core/backlog-db.js";
import type { BacklogItem, BacklogPriority } from "../core/backlog.js";
import { DbError } from "../db/connection.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import type { GoalRepository } from "./repository.js";
import type { GoalFinding, GoalFindingSeverity, GoalSession } from "./types.js";

export interface DeferFindingToBacklogInput {
  repository: GoalRepository;
  findingId: string;
  reason: string;
  backlogContext?: BacklogDbContext;
  createBacklogItem?: boolean;
  now?: Date;
}

export interface DeferFindingToBacklogResult {
  finding: GoalFinding;
  backlogItemId: string | null;
  backlogItem?: BacklogItem;
  exportWarning?: string;
  createdBacklogItem: boolean;
}

export async function deferFindingToBacklog(
  input: DeferFindingToBacklogInput,
): Promise<DeferFindingToBacklogResult> {
  const now = input.now ?? new Date();
  const initial = input.repository.requireFinding(input.findingId);
  assertFindingCanBeDeferred(initial);

  if (initial.deferredBacklogItemId !== null) {
    if (input.backlogContext === undefined) {
      throw new Error(
        "backlogContext is required to verify an existing deferred backlog link",
      );
    }
    assertBacklogItemExists(input.backlogContext, initial.deferredBacklogItemId);
    const finding =
      initial.lifecycleStatus === "deferred"
        ? initial
        : input.repository.deferFinding({
            findingId: input.findingId,
            backlogItemId: initial.deferredBacklogItemId,
            note: input.reason,
            deferredAt: now.toISOString(),
          });
    return {
      finding,
      backlogItemId: initial.deferredBacklogItemId,
      createdBacklogItem: false,
    };
  }

  const createBacklogItem = input.createBacklogItem ?? true;
  if (!createBacklogItem) {
    const finding = input.repository.deferFinding({
      findingId: input.findingId,
      note: input.reason,
      deferredAt: now.toISOString(),
    });
    return {
      finding,
      backlogItemId: finding.deferredBacklogItemId,
      createdBacklogItem: false,
    };
  }

  if (input.backlogContext === undefined) {
    throw new Error("backlogContext is required when createBacklogItem is true");
  }

  const session = input.repository.requireSession(initial.goalId);
  const write = await addBacklogItem(
    input.backlogContext,
    buildBacklogInput(session, initial, input.reason),
    now,
  );
  const finding = input.repository.deferFinding({
    findingId: input.findingId,
    backlogItemId: write.item.id,
    note: input.reason,
    deferredAt: now.toISOString(),
  });
  return result(finding, write);
}

export function buildBacklogInput(
  session: GoalSession,
  finding: GoalFinding,
  reason: string,
): {
  title: string;
  domain: string;
  goal: string;
  priority: BacklogPriority;
  tags: string[];
  projectId?: string;
} {
  const title = `Follow-up: ${finding.summary}`.slice(0, 180);
  return {
    title,
    domain: backlogDomain(session, finding),
    goal: backlogGoalBody(session, finding, reason),
    priority: priorityForSeverity(finding.severity),
    tags: backlogTags(session, finding),
    ...(session.projectId !== null ? { projectId: session.projectId } : {}),
  };
}

function result(
  finding: GoalFinding,
  write: BacklogWriteResult,
): DeferFindingToBacklogResult {
  return {
    finding,
    backlogItemId: write.item.id,
    backlogItem: write.item,
    createdBacklogItem: true,
    ...(write.exportWarning !== undefined
      ? { exportWarning: write.exportWarning }
      : {}),
  };
}

function backlogDomain(session: GoalSession, finding: GoalFinding): string {
  const category = finding.category.trim();
  return firstNonEmpty(session.domain, session.projectId, category, "goal");
}

function backlogGoalBody(
  session: GoalSession,
  finding: GoalFinding,
  reason: string,
): string {
  return [
    "source: goal-finding",
    `goalId: ${session.goalId}`,
    `findingId: ${finding.findingId}`,
    `severity: ${finding.severity}`,
    `scopeStatus: ${finding.scopeStatus}`,
    `category: ${finding.category}`,
    finding.filePath === null ? "" : `filePath: ${finding.filePath}`,
    `summary: ${finding.summary}`,
    `reason: ${reason}`,
    finding.detail === null || finding.detail.trim() === ""
      ? ""
      : `detail: ${finding.detail}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function backlogTags(session: GoalSession, finding: GoalFinding): string[] {
  return [
    "goal-finding",
    `goal:${session.goalId}`,
    `finding:${finding.findingId}`,
    `severity:${finding.severity}`,
    `scope:${finding.scopeStatus}`,
    `category:${finding.category}`,
  ];
}

function priorityForSeverity(severity: GoalFindingSeverity): BacklogPriority {
  if (severity === "P0" || severity === "P1") return "high";
  if (severity === "P2") return "medium";
  return "low";
}

function firstNonEmpty(...values: Array<string | null>): string {
  for (const value of values) {
    if (value !== null && value.trim() !== "") return value;
  }
  return "goal";
}

function assertBacklogItemExists(
  ctx: BacklogDbContext,
  itemId: string,
): void {
  const handle = openManagedDb({ dbPath: ctx.dbPath });
  try {
    runMigrations(handle.db);
    const row = handle.db
      .prepare("SELECT item_id FROM backlog_items WHERE item_id = ?")
      .get(itemId) as { item_id: string } | undefined;
    if (row === undefined) {
      throw new DbError(
        `deferred backlog item ${itemId} is missing from backlog_items`,
      );
    }
  } finally {
    handle.close();
  }
}

function assertFindingCanBeDeferred(finding: GoalFinding): void {
  if (finding.scopeStatus !== "out_of_scope") {
    throw new DbError(
      `goal finding ${finding.findingId} cannot be deferred while scope is ${finding.scopeStatus}; classify it out_of_scope first`,
    );
  }
}
