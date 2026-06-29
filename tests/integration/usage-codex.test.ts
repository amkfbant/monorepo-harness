import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Command } from "commander";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { harnessPaths } from "../../src/config/paths.js";
import {
  recordAgentUsage,
  type AgentUsageTurnInput,
} from "../../src/db/repositories/agent-usage.js";
import { registerUsageCommands } from "../../src/cli/usage.js";

/** Run `harness usage codex [args]` capturing stdout/stderr. Never throws. */
async function runUsageCodex(
  root: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; threw: boolean }> {
  const program = new Command();
  program.exitOverride();
  registerUsageCommands(program, { getHarnessRoot: () => root });
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (s: string) => {
    outChunks.push(String(s));
    return true;
  };
  (process.stderr.write as unknown) = (s: string) => {
    errChunks.push(String(s));
    return true;
  };
  let threw = false;
  try {
    await program.parseAsync(["node", "harness", "usage", "codex", ...args]);
  } catch {
    threw = true;
  } finally {
    (process.stdout.write as unknown) = origOut;
    (process.stderr.write as unknown) = origErr;
  }
  return { stdout: outChunks.join(""), stderr: errChunks.join(""), threw };
}

function freshRootWithMigratedDb(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-codex-cli-"));
  const db = openDb(harnessPaths(root).dbPath);
  runMigrations(db);
  db.close();
  return root;
}

function codexTurn(over: Partial<AgentUsageTurnInput> = {}): AgentUsageTurnInput {
  return {
    turnSeq: 0,
    model: "gpt-5.5",
    usageSource: "exact",
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 60,
    reasoningOutputTokens: 25,
    totalTokens: 160,
    ...over,
  };
}

function seedCodexExternal(
  root: string,
  a: {
    courseId?: string | null;
    hitchId?: string | null;
    externalLabel?: string | null;
    runId?: string | null;
    turns?: AgentUsageTurnInput[];
  },
): void {
  const db = openDb(harnessPaths(root).dbPath);
  try {
    recordAgentUsage({
      db,
      tool: "codex",
      role: "external",
      usageSource: "exact",
      courseId: a.courseId,
      hitchId: a.hitchId,
      externalLabel: a.externalLabel,
      runId: a.runId,
      turns: a.turns ?? [codexTurn()],
      onError: (e) => {
        throw e;
      },
    });
  } finally {
    db.close();
  }
}

describe("harness usage codex (fail-open + aggregation) #403", () => {
  it("missing DB → exit 0, zero summary (json)", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-codex-nodb-"));
    const r = await runUsageCodex(root, ["--json"]);
    expect(r.threw).toBe(false);
    expect(JSON.parse(r.stdout).totals.invocations).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("schema < v36 (no agent_invocation table) → zero summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-codex-empty-"));
    openDb(harnessPaths(root).dbPath).close();
    const r = await runUsageCodex(root, ["--json"]);
    expect(r.threw).toBe(false);
    expect(JSON.parse(r.stdout).totals.invocations).toBe(0);
    expect(r.stderr).toContain("agent_invocation table absent");
    rmSync(root, { recursive: true, force: true });
  });

  it("[#351] corrupt DB → fail-open zero summary, NOT a hard exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-codex-corrupt-"));
    mkdirSync(dirname(harnessPaths(root).dbPath), { recursive: true });
    writeFileSync(harnessPaths(root).dbPath, "this is not a sqlite database\n");
    const r = await runUsageCodex(root, ["--json"]);
    expect(r.threw).toBe(false);
    expect(JSON.parse(r.stdout).totals.invocations).toBe(0);
    expect(r.stderr.toLowerCase()).toContain("usage:");
    rmSync(root, { recursive: true, force: true });
  });

  it("happy path → aggregates external codex with the codex taxonomy", async () => {
    const root = freshRootWithMigratedDb();
    seedCodexExternal(root, {
      courseId: "c1",
      hitchId: "h1",
      externalLabel: "L1",
    });
    const r = await runUsageCodex(root, ["--json"]);
    expect(r.threw).toBe(false);
    const out = JSON.parse(r.stdout);
    expect(out.totals.invocations).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].courseId).toBe("c1");
    expect(out.rows[0].hitchId).toBe("h1");
    expect(out.rows[0].externalLabel).toBe("L1");
    expect(out.rows[0].cachedInputTokens).toBe(40);
    expect(out.rows[0].reasoningOutputTokens).toBe(25);
    expect(out.rows[0].totalTokens).toBe(160);
    rmSync(root, { recursive: true, force: true });
  });

  it("sums multiple invocations in one group; text output carries the codex columns", async () => {
    const root = freshRootWithMigratedDb();
    seedCodexExternal(root, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    seedCodexExternal(root, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    const r = await runUsageCodex(root, []);
    expect(r.threw).toBe(false);
    expect(r.stdout).toContain("course=c1\thitch=h1\tlabel=L1");
    expect(r.stdout).toContain("invocations=2");
    expect(r.stdout).toContain("reasoning_out=50");
    expect(r.stdout).toContain("total=320");
    expect(r.stdout).toContain("TOTAL");
    rmSync(root, { recursive: true, force: true });
  });

  it("composite grouping → one row per distinct course/hitch/label", async () => {
    const root = freshRootWithMigratedDb();
    seedCodexExternal(root, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    seedCodexExternal(root, { courseId: "c1", hitchId: "h2", externalLabel: "L1" });
    seedCodexExternal(root, { courseId: "c2", hitchId: "h3", externalLabel: "L2" });
    const r = await runUsageCodex(root, ["--json"]);
    expect(JSON.parse(r.stdout).rows).toHaveLength(3);
    rmSync(root, { recursive: true, force: true });
  });

  it("--hitch narrows to a single hitch", async () => {
    const root = freshRootWithMigratedDb();
    seedCodexExternal(root, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    seedCodexExternal(root, { courseId: "c1", hitchId: "h2", externalLabel: "L1" });
    const r = await runUsageCodex(root, ["--json", "--hitch", "h1"]);
    const out = JSON.parse(r.stdout);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].hitchId).toBe("h1");
    rmSync(root, { recursive: true, force: true });
  });

  it("excludes internal codex (role=coder) and claude external rows", async () => {
    const root = freshRootWithMigratedDb();
    seedCodexExternal(root, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    const db = openDb(harnessPaths(root).dbPath);
    try {
      recordAgentUsage({
        db,
        tool: "codex",
        role: "coder",
        runId: "run-1",
        usageSource: "exact",
        turns: [codexTurn()],
        onError: (e) => {
          throw e;
        },
      });
      recordAgentUsage({
        db,
        tool: "claude",
        role: "external",
        externalLabel: "ops-subagent",
        sessionId: "s1",
        agentId: "a1",
        usageSource: "parsed_log",
        turns: [
          {
            turnSeq: 0,
            model: "claude-opus-4-8",
            inputTokens: 5,
            outputTokens: 5,
            totalTokens: 10,
            usageSource: "parsed_log",
          },
        ],
        onError: (e) => {
          throw e;
        },
      });
    } finally {
      db.close();
    }
    const r = await runUsageCodex(root, ["--json"]);
    const out = JSON.parse(r.stdout);
    expect(out.totals.invocations).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].courseId).toBe("c1");
    rmSync(root, { recursive: true, force: true });
  });

  it("empty DB → text says no external codex usage", async () => {
    const root = freshRootWithMigratedDb();
    const r = await runUsageCodex(root, []);
    expect(r.threw).toBe(false);
    expect(r.stdout).toContain("No external codex usage recorded.");
    rmSync(root, { recursive: true, force: true });
  });
});
