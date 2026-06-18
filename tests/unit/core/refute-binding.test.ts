import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  normalizeChangeText,
  TARGET_CHANGE_HASH_MISSING_SENTINEL,
  TARGET_CHANGE_HASH_VERSION,
  targetChangeHash,
  verifyAndRecordRefuteBinding,
  verifyRefuteBinding,
} from "../../../src/core/refute-binding.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewRefuteVotesRepository } from "../../../src/db/repositories/review-refute-votes.js";

const NOW = "2026-06-17T00:00:00.000Z";

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("normalizeChangeText", () => {
  it("normalizes NFC, line endings, horizontal whitespace, and outer trim", () => {
    expect(
      normalizeChangeText("  Cafe\u0301\t\tneeds   validation  \r\n\tsoon  "),
    ).toBe("Café needs validation\n soon");
  });

  it("keeps case and punctuation differences distinct", () => {
    expect(targetChangeHash("Add validation.")).not.toBe(
      targetChangeHash("add validation"),
    );
  });

  it("hashes equivalent normalized forms to the same target id", () => {
    expect(targetChangeHash("Café needs validation\nsoon")).toBe(
      targetChangeHash(" Cafe\u0301\tneeds   validation\r\nsoon "),
    );
  });

  it("is idempotent and stable for the same input", () => {
    const raw = "  Cafe\u0301\tneeds   validation\r\nsoon  ";
    const once = normalizeChangeText(raw);
    expect(normalizeChangeText(once)).toBe(once);
    expect(normalizeChangeText(raw)).toBe(once);
  });
});

describe("targetChangeHash", () => {
  it("pins the versioned hash vector for normalized target text", () => {
    expect(
      targetChangeHash("  Cafe\u0301\tneeds   validation  \r\n\tsoon  "),
    ).toBe("67878e7e55c62c4058d6659707e8cb09050440c1de324718a346a64b7c82e53d");
  });

  it("separates the hash version from normalized text", () => {
    const normalized = normalizeChangeText("add validation");
    const current = sha256Hex(`${TARGET_CHANGE_HASH_VERSION}\0${normalized}`);
    const next = sha256Hex(`refute-target-change:v2\0${normalized}`);

    expect(targetChangeHash("add validation")).toBe(current);
    expect(current).not.toBe(next);
  });
});

describe("verifyRefuteBinding", () => {
  const activeRequiredChanges = [
    { idx: 2, change_text: "different target" },
    { idx: 0, change_text: "add validation" },
  ];

  it("binds a declared target hash to an active required change", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: {
          target_change_hash: targetChangeHash(" add   validation "),
        },
        activeRequiredChanges,
      }),
    ).toMatchObject({
      bound: true,
      boundToIdx: 0,
      targetChangeHash: targetChangeHash("add validation"),
    });
  });

  it("binds target text by harness-computed hash", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: { target_change_text: "different\ttarget" },
        activeRequiredChanges,
      }),
    ).toMatchObject({
      bound: true,
      boundToIdx: 2,
      targetChangeHash: targetChangeHash("different target"),
    });
  });

  it("rejects a target text whose declared hash disagrees", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: {
          target_change_text: "add validation",
          target_change_hash: targetChangeHash("different target"),
        },
        activeRequiredChanges,
      }),
    ).toMatchObject({
      bound: false,
      reason: "hash_mismatch",
      targetChangeHash: targetChangeHash("add validation"),
      declaredTargetChangeHash: targetChangeHash("different target"),
      computedTargetChangeHash: targetChangeHash("add validation"),
    });
  });

  it("rejects a hash that is not present in active required changes", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: { target_change_hash: targetChangeHash("unknown") },
        activeRequiredChanges,
      }),
    ).toMatchObject({
      bound: false,
      reason: "unknown_target",
      targetChangeHash: targetChangeHash("unknown"),
    });
  });

  it("rejects votes with no target hash or target text", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: {},
        activeRequiredChanges,
      }),
    ).toEqual({
      bound: false,
      reason: "missing_target",
      targetChangeHash: null,
    });
  });

  it("uses the lowest idx when duplicate active changes share a hash", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: { target_change_hash: targetChangeHash("same target") },
        activeRequiredChanges: [
          { idx: 5, change_text: "same target" },
          { idx: 3, change_text: " same   target " },
        ],
      }),
    ).toMatchObject({
      bound: true,
      boundToIdx: 3,
    });
  });
});

