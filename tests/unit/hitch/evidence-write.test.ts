import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { HitchValidationError } from "../../../src/hitch/types.js";
import { attachHitchEvidence } from "../../../src/hitch/evidence-write.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "harness-evidence-write-"));
  const db = openDb(join(dir, "harness.sqlite"));
  runMigrations(db);
  return db;
}

function makeRepo(db: ReturnType<typeof openDb>) {
  return new HitchRepository(db);
}

function seedHitch(
  repo: HitchRepository,
  hitchId: string,
  overrides: { status?: string } = {},
): void {
  repo.createSession({
    hitchId,
    title: "Test hitch",
    projectId: "proj",
    domain: "test",
    scope: { targetFiles: ["src/**"] },
    closeConditions: [],
    createdBy: "test",
    createdSource: "cli",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  if (overrides.status !== undefined) {
    // Force a terminal status via raw SQL for test setup
    const db = (repo as unknown as { db: ReturnType<typeof openDb> }).db;
    db.prepare("UPDATE hitch_sessions SET status = ? WHERE hitch_id = ?").run(
      overrides.status,
      hitchId,
    );
  }
}

describe("attachHitchEvidence", () => {
  // ── rejection: unknown hitch ───────────────────────────────────────────────
  it("throws HitchValidationError when hitch does not exist", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "no-such-hitch",
        label: "typecheck",
        output: "ok",
      }),
    ).toThrow(HitchValidationError);
  });

  // ── rejection: terminal hitch ──────────────────────────────────────────────
  it.each(["closed", "cancelled", "budget_exhausted", "escalated"])(
    "throws HitchValidationError when hitch is terminal (%s)",
    (terminalStatus) => {
      const db = freshDb();
      const repo = makeRepo(db);
      seedHitch(repo, "hitch-term", { status: terminalStatus });
      expect(() =>
        attachHitchEvidence(repo, {
          hitchId: "hitch-term",
          label: "typecheck",
          output: "ok",
        }),
      ).toThrow(HitchValidationError);
    },
  );

  // ── rejection: empty label ─────────────────────────────────────────────────
  it("throws HitchValidationError when label is empty after trim", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "  ",
        output: "ok",
      }),
    ).toThrow(HitchValidationError);
  });

  it("throws HitchValidationError when label is empty string", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "",
        output: "ok",
      }),
    ).toThrow(HitchValidationError);
  });

  // ── rejection: empty payload ───────────────────────────────────────────────
  it("throws HitchValidationError when all payload fields are absent", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "typecheck",
        // no command/output/metrics
      }),
    ).toThrow(HitchValidationError);
  });

  it("throws HitchValidationError when metrics is an empty object", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "typecheck",
        metrics: {},
      }),
    ).toThrow(HitchValidationError);
  });

  // ── rejection: bad metrics shape ──────────────────────────────────────────
  it("throws HitchValidationError when metrics contains a non-string/number value", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "typecheck",
        metrics: { nested: { a: 1 } as unknown as string },
      }),
    ).toThrow(HitchValidationError);
  });

  it("throws HitchValidationError when metrics contains null value", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "typecheck",
        metrics: { count: null as unknown as number },
      }),
    ).toThrow(HitchValidationError);
  });

  // ── attester is ALWAYS 'operator' ─────────────────────────────────────────
  it("persists attester='operator' regardless of any caller attempt (type prevents it, but verify persisted value)", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    // The type deliberately has no attester field, but verify the persisted row
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "manual check",
      output: "all good",
    });
    expect(row.attester).toBe("operator");
  });

  // ── happy path: minimal note payload ──────────────────────────────────────
  it("inserts a row with expected fields and listEvidence shows it", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "manual check",
      output: "all tests pass",
    });
    expect(row.hitchId).toBe("hitch-a");
    expect(row.attester).toBe("operator");
    expect(row.label).toBe("manual check");
    expect(row.kind).toBe("note");
    expect(row.secretSuspect).toBe(false);
    expect(row.redacted).toBe(false);
    expect(row.evidenceId).toMatch(/^ev-/);
    expect(row.createdAt).toBeDefined();

    const list = repo.listEvidence("hitch-a");
    expect(list).toHaveLength(1);
    expect(list[0].evidenceId).toBe(row.evidenceId);
  });

  // ── kind inference ─────────────────────────────────────────────────────────
  it("infers kind=command when command is supplied", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "typecheck",
      command: "npm run typecheck",
    });
    expect(row.kind).toBe("command");
  });

  it("infers kind=metrics when metrics is supplied (no command)", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "test run",
      metrics: { passed: 100, failed: 0 },
    });
    expect(row.kind).toBe("metrics");
    expect(row.summaryMetrics).toEqual({ passed: 100, failed: 0 });
  });

  it("uses supplied kind when explicitly provided", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "snapshot",
      kind: "before_after",
      output: "old state -> new state",
    });
    expect(row.kind).toBe("before_after");
  });

  // ── redaction: secret in command ───────────────────────────────────────────
  it("redacts command and sets secretSuspect+redacted when command contains a secret", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    // AKIA prefix triggers AWS key detection
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "deploy",
      command: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE ./deploy.sh",
    });
    expect(row.secretSuspect).toBe(true);
    expect(row.redacted).toBe(true);
    expect(row.command).toBe("[redacted]");
  });

  // ── redaction: secret in output ────────────────────────────────────────────
  it("redacts output excerpt and sets secretSuspect+redacted when output contains a secret", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const secretOutput =
      "token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ndone";
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "logs",
      output: secretOutput,
    });
    expect(row.secretSuspect).toBe(true);
    expect(row.redacted).toBe(true);
    expect(row.outputExcerpt).toBe("[redacted]");
  });

  // ── redaction: secret in metric value ─────────────────────────────────────
  it("redacts a metric value and sets secretSuspect+redacted when a metric contains a secret", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "env check",
      metrics: {
        count: 5,
        api_key: "sk-proj-reallyLongSecretTokenHereXXXXXXXXXXXXXXXXXXXXXX",
      },
    });
    expect(row.secretSuspect).toBe(true);
    expect(row.redacted).toBe(true);
    // The numeric value is unaffected; the secret string is redacted
    expect((row.summaryMetrics as Record<string, unknown>)["count"]).toBe(5);
    expect((row.summaryMetrics as Record<string, unknown>)["api_key"]).toBe(
      "[redacted]",
    );
  });

  // ── outputExcerpt truncation ───────────────────────────────────────────────
  it("truncates outputExcerpt to the tail 8192 bytes when output exceeds the cap", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const longOutput = "x".repeat(10000);
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "big output",
      output: longOutput,
    });
    expect(row.outputExcerpt).not.toBeNull();
    const excerpt = row.outputExcerpt!;
    // Should be capped at 8192 bytes
    expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(8192);
    // Should be the TAIL
    expect(excerpt).toBe(longOutput.slice(longOutput.length - 8192));
  });

  // ── output within cap ─────────────────────────────────────────────────────
  it("preserves outputExcerpt unchanged when output is within the 8192 byte cap", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const shortOutput = "tests passed";
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "test",
      output: shortOutput,
    });
    expect(row.outputExcerpt).toBe(shortOutput);
  });

  // ── runId/conditionId pass-through ────────────────────────────────────────
  it("stores runId and conditionId when provided", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "ci run",
      output: "green",
      runId: "run-123",
      conditionId: "cond-456",
    });
    expect(row.runId).toBe("run-123");
    expect(row.conditionId).toBe("cond-456");
  });

  // ── multiple insertions are independent ───────────────────────────────────
  it("generates unique evidence_ids for multiple calls", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const r1 = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "first",
      output: "one",
    });
    const r2 = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "second",
      output: "two",
    });
    expect(r1.evidenceId).not.toBe(r2.evidenceId);
    expect(repo.listEvidence("hitch-a")).toHaveLength(2);
  });

  // ── non-terminal statuses are accepted ────────────────────────────────────
  it.each(["open", "in_progress", "close_ready", "diverging"])(
    "accepts a hitch in non-terminal status %s",
    (status) => {
      const db = freshDb();
      const repo = makeRepo(db);
      seedHitch(repo, "hitch-live", { status });
      expect(() =>
        attachHitchEvidence(repo, {
          hitchId: "hitch-live",
          label: "check",
          output: "ok",
        }),
      ).not.toThrow();
    },
  );

  // ── now injection for deterministic created_at ────────────────────────────
  it("uses injected now for created_at when provided", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const fixedNow = "2030-05-15T12:00:00.000Z";
    const row = attachHitchEvidence(
      repo,
      { hitchId: "hitch-a", label: "test", output: "ok" },
      { now: fixedNow },
    );
    expect(row.createdAt).toBe(fixedNow);
  });

  // ── F2: label is a mandatory-redaction field ──────────────────────────────
  it("redacts label and sets secretSuspect+redacted when label contains a secret", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      // operator-supplied free text — must be scanned like command/output
      label: "deploy ghp_0123456789abcdefghijklmnopqrstuvwx",
      output: "ok",
    });
    expect(row.label).toBe("[redacted]");
    expect(row.secretSuspect).toBe(true);
    expect(row.redacted).toBe(true);
  });

  it("preserves a non-secret label verbatim", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "manual check passed",
      output: "ok",
    });
    expect(row.label).toBe("manual check passed");
    expect(row.redacted).toBe(false);
  });

  // ── F3: a secret-shaped metric KEY is rejected fail-closed ─────────────────
  it("throws HitchValidationError when a metric key looks like a secret", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "metrics",
        metrics: { "ghp_0123456789abcdefghijklmnopqrstuvwx": "1" },
      }),
    ).toThrow(HitchValidationError);
  });

  it("does not leak the secret-shaped metric key in the error message", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const secretKey = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    try {
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "metrics",
        metrics: { [secretKey]: "1" },
      });
      throw new Error("expected attachHitchEvidence to throw");
    } catch (e) {
      const err = e as HitchValidationError;
      expect(err).toBeInstanceOf(HitchValidationError);
      expect(err.message).not.toContain(secretKey);
      for (const issue of err.issues) {
        expect(issue.message).not.toContain(secretKey);
        expect(issue.path).not.toContain(secretKey);
      }
    }
  });

  it("accepts a benign metric key whose name merely mentions 'key'", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    // "api_key" has no token shape and no assignment punctuation → not a secret.
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "metrics",
      metrics: { api_key_rotations: 3 },
    });
    expect(row.summaryMetrics).toEqual({ api_key_rotations: 3 });
    expect(row.redacted).toBe(false);
  });

  // ── C1 (codex P2): blank command/output must not satisfy the payload gate ─
  it("throws EVIDENCE_PAYLOAD_EMPTY when output is empty and nothing else is supplied", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    expect(() =>
      attachHitchEvidence(repo, { hitchId: "hitch-a", label: "x", output: "" }),
    ).toThrow(HitchValidationError);
    expect(() =>
      attachHitchEvidence(repo, {
        hitchId: "hitch-a",
        label: "x",
        output: "   ",
      }),
    ).toThrow(HitchValidationError);
    expect(() =>
      attachHitchEvidence(repo, { hitchId: "hitch-a", label: "x", command: "" }),
    ).toThrow(HitchValidationError);
  });

  // ── C4 (codex P2): attaching evidence bumps the hitch session updated_at ───
  it("bumps the hitch session updated_at when evidence is attached", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    attachHitchEvidence(
      repo,
      { hitchId: "hitch-a", label: "x", output: "ok" },
      { now: "2031-02-03T04:05:06.000Z" },
    );
    expect(repo.getSession("hitch-a")?.updatedAt).toBe(
      "2031-02-03T04:05:06.000Z",
    );
  });

  // ── C6 (codex P2): a blank command must not drive kind or be stored ───────
  it("ignores a blank command for kind inference and does not store it", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "x",
      command: "   ",
      output: "real body",
    });
    expect(row.kind).toBe("note"); // NOT "command"
    expect(row.command).toBeNull(); // blank command not persisted
    expect(row.outputExcerpt).toBe("real body");
  });

  // ── C7 (codex P2): excerpt stays within the byte cap across a multibyte cut ─
  it("keeps outputExcerpt within the byte cap when the tail splits a multibyte char", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    // 3-byte chars × 4000 = 12000 bytes > 8192; the tail cut lands mid-character.
    const big = "あ".repeat(4000);
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "x",
      output: big,
    });
    expect(row.outputExcerpt).not.toBeNull();
    expect(Buffer.byteLength(row.outputExcerpt!, "utf8")).toBeLessThanOrEqual(
      8192,
    );
    // no U+FFFD replacement char from a severed multibyte sequence
    expect(row.outputExcerpt!).not.toContain("�");
  });

  // ── F8: non-secret command survives the writer round-trip ─────────────────
  it("preserves a non-secret command verbatim (writer round-trip)", () => {
    const db = freshDb();
    const repo = makeRepo(db);
    seedHitch(repo, "hitch-a");
    const row = attachHitchEvidence(repo, {
      hitchId: "hitch-a",
      label: "typecheck",
      command: "npm run typecheck",
    });
    expect(row.command).toBe("npm run typecheck");
    expect(row.redacted).toBe(false);
  });
});
