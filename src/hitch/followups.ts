import {
  addBacklogItem,
  exportBacklogItemForContext,
  prepareAddBacklogItemInput,
  type BacklogDbContext,
  type BacklogWriteResult,
} from "../core/backlog-db.js";
import {
  dayKey,
  maxDaySequenceFromFiles,
  type BacklogItem,
  type BacklogPriority,
} from "../core/backlog.js";
import { DbError } from "../db/connection.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import type { HitchRepository } from "./repository.js";
import type { HitchFinding, HitchFindingSeverity, HitchSession } from "./types.js";

export interface DeferFindingToBacklogInput {
  repository: HitchRepository;
  findingId: string;
  reason: string;
  backlogContext?: BacklogDbContext;
  createBacklogItem?: boolean;
  classifyOutOfScope?: boolean;
  now?: Date;
}

export interface DeferFindingToBacklogResult {
  finding: HitchFinding;
  backlogItemId: string | null;
  backlogItem?: BacklogItem;
  exportWarning?: string;
  createdBacklogItem: boolean;
}

export async function deferFindingToBacklog(
  input: DeferFindingToBacklogInput,
): Promise<DeferFindingToBacklogResult> {
  const now = input.now ?? new Date();
  if (input.classifyOutOfScope === true) {
    return classifyAndDeferFindingToBacklog(input, now);
  }

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

  const session = input.repository.requireSession(initial.hitchId);
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

async function classifyAndDeferFindingToBacklog(
  input: DeferFindingToBacklogInput,
  now: Date,
): Promise<DeferFindingToBacklogResult> {
  const initial = input.repository.requireFinding(input.findingId);

  if (initial.deferredBacklogItemId !== null) {
    if (input.backlogContext === undefined) {
      throw new Error(
        "backlogContext is required to verify an existing deferred backlog link",
      );
    }
    assertBacklogItemExists(input.backlogContext, initial.deferredBacklogItemId);
    const deferred = input.repository.classifyAndDeferFinding({
      findingId: input.findingId,
      reason: input.reason,
      now,
    });
    return {
      finding: deferred.finding,
      backlogItemId: deferred.backlogItemId,
      createdBacklogItem: false,
    };
  }

  const createBacklogItem = input.createBacklogItem ?? true;
  if (!createBacklogItem) {
    const deferred = input.repository.classifyAndDeferFinding({
      findingId: input.findingId,
      reason: input.reason,
      now,
    });
    return {
      finding: deferred.finding,
      backlogItemId: deferred.backlogItemId,
      createdBacklogItem: false,
    };
  }

  if (input.backlogContext === undefined) {
    throw new Error("backlogContext is required when createBacklogItem is true");
  }

  const session = input.repository.requireSession(initial.hitchId);
  const backlogInput = prepareAddBacklogItemInput(
    buildBacklogInput(
      session,
      {
        ...initial,
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
        classificationReason: input.reason,
      },
      input.reason,
    ),
  );
  const fsFloor = await maxDaySequenceFromFiles(
    input.backlogContext.backlogDir,
    dayKey(now),
  );
  const deferred = input.repository.classifyAndDeferFinding({
    findingId: input.findingId,
    reason: input.reason,
    now,
    backlogItem: {
      input: backlogInput,
      fsFloor,
    },
  });
  const exportWarning =
    deferred.backlogItem === undefined
      ? undefined
      : exportBacklogItemForContext(
          input.backlogContext,
          deferred.backlogItem.id,
        );
  return {
    finding: deferred.finding,
    backlogItemId: deferred.backlogItemId,
    ...(deferred.backlogItem !== undefined
      ? { backlogItem: deferred.backlogItem }
      : {}),
    createdBacklogItem: deferred.createdBacklogItem,
    ...(exportWarning !== undefined ? { exportWarning } : {}),
  };
}

export function buildBacklogInput(
  session: HitchSession,
  finding: HitchFinding,
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
  finding: HitchFinding,
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

function backlogDomain(session: HitchSession, finding: HitchFinding): string {
  const category = finding.category.trim();
  return firstNonEmpty(session.domain, session.projectId, category, "hitch");
}

function backlogGoalBody(
  session: HitchSession,
  finding: HitchFinding,
  reason: string,
): string {
  return [
    "source: hitch-finding",
    `hitchId: ${session.hitchId}`,
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

function backlogTags(session: HitchSession, finding: HitchFinding): string[] {
  return [
    "hitch-finding",
    `hitch:${session.hitchId}`,
    `finding:${finding.findingId}`,
    `severity:${finding.severity}`,
    `scope:${finding.scopeStatus}`,
    `category:${finding.category}`,
  ];
}

function priorityForSeverity(severity: HitchFindingSeverity): BacklogPriority {
  if (severity === "P0" || severity === "P1") return "high";
  if (severity === "P2") return "medium";
  return "low";
}

function firstNonEmpty(...values: Array<string | null>): string {
  for (const value of values) {
    if (value !== null && value.trim() !== "") return value;
  }
  return "hitch";
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

function assertFindingCanBeDeferred(finding: HitchFinding): void {
  if (finding.scopeStatus !== "out_of_scope") {
    throw new DbError(
      `hitch finding ${finding.findingId} cannot be deferred while scope is ${finding.scopeStatus}; classify it out_of_scope first`,
    );
  }
}