describe("verifyAndRecordRefuteBinding", () => {
  const activeRequiredChanges = [
    { idx: 0, change_text: "add validation" },
    { idx: 2, change_text: "different target" },
  ];

  function recordInput(
    overrides: Partial<Parameters<typeof verifyAndRecordRefuteBinding>[0]> = {},
  ): Parameters<typeof verifyAndRecordRefuteBinding>[0] {
    const db = migratedDb();
    return {
      repository: new ReviewRefuteVotesRepository(db),
      activeRequiredChanges,
      refuteVote: { target_change_text: "add validation" },
      runId: "run-1",
      reviewerId: "reviewer-a",
      refuteVerdict: "uphold",
      confidence: 0.75,
      reasoning: "looks sound",
      model: "gpt-test",
      promptSha256: "prompt-a",
      sourceYaml: "verdict: uphold\n",
      sourceSha256: "source-a",
      createdAt: NOW,
      ...overrides,
    };
  }

  it("records a passed row when binding succeeds", () => {
    const repository = new ReviewRefuteVotesRepository(migratedDb());
    const input = recordInput({ repository });
    const result = verifyAndRecordRefuteBinding(input);
    const rows = repository.listByRun("run-1");

    expect(result.binding).toMatchObject({
      bound: true,
      boundToIdx: 0,
      targetChangeHash: targetChangeHash("add validation"),
    });
    expect(result.inserted).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      validationStatus: "passed",
      rejectReason: null,
      targetChangeHash: targetChangeHash("add validation"),
      targetChangeIdx: 0,
      refuteVerdict: "uphold",
    });
  });

  it("records a rejected row with the recomputed hash on hash mismatch", () => {
    const input = recordInput({
      refuteVote: {
        target_change_text: "add validation",
        target_change_hash: targetChangeHash("different target"),
      },
      sourceSha256: "source-hash-mismatch",
    });
    const result = verifyAndRecordRefuteBinding(input);

    expect(result.binding).toMatchObject({
      bound: false,
      reason: "hash_mismatch",
      computedTargetChangeHash: targetChangeHash("add validation"),
    });
    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "hash_mismatch",
      targetChangeHash: targetChangeHash("add validation"),
      targetChangeIdx: null,
    });
  });

  it("records a rejected row with the recomputed hash on unknown target text", () => {
    const input = recordInput({
      refuteVote: { target_change_text: "unknown target" },
      sourceSha256: "source-unknown-target",
    });
    const result = verifyAndRecordRefuteBinding(input);

    expect(result.binding).toMatchObject({
      bound: false,
      reason: "unknown_target",
      computedTargetChangeHash: targetChangeHash("unknown target"),
    });
    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "unknown_target",
      targetChangeHash: targetChangeHash("unknown target"),
    });
  });

  it("records a rejected row with the declared hash when unknown target has no text", () => {
    const unknownHash = targetChangeHash("unknown declared target");
    const input = recordInput({
      refuteVote: { target_change_hash: unknownHash },
      sourceSha256: "source-unknown-hash",
    });
    const result = verifyAndRecordRefuteBinding(input);

    expect(result.binding).toMatchObject({
      bound: false,
      reason: "unknown_target",
      targetChangeHash: unknownHash,
      declaredTargetChangeHash: unknownHash,
    });
    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "unknown_target",
      targetChangeHash: unknownHash,
    });
  });

  it("records a rejected row with a sentinel hash when target is missing", () => {
    const input = recordInput({
      refuteVote: {},
      sourceSha256: "source-missing-target",
    });
    const result = verifyAndRecordRefuteBinding(input);

    expect(result.binding).toEqual({
      bound: false,
      reason: "missing_target",
      targetChangeHash: null,
    });
    expect(result.row).toMatchObject({
      validationStatus: "rejected",
      rejectReason: "missing_target",
      targetChangeHash: TARGET_CHANGE_HASH_MISSING_SENTINEL,
    });
  });

  it("keeps rejected attempts append-only and allows a later passed retry", () => {
    const db = migratedDb();
    const repository = new ReviewRefuteVotesRepository(db);
    const base = recordInput({ repository });

    verifyAndRecordRefuteBinding({
      ...base,
      refuteVote: {
        target_change_text: "add validation",
        target_change_hash: targetChangeHash("different target"),
      },
      sourceSha256: "reject-a",
    });
    verifyAndRecordRefuteBinding({
      ...base,
      refuteVote: {
        target_change_text: "add validation",
        target_change_hash: targetChangeHash("different target"),
      },
      sourceSha256: "reject-b",
    });
    verifyAndRecordRefuteBinding({
      ...base,
      refuteVote: { target_change_text: "add validation" },
      sourceSha256: "pass-a",
    });

    expect(
      repository.listByRun("run-1").map((row) => row.validationStatus),
    ).toEqual(["rejected", "rejected", "passed"]);
    expect(
      repository.listByRun("run-1").map((row) => row.sourceSha256),
    ).toEqual(["reject-a", "reject-b", "pass-a"]);
  });
});
