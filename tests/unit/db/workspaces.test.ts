import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaces.js";

describe("WorkspaceRepository", () => {
  let handle: ReturnType<typeof openManagedDb>;
  let repo: WorkspaceRepository;
  const REPO = "/projects/app";

  beforeEach(() => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ws-repo-")), "h.sqlite");
    handle = openManagedDb({ dbPath });
    runMigrations(handle.db);
    repo = new WorkspaceRepository(handle.db);
  });
  afterEach(() => handle.close());

  it("upserts a new workspace row", () => {
    const ws = repo.upsert({
      agent: "alice",
      repoPath: REPO,
      branch: "agent/alice",
      worktreePath: "/projects/app.agents/alice",
      now: "2026-06-07T00:00:00.000Z",
    });
    expect(ws.agent).toBe("alice");
    expect(ws.status).toBe("active");
    expect(ws.goalId).toBeNull();
    expect(ws.workspaceId).toMatch(/^ws-/);
    expect(repo.get(REPO, "alice")?.branch).toBe("agent/alice");
  });

  it("is idempotent: a second upsert keeps the id and created_at, refreshes heartbeat", () => {
    const first = repo.upsert({
      agent: "alice",
      repoPath: REPO,
      branch: "agent/alice",
      worktreePath: "/p/alice",
      now: "2026-06-07T00:00:00.000Z",
    });
    const second = repo.upsert({
      agent: "alice",
      repoPath: REPO,
      branch: "agent/alice",
      worktreePath: "/p/alice-moved",
      now: "2026-06-07T01:00:00.000Z",
    });
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.worktreePath).toBe("/p/alice-moved");
    expect(second.lastActiveAt).toBe("2026-06-07T01:00:00.000Z");
  });

  it("scopes rows by repo path (same agent name in two repos is two rows)", () => {
    repo.upsert({ agent: "alice", repoPath: "/a", branch: "agent/alice", worktreePath: "/a/x" });
    repo.upsert({ agent: "alice", repoPath: "/b", branch: "agent/alice", worktreePath: "/b/x" });
    expect(repo.listByRepo("/a")).toHaveLength(1);
    expect(repo.listByRepo("/b")).toHaveLength(1);
  });

  it("links an advisory goal and sets an objective", () => {
    repo.upsert({ agent: "alice", repoPath: REPO, branch: "agent/alice", worktreePath: "/p/alice" });
    repo.linkGoal(REPO, "alice", "goal-123");
    repo.setObjective(REPO, "alice", "ship the workspace feature");
    const ws = repo.get(REPO, "alice");
    expect(ws?.goalId).toBe("goal-123");
    expect(ws?.objective).toBe("ship the workspace feature");
    repo.linkGoal(REPO, "alice", null);
    expect(repo.get(REPO, "alice")?.goalId).toBeNull();
  });

  it("removes a workspace row", () => {
    repo.upsert({ agent: "alice", repoPath: REPO, branch: "agent/alice", worktreePath: "/p/alice" });
    expect(repo.remove(REPO, "alice")).toBe(true);
    expect(repo.get(REPO, "alice")).toBeNull();
    expect(repo.remove(REPO, "alice")).toBe(false);
  });

  it("records and lists checkpoints newest-first, and exposes the latest", () => {
    const ws = repo.upsert({
      agent: "alice",
      repoPath: REPO,
      branch: "agent/alice",
      worktreePath: "/p/alice",
    });
    const c1 = repo.recordCheckpoint({
      workspaceId: ws.workspaceId,
      note: "first",
      headSha: "a".repeat(40),
      dirtyCount: 2,
      createdBy: "cli",
      now: "2026-06-07T00:00:00.000Z",
    });
    const c2 = repo.recordCheckpoint({
      workspaceId: ws.workspaceId,
      note: "second",
      goalId: "goal-1",
      dirtyCount: 0,
      createdBy: "alice",
      now: "2026-06-07T01:00:00.000Z",
    });
    expect(c1.checkpointId).toMatch(/^wcp-/);
    expect(c1.dirtyCount).toBe(2);
    const list = repo.listCheckpoints(ws.workspaceId);
    expect(list.map((c) => c.note)).toEqual(["second", "first"]);
    expect(repo.latestCheckpoint(ws.workspaceId)?.note).toBe("second");
    expect(repo.latestCheckpoint(ws.workspaceId)?.goalId).toBe("goal-1");
    expect(c2.createdBy).toBe("alice");
  });

  it("breaks same-timestamp checkpoints by insertion order (latest is the newest insert)", () => {
    const ws = repo.upsert({
      agent: "alice",
      repoPath: REPO,
      branch: "agent/alice",
      worktreePath: "/p/alice",
    });
    const SAME = "2026-06-07T00:00:00.000Z";
    repo.recordCheckpoint({ workspaceId: ws.workspaceId, note: "older", createdBy: "cli", now: SAME });
    repo.recordCheckpoint({ workspaceId: ws.workspaceId, note: "newer", createdBy: "cli", now: SAME });
    expect(repo.latestCheckpoint(ws.workspaceId)?.note).toBe("newer");
    expect(repo.listCheckpoints(ws.workspaceId).map((c) => c.note)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("latestCheckpoint is null when there are none", () => {
    const ws = repo.upsert({
      agent: "alice",
      repoPath: REPO,
      branch: "agent/alice",
      worktreePath: "/p/alice",
    });
    expect(repo.latestCheckpoint(ws.workspaceId)).toBeNull();
  });
});
