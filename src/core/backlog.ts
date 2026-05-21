import { readFile, writeFile, readdir, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export class BacklogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacklogError";
  }
}

export type BacklogStatus = "open" | "doing" | "done" | "deferred";
export type BacklogPriority = "high" | "medium" | "low";

export interface BacklogItem {
  id: string;
  title: string;
  domain: string;
  goal: string;
  status: BacklogStatus;
  priority: BacklogPriority;
  tags: string[];
  createdAt: string;
  /** runs launched from this item via `backlog run` */
  linkedRuns: string[];
  /** optional project id (Phase 5) — set by `backlog add --project` */
  projectId?: string;
}

const STATUSES: BacklogStatus[] = ["open", "doing", "done", "deferred"];
const PRIORITIES: BacklogPriority[] = ["high", "medium", "low"];
const ITEM_ID_RE = /^item-[0-9]{8}-[0-9]{3}$/;
const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

/** Ensure backlog/{open,doing,done,deferred} exist. */
async function ensureDirs(backlogDir: string): Promise<void> {
  for (const s of STATUSES) {
    await mkdir(join(backlogDir, s), { recursive: true });
  }
}

interface AddItemInput {
  title: string;
  domain: string;
  goal: string;
  priority?: BacklogPriority;
  tags?: string[];
  /** optional project id this item belongs to (Phase 5) */
  projectId?: string;
}

/** Create a new backlog item in backlog/open/. */
export async function addItem(
  backlogDir: string,
  input: AddItemInput,
  now: Date = new Date(),
): Promise<BacklogItem> {
  const title = input.title.trim();
  const domain = input.domain.trim();
  const goal = input.goal.trim();
  if (title === "") throw new BacklogError("backlog add: --title is required");
  if (domain === "") throw new BacklogError("backlog add: --domain is required");
  if (goal === "") throw new BacklogError("backlog add: --goal is required");
  const priority = input.priority ?? "medium";
  if (!PRIORITIES.includes(priority)) {
    throw new BacklogError(
      `backlog add: invalid priority ${JSON.stringify(priority)} (high|medium|low)`,
    );
  }
  await ensureDirs(backlogDir);
  // exclusive create ("wx"): a concurrent add that picked the same id
  // hits EEXIST instead of silently overwriting — recompute and retry.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = await nextItemId(backlogDir, now);
    const item: BacklogItem = {
      id,
      title,
      domain,
      goal,
      status: "open",
      priority,
      tags: input.tags ?? [],
      createdAt: now.toISOString(),
      linkedRuns: [],
      ...(input.projectId !== undefined && input.projectId !== ""
        ? { projectId: input.projectId }
        : {}),
    };
    try {
      await writeFile(itemPath(backlogDir, "open", id), serialise(item), {
        encoding: "utf8",
        flag: "wx",
      });
      return item;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
  }
  throw new BacklogError("backlog add: could not allocate an item id");
}

/** Allocate the next `item-YYYYMMDD-NNN` id for the given day. */
async function nextItemId(backlogDir: string, now: Date): Promise<string> {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  let max = 0;
  for (const s of STATUSES) {
    for (const f of await readdirSafe(join(backlogDir, s))) {
      const m = f.match(/^item-(\d{8})-(\d{3})\.yaml$/);
      if (m && m[1] === day) max = Math.max(max, Number(m[2]));
    }
  }
  return `item-${day}-${String(max + 1).padStart(3, "0")}`;
}

/** List items, optionally filtered to one status. */
export async function listItems(
  backlogDir: string,
  status?: BacklogStatus,
): Promise<BacklogItem[]> {
  const wanted = status ? [status] : STATUSES;
  const items: BacklogItem[] = [];
  for (const s of wanted) {
    for (const f of await readdirSafe(join(backlogDir, s))) {
      if (!f.endsWith(".yaml")) continue;
      const item = await readItemFile(join(backlogDir, s, f), s);
      if (item) items.push(item);
    }
  }
  // newest first by id (id encodes the date + sequence)
  items.sort((a, b) => b.id.localeCompare(a.id));
  return items;
}

/** Find a single item across all status dirs. */
export async function showItem(
  backlogDir: string,
  itemId: string,
): Promise<BacklogItem> {
  const found = await locate(backlogDir, itemId);
  if (!found) throw new BacklogError(`backlog item ${itemId} not found`);
  return found.item;
}

/**
 * Move an item to a new status (done / defer / reopen). The file is moved
 * between status dirs and its `status` field rewritten.
 */
export async function setItemStatus(
  backlogDir: string,
  itemId: string,
  status: BacklogStatus,
): Promise<BacklogItem> {
  const found = await locate(backlogDir, itemId);
  if (!found) throw new BacklogError(`backlog item ${itemId} not found`);
  if (found.status === status) return found.item;
  const updated = { ...found.item, status };
  await moveItemFile(backlogDir, itemId, found.status, status, updated);
  return updated;
}

/**
 * Record that a run was launched from an item: append the runId to the
 * item's linkedRuns and move it to `doing`.
 *
 * The link is stored ONLY on the backlog side — `harness run show`
 * derives the backlog item by scanning linkedRuns (see
 * `findBacklogItemForRun`). The run's meta.json is deliberately NOT
 * patched, so this never races a concurrent review/cleanup writer.
 */
