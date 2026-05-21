import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

// a pid that is essentially certain not to exist → liveness "dead"
const DEAD_PID = 2147483646;
import {
  checkMaintenance,
  runMaintenanceCleanup,
  parseDuration,
  MaintenanceError,
} from "../../src/core/maintenance.js";

interface Root {
  runsDir: string;
  workspacesDir: string;
  locksDir: string;
}

function harnessRoot(): Root {
  const root = mkdtempSync(join(tmpdir(), "harness-mnt-"));
  const r = {
    runsDir: join(root, "runs"),
    workspacesDir: join(root, "workspaces"),
    locksDir: join(root, "locks"),
  };
  mkdirSync(r.runsDir, { recursive: true });
  mkdirSync(r.workspacesDir, { recursive: true });
  mkdirSync(r.locksDir, { recursive: true });
  return r;
}

function writeRun(r: Root, runId: string, status: string): void {
  mkdirSync(join(r.runsDir, runId), { recursive: true });
  writeFileSync(
    join(r.runsDir, runId, "meta.json"),
    JSON.stringify({
      runId,
      domain: "apps/x",
      status,
      startedAt: "2026-05-21T00:00:00Z",
    }),
  );
}

function writeWorktree(r: Root, runId: string): void {
  mkdirSync(join(r.workspacesDir, runId, "repo"), { recursive: true });
}

function writeLock(
  r: Root,
  name: string,
  acquiredAt: string,
  opts: { pid?: number; host?: string } = {},
): void {
  writeFileSync(
    join(r.locksDir, name),
    JSON.stringify({
      runId: "run-x",
      // default: this host + a dead pid → liveness "dead" → cleanable
      pid: opts.pid ?? DEAD_PID,
      hostname: opts.host ?? hostname(),
      acquiredAt,
    }),
  );
}

describe("checkMaintenance", () => {
  it("E4-4-1: detects a stale lock whose process is dead (auto-cleanable)", async () => {
    const r = harnessRoot();
    writeLock(r, "apps-x.lock", "2020-01-01T00:00:00Z");
    const f = (await checkMaintenance(r)).find((x) => x.kind === "stale-lock");
    expect(f?.cleanable).toBe(true);
  });

  it("a fresh lock is NOT stale", async () => {
    const r = harnessRoot();
    writeLock(r, "apps-x.lock", new Date().toISOString());
    const findings = await checkMaintenance(r);
    expect(findings.find((f) => f.kind === "stale-lock")).toBeUndefined();
  });

  it("an old lock owned by a LIVE process is not flagged", async () => {
    const r = harnessRoot();
    // process.pid is alive on this host → not stale despite the old time
    writeLock(r, "apps-x.lock", "2020-01-01T00:00:00Z", { pid: process.pid });
    const findings = await checkMaintenance(r);
    expect(findings.find((f) => f.kind === "stale-lock")).toBeUndefined();
  });

  it("an old lock on another host is flagged but NOT auto-cleanable", async () => {
    const r = harnessRoot();
    writeLock(r, "apps-x.lock", "2020-01-01T00:00:00Z", {
      host: "some-other-host",
    });
    const f = (await checkMaintenance(r)).find((x) => x.kind === "stale-lock");
    expect(f?.cleanable).toBe(false);
  });

  it("E4-4-2: detects an orphan worktree", async () => {
    const r = harnessRoot();
    writeWorktree(r, "run-20260521-apps-x-orphan");
    const findings = await checkMaintenance(r);
    const f = findings.find((x) => x.kind === "orphan-worktree");
    expect(f?.target).toBe("run-20260521-apps-x-orphan");
    expect(f?.cleanable).toBe(true);
  });

  it("E4-4-3: detects an approved run with an uncleaned worktree", async () => {
    const r = harnessRoot();
    writeRun(r, "run-20260521-apps-x-appr", "approved");
    writeWorktree(r, "run-20260521-apps-x-appr");
    const findings = await checkMaintenance(r);
    const f = findings.find((x) => x.kind === "uncleaned-finished");
    expect(f?.target).toBe("run-20260521-apps-x-appr");
    expect(f?.cleanable).toBe(false); // goes through `harness cleanup`
  });

  it("detects a cleaned run that still has a worktree", async () => {
    const r = harnessRoot();
    writeRun(r, "run-20260521-apps-x-cl", "cleaned");
    writeWorktree(r, "run-20260521-apps-x-cl");
    const findings = await checkMaintenance(r);
    expect(
      findings.find((f) => f.kind === "cleaned-with-worktree"),
    ).toBeDefined();
  });

  it("reports nothing when everything is clean", async () => {
    const r = harnessRoot();
    writeRun(r, "run-20260521-apps-x-ok", "needs_review");
    expect(await checkMaintenance(r)).toHaveLength(0);
  });
});

describe("runMaintenanceCleanup", () => {
  it("E4-4-4: --dry-run lists removals without deleting", async () => {
    const r = harnessRoot();
    writeWorktree(r, "run-20260521-apps-x-orphan");
    const result = await runMaintenanceCleanup({
      ...r,
      dryRun: true,
      force: false,
    });
    expect(result.dryRun).toBe(true);
    expect(result.removed).toHaveLength(1);
    // nothing actually deleted
    expect(existsSync(join(r.workspacesDir, "run-20260521-apps-x-orphan"))).toBe(
      true,
    );
  });

  it("E4-4-5: a real cleanup without --force is refused", async () => {
    const r = harnessRoot();
    writeWorktree(r, "run-20260521-apps-x-orphan");
    await expect(
      runMaintenanceCleanup({ ...r, dryRun: false, force: false }),
    ).rejects.toThrow(/--force/);
    // still there
    expect(existsSync(join(r.workspacesDir, "run-20260521-apps-x-orphan"))).toBe(
      true,
    );
  });

  it("removes debris with --force", async () => {
    const r = harnessRoot();
    writeWorktree(r, "run-20260521-apps-x-orphan");
    writeLock(r, "apps-x.lock", "2020-01-01T00:00:00Z");
    const result = await runMaintenanceCleanup({
      ...r,
      dryRun: false,
      force: true,
    });
    expect(result.removed.length).toBe(2);
    expect(existsSync(join(r.workspacesDir, "run-20260521-apps-x-orphan"))).toBe(
      false,
    );
    expect(existsSync(join(r.locksDir, "apps-x.lock"))).toBe(false);
  });

  it("--older-than skips recent debris", async () => {
    const r = harnessRoot();
    writeWorktree(r, "run-20260521-apps-x-orphan"); // just created
    const result = await runMaintenanceCleanup({
      ...r,
      dryRun: true,
      force: false,
      olderThanMs: 86400000, // 1 day
    });
    expect(result.removed).toHaveLength(0);
  });
});

describe("parseDuration", () => {
  it("parses d / h durations", () => {
    expect(parseDuration("30d")).toBe(30 * 86400000);
    expect(parseDuration("12h")).toBe(12 * 3600000);
  });
  it("rejects an invalid duration", () => {
    expect(() => parseDuration("30x")).toThrow(MaintenanceError);
  });
});
