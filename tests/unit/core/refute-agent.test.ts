import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
  mkdirSync(join(runDir, "commands"), { recursive: true });
  writeFileSync(join(runDir, "commands", "test.out.log"), "tests passed\n");
  return { runsDir, runId };
}

function fakeRunnerWithOutput(
  output: string,
  opts: { exitCode?: number; timedOut?: boolean } = {},
): CodexExecRunner {
  return {
    async run(input) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      await writeFile(input.logPaths.events, "", "utf8");
      return {
        exitCode: opts.exitCode ?? 0,
        timedOut: opts.timedOut ?? false,
        durationMs: 0,
      };
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

function validRefuteYaml(
  evidence: { kind: "diff" | "test"; ref: string } = {
    kind: "diff",
    ref: "final-diff.patch",
  },
): string {
  return [
    "```yaml",
    "target_change_text: Add input validation",
    "refute_verdict: refute",
    "refute_reason: Tests already cover the validation path.",
    "counter_evidence:",
    `  kind: ${evidence.kind}`,
    `  ref: ${evidence.ref}`,
    "refute_condition: The cited evidence must exercise invalid input.",
    "retract_condition: Retract if the evidence is removed.",
    "reasoning: Evidence is present in the run artifact.",
    "confidence: 0.9",
    "```",
  ].join("\n");
}

describe("runRefuteAgent", () => {
  it("records a valid target-bound refute vote with required test evidence", async () => {
    const input = baseInput(
      validRefuteYaml({ kind: "test", ref: "commands/test.out.log" }),
    );

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "passed",
      targetChangeHash: targetChangeHash("Add input validation"),
      targetChangeIdx: 0,
      reviewerId: "refute-a",
      refuteVerdict: "refute",
      refuteReason: "Tests already cover the validation path.",
      counterEvidenceKind: "test",
      counterEvidenceRef: "commands/test.out.log",
      refuteCondition: "The cited evidence must exercise invalid input.",
      retractCondition: "Retract if the evidence is removed.",
    });
    expect(result.row.promptProvenanceJson).toContain(
      REFUTE_AGENT_PROMPT_TEMPLATE.name,
    );
  });

  it("keeps prompt identity independent of volatile required_change idx values", async () => {
    const first = baseInput(validRefuteYaml());
    first.activeRequiredChanges = [
      { idx: 0, change_text: "Add input validation" },
      { idx: 1, change_text: "Fix retry backoff" },
    ];
    const second = baseInput(validRefuteYaml());
    second.activeRequiredChanges = [
      { idx: 7, change_text: "Fix retry backoff" },
      { idx: 9, change_text: "Add input validation" },
    ];

    const firstResult = await runRefuteAgent(first);
    const secondResult = await runRefuteAgent(second);

    expect(firstResult.row.promptSha256).toBe(secondResult.row.promptSha256);
    expect(firstResult.row.promptSha256).toHaveLength(64);
  });

  it("passes a diff refute only when the evidence ref is a diff artifact", async () => {
    const input = baseInput(
      validRefuteYaml({ kind: "diff", ref: "final-diff.patch" }),
    );

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "passed",
      rejectReason: null,
      counterEvidenceKind: "diff",
      counterEvidenceRef: "final-diff.patch",
    });
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

  it("fails closed: kind=test cannot cite final-diff.patch as evidence", async () => {
    const input = baseInput(
      validRefuteYaml({ kind: "test", ref: "final-diff.patch" }),
    );

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "evidence_kind_mismatch",
      counterEvidenceKind: "test",
      counterEvidenceRef: "final-diff.patch",
    });
  });

  it("fails closed: kind=diff cannot cite a command output log as evidence", async () => {
    const input = baseInput(
      validRefuteYaml({ kind: "diff", ref: "commands/test.out.log" }),
    );

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "evidence_kind_mismatch",
      counterEvidenceKind: "diff",
      counterEvidenceRef: "commands/test.out.log",
    });
  });

  it("fails closed: an absent diff evidence artifact is rejected", async () => {
    const input = baseInput(
      validRefuteYaml({ kind: "diff", ref: "missing.patch" }),
    );

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "artifact_absent",
      counterEvidenceKind: "diff",
      counterEvidenceRef: "missing.patch",
    });
  });

  it("fails closed: a symlinked evidence artifact is not accepted", async () => {
    const input = baseInput(
      validRefuteYaml({ kind: "diff", ref: "final-diff.patch" }),
    );
    const runDir = join(input.runsDir, input.runId);
    writeFileSync(join(runDir, "review-decision.yaml"), "decision: approved\n");
    const { rmSync } = await import("node:fs");
    rmSync(join(runDir, "final-diff.patch"));
    symlinkSync(
      join(runDir, "review-decision.yaml"),
      join(runDir, "final-diff.patch"),
    );

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "artifact_absent",
      counterEvidenceKind: "diff",
      counterEvidenceRef: "final-diff.patch",
    });
  });

  it("fails closed: a test evidence ref through a symlinked commands directory is not accepted", async () => {
    const input = baseInput(
      validRefuteYaml({ kind: "test", ref: "commands/test.out.log" }),
    );
    const runDir = join(input.runsDir, input.runId);
    const realCommands = mkdtempSync(join(tmpdir(), "harness-refute-commands-"));
    writeFileSync(join(realCommands, "test.out.log"), "external tests\n");
    const { rmSync } = await import("node:fs");
    rmSync(join(runDir, "commands"), { recursive: true, force: true });
    symlinkSync(realCommands, join(runDir, "commands"), "dir");

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "artifact_absent",
      counterEvidenceKind: "test",
      counterEvidenceRef: "commands/test.out.log",
    });
  });

  it("fails closed: a test evidence ref whose leaf file is a symlink is not accepted", async () => {
    const input = baseInput(
      validRefuteYaml({ kind: "test", ref: "commands/test.out.log" }),
    );
    const runDir = join(input.runsDir, input.runId);
    const { rmSync } = await import("node:fs");
    rmSync(join(runDir, "commands", "test.out.log"));
    symlinkSync(
      join(runDir, "final-diff.patch"),
      join(runDir, "commands", "test.out.log"),
    );

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "artifact_absent",
      counterEvidenceKind: "test",
      counterEvidenceRef: "commands/test.out.log",
    });
  });

  it("fails closed: a refute verdict missing required DSL fields is rejected", async () => {
    const input = baseInput([
      "```yaml",
      "target_change_text: Add input validation",
      "refute_verdict: refute",
      "counter_evidence:",
      "  kind: diff",
      "  ref: final-diff.patch",
      "refute_condition: Evidence must exist.",
      "retract_condition: Retract if evidence is absent.",
      "```",
    ].join("\n"));

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "missing_field",
      refuteVerdict: "refute",
    });
  });

  it("fails closed: a codex non-zero exit records a rejected audit row", async () => {
    const input = baseInput(validRefuteYaml());
    input.codexRunner = fakeRunnerWithOutput(validRefuteYaml(), { exitCode: 7 });

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "codex_failed",
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

  it("allows an agent-level inconclusive vote to be recorded as passed but non-participating", async () => {
    const input = baseInput([
      "```yaml",
      "target_change_hash: " + targetChangeHash("Add input validation"),
      "refute_verdict: inconclusive",
      "counter_evidence:",
      "  kind: none",
      "reasoning: The run artifacts are insufficient.",
      "```",
    ].join("\n"));

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "passed",
      rejectReason: null,
      refuteVerdict: "inconclusive",
      counterEvidenceKind: "none",
    });
  });

  it("P1-ISO: materializes only refute evidence inputs outside the runDir tree", async () => {
    const input = baseInput(validRefuteYaml());
    const runDir = join(input.runsDir, input.runId);
    writeFileSync(join(runDir, "review-decision.yaml"), "decision: approved\n");
    mkdirSync(join(runDir, "reviewers", "prior"), { recursive: true });
    writeFileSync(
      join(runDir, "reviewers", "prior", "refute-agent.out.log"),
      "prior verdict\n",
    );
    writeFileSync(join(runDir, "untracked-extra.patch"), "diff --git a/new.ts\n");
    writeFileSync(join(runDir, "commands", "test.err.log"), "stderr noise\n");
    writeFileSync(join(runDir, "summary.md"), "summary is not refute input\n");
    const seen: {
      worktreePath?: string;
      finalDiff?: boolean;
      untrackedPatch?: boolean;
      commandOut?: boolean;
      commandErr?: boolean;
      summary?: boolean;
      rootVerdict?: boolean;
      reviewers?: boolean;
    } = {};
    input.codexRunner = {
      async run(runInput) {
        seen.worktreePath = runInput.worktreePath;
        seen.finalDiff = existsSync(join(runInput.worktreePath, "final-diff.patch"));
        seen.untrackedPatch = existsSync(
          join(runInput.worktreePath, "untracked-extra.patch"),
        );
        seen.commandOut = existsSync(
          join(runInput.worktreePath, "commands", "test.out.log"),
        );
        seen.commandErr = existsSync(
          join(runInput.worktreePath, "commands", "test.err.log"),
        );
        seen.summary = existsSync(join(runInput.worktreePath, "summary.md"));
        seen.rootVerdict = existsSync(
          join(runInput.worktreePath, "review-decision.yaml"),
        );
        seen.reviewers = existsSync(join(runInput.worktreePath, "reviewers"));
        const { writeFile } = await import("node:fs/promises");
        await writeFile(runInput.logPaths.stdout, validRefuteYaml(), "utf8");
        await writeFile(runInput.logPaths.stderr, "", "utf8");
        await writeFile(runInput.logPaths.events, "", "utf8");
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      },
    };

    const result = await runRefuteAgent(input);

    expect(result.row.validationStatus).toBe("passed");
    expect(relative(runDir, seen.worktreePath as string).startsWith("..")).toBe(
      true,
    );
    expect(seen.finalDiff).toBe(true);
    expect(seen.untrackedPatch).toBe(true);
    expect(seen.commandOut).toBe(true);
    expect(seen.commandErr).toBe(false);
    expect(seen.summary).toBe(false);
    expect(seen.rootVerdict).toBe(false);
    expect(seen.reviewers).toBe(false);
    expect(existsSync(seen.worktreePath as string)).toBe(false);
  });

  it("fails closed: tampering with a non-allowlisted run artifact rejects the vote", async () => {
    const input = baseInput(validRefuteYaml());
    const diffPath = join(input.runsDir, input.runId, "final-diff.patch");
    input.codexRunner = {
      async run(runInput) {
        writeFileSync(diffPath, "tampered diff\n");
        const now = new Date();
        utimesSync(diffPath, now, new Date(now.getTime() + 5000));
        const { writeFile } = await import("node:fs/promises");
        await writeFile(runInput.logPaths.stdout, validRefuteYaml(), "utf8");
        await writeFile(runInput.logPaths.stderr, "", "utf8");
        await writeFile(runInput.logPaths.events, "", "utf8");
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      },
    };

    const result = await runRefuteAgent(input);

    expect(readFileSync(diffPath, "utf8")).toBe("tampered diff\n");
    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "artifact_tamper",
      refuteVerdict: "refute",
    });
  });

  it("fails closed: root-level refute-agent log writes are not tamper-allowlisted", async () => {
    const input = baseInput(validRefuteYaml());
    const runDir = join(input.runsDir, input.runId);
    const rootLog = join(runDir, "refute-agent.out.log");
    input.codexRunner = {
      async run(runInput) {
        writeFileSync(rootLog, "root-level output must not be allowlisted\n");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(runInput.logPaths.stdout, validRefuteYaml(), "utf8");
        await writeFile(runInput.logPaths.stderr, "", "utf8");
        await writeFile(runInput.logPaths.events, "", "utf8");
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      },
    };

    const result = await runRefuteAgent(input);

    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "artifact_tamper",
      refuteVerdict: "refute",
    });
    expect(readFileSync(rootLog, "utf8")).toContain("root-level output");
  });

  it("rejects a reviewerName that is not a safe path component", async () => {
    const input = baseInput(validRefuteYaml());
    input.reviewerName = "../refute-a";

    await expect(runRefuteAgent(input)).rejects.toThrow(/path-safe/);
  });
});
