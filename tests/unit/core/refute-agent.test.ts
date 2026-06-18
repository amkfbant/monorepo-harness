import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { CodexExecRunner } from "../../../src/codex/codex-exec-runner.js";
import {
  REFUTE_AGENT_PROMPT_TEMPLATE,
  runRefuteAgent,
} from "../../../src/core/refute-agent.js";
import { targetChangeHash } from "../../../src/core/refute-binding.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewRefuteVotesRepository } from "../../../src/db/repositories/review-refute-votes.js";

const NOW = new Date("2026-06-18T00:00:00.000Z");

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function setupRunDir(): { runsDir: string; runId: string } {
  const runsDir = mkdtempSync(join(tmpdir(), "harness-refute-agent-"));
  const runId = "run-20260618-self-refute";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "final-diff.patch"), "diff --git a/src/a.ts\n");
  return { runsDir, runId };
}

function fakeRunnerWithOutput(output: string): CodexExecRunner {
  return {
    async run(input) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      await writeFile(input.logPaths.events, "", "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    },
  };
}

function baseInput(
  output: string,
): Parameters<typeof runRefuteAgent>[0] & {
  repository: ReviewRefuteVotesRepository;
} {
  const { runsDir, runId } = setupRunDir();
  const repository = new ReviewRefuteVotesRepository(migratedDb());
  return {
    runsDir,
    runId,
    repository,
    reviewerName: "refute-a",
    activeRequiredChanges: [{ idx: 0, change_text: "Add input validation" }],
    codexRunner: fakeRunnerWithOutput(output),
    now: NOW,
  };
}

describe("runRefuteAgent", () => {
  it("records a valid target-bound refute vote with required DSL fields", async () => {
    const input = baseInput([
      "```yaml",
      "target_change_text: Add input validation",
      "refute_verdict: refute",
      "refute_reason: Tests already cover the validation path.",
      "counter_evidence:",
      "  kind: test",
      "  ref: final-diff.patch",
      "refute_condition: The cited test must exercise invalid input.",
      "retract_condition: Retract if the test is removed.",
      "reasoning: Evidence is present in the run artifact.",
      "confidence: 0.9",
      "```",
    ].join("\n"));

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "passed",
      targetChangeHash: targetChangeHash("Add input validation"),
      targetChangeIdx: 0,
      reviewerId: "refute-a",
      refuteVerdict: "refute",
      refuteReason: "Tests already cover the validation path.",
      counterEvidenceKind: "test",
      counterEvidenceRef: "final-diff.patch",
      refuteCondition: "The cited test must exercise invalid input.",
      retractCondition: "Retract if the test is removed.",
    });
    expect(result.row.promptProvenanceJson).toContain(
      REFUTE_AGENT_PROMPT_TEMPLATE.name,
    );
  });

  it("fails closed: a refute vote with evidence kind none is recorded as rejected", async () => {
    const input = baseInput([
      "```yaml",
      "target_change_text: Add input validation",
      "refute_verdict: refute",
      "refute_reason: I disagree.",
      "counter_evidence:",
      "  kind: none",
      "refute_condition: Evidence would need to exist.",
      "retract_condition: Retract if evidence is absent.",
      "```",
    ].join("\n"));

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "evidence_none",
      targetChangeHash: targetChangeHash("Add input validation"),
      refuteVerdict: "refute",
    });
  });

  it("allows an uphold vote with evidence kind none to participate", async () => {
    const input = baseInput([
      "```yaml",
      "target_change_hash: " + targetChangeHash("Add input validation"),
      "refute_verdict: uphold",
      "counter_evidence:",
      "  kind: none",
      "reasoning: The blocker still stands.",
      "```",
    ].join("\n"));

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "passed",
      rejectReason: null,
      targetChangeHash: targetChangeHash("Add input validation"),
      refuteVerdict: "uphold",
      counterEvidenceKind: "none",
    });
  });
});
