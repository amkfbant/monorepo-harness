import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInbox,
  formatInbox,
  formatInboxJson,
} from "../../src/core/inbox.js";

let seq = 0;

interface RunOpts {
  status: string;
  domain?: string;
  startedAt?: string;
  reviewer?: string;
  knowledgeCandidates?: number;
  worktree?: boolean;
}

function harnessRoot(): { root: string; runsDir: string; workspacesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-inbox-"));
  const runsDir = join(root, "runs");
  const workspacesDir = join(root, "workspaces");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(workspacesDir, { recursive: true });
  return { root, runsDir, workspacesDir };
}

function writeRun(
  runsDir: string,
  workspacesDir: string,
  o: RunOpts,
): string {
  const runId = `run-20260521-apps-user-ib${String(seq++).padStart(2, "0")}`;
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      runId,
      repoId: "t",
      domain: o.domain ?? "apps/user",
      workflow: "domain-coding",
      baseBranch: "main",
      status: o.status,
      safetyStatus: "allowed",
      startedAt: o.startedAt ?? "2026-05-21T00:00:00Z",
      ...(o.reviewer ? { reviewer: o.reviewer } : {}),
    }),
  );
  const candidates = Array.from({ length: o.knowledgeCandidates ?? 0 }, () => ({
    kind: "policy_violation",
    domain: o.domain ?? "apps/user",
    title: "t",
  }));
  writeFileSync(
    join(runDir, "knowledge-candidates.yaml"),
    `candidates:\n${
      candidates.length === 0
        ? "  []"
        : candidates.map((c) => `  - kind: ${c.kind}`).join("\n")
    }\n`,
  );
  if (o.worktree) {
    mkdirSync(join(workspacesDir, runId, "repo"), { recursive: true });
  }
  return runId;
}

describe("buildInbox", () => {
  it("E4-2-1..5: categorises runs into inbox sections", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    writeRun(runsDir, workspacesDir, { status: "needs_review" });
    writeRun(runsDir, workspacesDir, {
      status: "changes_requested",
      reviewer: "knkn",
    });
    writeRun(runsDir, workspacesDir, { status: "failed-policy-violation" });
    writeRun(runsDir, workspacesDir, { status: "approved", worktree: true });
    writeRun(runsDir, workspacesDir, {
      status: "needs_review",
      knowledgeCandidates: 2,
    });

    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
    });
    expect(inbox.needsReview).toHaveLength(2);
    expect(inbox.changesRequested).toHaveLength(1);
    expect(inbox.changesRequested[0]?.detail).toMatch(/reviewer=knkn/);
    expect(inbox.failed).toHaveLength(1);
    expect(inbox.cleanupCandidates).toHaveLength(1);
    expect(inbox.knowledge).toHaveLength(1);
    expect(inbox.knowledge[0]?.detail).toMatch(/2 candidates/);
    expect(inbox.source).toBe("file-scan");
  });

  it("E4-2-4: approved run without a worktree is NOT a cleanup candidate", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    writeRun(runsDir, workspacesDir, { status: "approved", worktree: false });
    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
    });
    expect(inbox.cleanupCandidates).toHaveLength(0);
  });

  it("--today filters to runs started today", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    writeRun(runsDir, workspacesDir, {
      status: "needs_review",
      startedAt: "2020-01-01T00:00:00Z",
    });
    const today = new Date();
    writeRun(runsDir, workspacesDir, {
      status: "needs_review",
      startedAt: today.toISOString(),
    });
    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
      today,
    });
    expect(inbox.needsReview).toHaveLength(1);
  });

  it("--today normalises offset timestamps to a UTC day", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    // 2020-01-01T08:00:00+09:00 is 2019-12-31 in UTC — must NOT match a
    // UTC "today" of 2020-01-01.
    writeRun(runsDir, workspacesDir, {
      status: "needs_review",
      startedAt: "2020-01-01T08:00:00+09:00",
    });
    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
      today: new Date("2020-01-01T12:00:00Z"),
    });
    expect(inbox.needsReview).toHaveLength(0);
  });

  it("formatInboxJson restricts sections when given", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    writeRun(runsDir, workspacesDir, { status: "needs_review" });
    writeRun(runsDir, workspacesDir, { status: "failed-codex" });
    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
    });
    const parsed = JSON.parse(formatInboxJson(inbox, ["failed"]));
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.needsReview).toHaveLength(0);
  });

  it("E4-2-6: --json output is parseable", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    writeRun(runsDir, workspacesDir, { status: "needs_review" });
    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
    });
    const parsed = JSON.parse(formatInboxJson(inbox));
    expect(parsed.needsReview).toHaveLength(1);
  });

  it("formatInbox shows action hints for non-empty sections", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    writeRun(runsDir, workspacesDir, { status: "needs_review" });
    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
    });
    const text = formatInbox(inbox);
    expect(text).toMatch(/Needs review:/);
    expect(text).toMatch(/→ harness review auto/);
  });

  it("formatInbox can be restricted to a section", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    writeRun(runsDir, workspacesDir, { status: "needs_review" });
    writeRun(runsDir, workspacesDir, { status: "failed-codex" });
    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
    });
    const text = formatInbox(inbox, ["failed"]);
    expect(text).toMatch(/Failed:/);
    expect(text).not.toMatch(/Needs review:/);
  });

  it("reports an empty inbox", async () => {
    const { runsDir, workspacesDir } = harnessRoot();
    const inbox = await buildInbox({
      runsDir,
      workspacesDir,
      indexDbPath: join(runsDir, "..", ".harness", "index.sqlite"),
    });
    expect(formatInbox(inbox)).toMatch(/Inbox is empty/);
  });
});
