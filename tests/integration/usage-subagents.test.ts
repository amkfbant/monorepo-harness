import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Command } from "commander";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { harnessPaths } from "../../src/config/paths.js";
import { recordAgentUsage } from "../../src/db/repositories/agent-usage.js";
import { registerUsageCommands } from "../../src/cli/usage.js";

/** Run `harness usage subagents [args]` capturing stdout/stderr. Never throws. */
async function runUsage(
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
    await program.parseAsync(["node", "harness", "usage", "subagents", ...args]);
  } catch {
    threw = true;
  } finally {
    (process.stdout.write as unknown) = origOut;
    (process.stderr.write as unknown) = origErr;
  }
  return { stdout: outChunks.join(""), stderr: errChunks.join(""), threw };
}

function freshRootWithMigratedDb(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-cli-"));
  const db = openDb(harnessPaths(root).dbPath);
  runMigrations(db);
  db.close();
  return root;
}

describe("harness usage subagents (fail-open + aggregation) #351", () => {
  it("missing DB → exit 0, zero summary (json)", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-nodb-"));
    const r = await runUsage(root, ["--json"]);
    expect(r.threw).toBe(false);
    expect(JSON.parse(r.stdout).totals.invocations).toBe(0);
  });

  it("schema < v36 (no agent_invocation table) → zero summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-empty-"));
    // openDb creates the file but we do NOT migrate → no agent_invocation table.
    openDb(harnessPaths(root).dbPath).close();
    const r = await runUsage(root, ["--json"]);
    expect(r.threw).toBe(false);
    expect(JSON.parse(r.stdout).totals.invocations).toBe(0);
    expect(r.stderr).toContain("agent_invocation table absent");
  });

  it("[#351] corrupt DB → fail-open zero summary, NOT a hard exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-corrupt-"));
    mkdirSync(dirname(harnessPaths(root).dbPath), { recursive: true });
    // Write garbage so the file exists but is not a valid sqlite database.
    writeFileSync(harnessPaths(root).dbPath, "this is not a sqlite database\n");
    const r = await runUsage(root, ["--json"]);
    expect(r.threw).toBe(false); // must NOT propagate to exit 2
    expect(JSON.parse(r.stdout).totals.invocations).toBe(0);
    expect(r.stderr.toLowerCase()).toContain("usage:");
  });

  it("happy path → aggregates claude external rows", async () => {
    const root = freshRootWithMigratedDb();
    const db = openDb(harnessPaths(root).dbPath);
    try {
      recordAgentUsage({
        db,
        tool: "claude",
        role: "external",
        externalLabel: "ops-subagent",
        sessionId: "s1",
        agentId: "a1",
        agentType: "code-reviewer",
        model: "claude-opus-4-8",
        usageSource: "parsed_log",
        turns: [
          {
            turnSeq: 0,
            model: "claude-opus-4-8",
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
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
    const r = await runUsage(root, ["--json"]);
    expect(r.threw).toBe(false);
    const out = JSON.parse(r.stdout);
    expect(out.totals.invocations).toBe(1);
    expect(out.totals.inputTokens).toBe(100);
    expect(out.totals.totalTokens).toBe(140);
    expect(out.rows[0].agentType).toBe("code-reviewer");
  });

  it("readonly: does NOT migrate a pre-v36 DB (observational command)", async () => {
    // A DB with NO agent_invocation table must STAY without it after the command
    // (the command must not silently runMigrations on a read).
    const root = mkdtempSync(join(tmpdir(), "usage-nomigrate-"));
    openDb(harnessPaths(root).dbPath).close();
    await runUsage(root, ["--json"]);
    const db = openDb(harnessPaths(root).dbPath);
    try {
      const t = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_invocation'",
        )
        .get();
      expect(t).toBeUndefined(); // still absent — no migration happened
    } finally {
      db.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
});