export async function recordBacklogRun(
  backlogDir: string,
  itemId: string,
  runId: string,
): Promise<BacklogItem> {
  if (!RUN_ID_RE.test(runId)) {
    throw new BacklogError(`invalid runId: ${JSON.stringify(runId)}`);
  }
  const found = await locate(backlogDir, itemId);
  if (!found) throw new BacklogError(`backlog item ${itemId} not found`);
  const linkedRuns = found.item.linkedRuns.includes(runId)
    ? found.item.linkedRuns
    : [...found.item.linkedRuns, runId];
  const updated: BacklogItem = {
    ...found.item,
    linkedRuns,
    status: "doing",
  };
  await moveItemFile(backlogDir, itemId, found.status, "doing", updated);
  return updated;
}

/** The backlog item that launched a run, or null — used by `run show`. */
export async function findBacklogItemForRun(
  backlogDir: string,
  runId: string,
): Promise<string | null> {
  for (const item of await listItems(backlogDir)) {
    if (item.linkedRuns.includes(runId)) return item.id;
  }
  return null;
}

interface Located {
  item: BacklogItem;
  status: BacklogStatus;
}

async function locate(
  backlogDir: string,
  itemId: string,
): Promise<Located | null> {
  if (!ITEM_ID_RE.test(itemId)) {
    throw new BacklogError(`invalid backlog item id: ${JSON.stringify(itemId)}`);
  }
  // scan ALL status dirs — a half-completed move could (in theory) leave
  // the item in two places; surface that instead of silently picking one.
  const matches: Located[] = [];
  for (const s of STATUSES) {
    const p = itemPath(backlogDir, s, itemId);
    if (existsSync(p)) {
      const item = await readItemFile(p, s);
      if (item) matches.push({ item, status: s });
    }
  }
  if (matches.length > 1) {
    throw new BacklogError(
      `backlog item ${itemId} exists in multiple status dirs ` +
        `(${matches.map((m) => m.status).join(", ")}); manual repair needed`,
    );
  }
  return matches[0] ?? null;
}

function itemPath(
  backlogDir: string,
  status: BacklogStatus,
  itemId: string,
): string {
  return join(backlogDir, status, `${itemId}.yaml`);
}

/**
 * Move an item to a new status dir. The updated content is written to
 * the OLD path first, then `rename`d into the new dir — rename is atomic,
 * so the item is never present in two status dirs at once (a crash leaves
 * exactly one file, in either the old or new dir).
 */
async function moveItemFile(
  backlogDir: string,
  itemId: string,
  from: BacklogStatus,
  to: BacklogStatus,
  item: BacklogItem,
): Promise<void> {
  const fromPath = itemPath(backlogDir, from, itemId);
  if (from === to) {
    await writeFile(fromPath, serialise(item), "utf8");
    return;
  }
  await mkdir(join(backlogDir, to), { recursive: true });
  await writeFile(fromPath, serialise(item), "utf8");
  await rename(fromPath, itemPath(backlogDir, to, itemId));
}

async function readItemFile(
  path: string,
  dirStatus: BacklogStatus,
): Promise<BacklogItem | null> {
  let doc: Partial<BacklogItem> | null;
  try {
    doc = parseYaml(await readFile(path, "utf8")) as Partial<BacklogItem>;
  } catch {
    return null;
  }
  if (!doc || typeof doc.id !== "string") return null;
  return {
    id: doc.id,
    title: typeof doc.title === "string" ? doc.title : "(untitled)",
    domain: typeof doc.domain === "string" ? doc.domain : "?",
    goal: typeof doc.goal === "string" ? doc.goal : "",
    // the directory is authoritative for status
    status: dirStatus,
    priority: PRIORITIES.includes(doc.priority as BacklogPriority)
      ? (doc.priority as BacklogPriority)
      : "medium",
    tags: Array.isArray(doc.tags)
      ? doc.tags.filter((t): t is string => typeof t === "string")
      : [],
    createdAt: typeof doc.createdAt === "string" ? doc.createdAt : "",
    linkedRuns: Array.isArray(doc.linkedRuns)
      ? doc.linkedRuns.filter((r): r is string => typeof r === "string")
      : [],
    ...(typeof doc.projectId === "string" && doc.projectId !== ""
      ? { projectId: doc.projectId }
      : {}),
  };
}

function serialise(item: BacklogItem): string {
  return stringifyYaml(item);
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Render an item as a human-readable block. When `missingRuns` is given,
 * any linked run whose run dir no longer exists (e.g. `cleanup --scope
 * run`) is marked `(missing)`.
 */
export function formatItem(
  item: BacklogItem,
  opts: { missingRuns?: Set<string> } = {},
): string {
  const missing = opts.missingRuns ?? new Set<string>();
  return [
    `Item: ${item.id}`,
    `Title: ${item.title}`,
    `Domain: ${item.domain}`,
    ...(item.projectId !== undefined ? [`Project: ${item.projectId}`] : []),
    `Status: ${item.status}`,
    `Priority: ${item.priority}`,
    `Tags: ${item.tags.length > 0 ? item.tags.join(", ") : "(none)"}`,
    `Created: ${item.createdAt}`,
    "Goal:",
    `  ${item.goal}`,
    "Linked runs:",
    ...(item.linkedRuns.length > 0
      ? item.linkedRuns.map(
          (r) => `  ${r}${missing.has(r) ? " (missing)" : ""}`,
        )
      : ["  (none)"]),
    "",
  ].join("\n");
}

/** Render a list of items as one line each. */
export function formatItemList(items: BacklogItem[]): string {
  if (items.length === 0) return "No backlog items.\n";
  return (
    items
      .map(
        (i) =>
          `${i.id}  [${i.status}] ${i.priority.padEnd(6)} ${i.domain}  ${i.title}`,
      )
      .join("\n") + "\n"
  );
}
