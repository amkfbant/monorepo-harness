import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  listReviews,
  formatTable,
  formatJson,
} from "../../../src/core/review-lister.js";
import { makeTmpDir } from "../../helpers/tmp.js";

function writeRun(
  runsDir: string,
  runId: string,
  meta: Record<string, unknown>,
): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

function baseMeta(
  runId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId,
    domain: "apps/catalog",
    status: "needs_review",
    safetyStatus: "allowed",
    startedAt: "2026-05-21T10:00:00Z",
    ...over,
  };
}

describe("listReviews", () => {
  it("returns empty valid+invalid when runsDir does not exist", async () => {
    const r = await listReviews({ runsDir: "/tmp/nope/nowhere/here" });
    expect(r.valid).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  it("default queue = needs_review + changes_requested", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-a-nr", baseMeta("run-20260521-a-nr", {
      status: "needs_review",
    }));
    writeRun(root, "run-20260521-b-cr", baseMeta("run-20260521-b-cr", {
      status: "changes_requested",
      startedAt: "2026-05-21T11:00:00Z",
    }));
    writeRun(root, "run-20260521-c-ap", baseMeta("run-20260521-c-ap", {
      status: "approved",
      startedAt: "2026-05-21T12:00:00Z",
    }));
    writeRun(root, "run-20260521-d-cl", baseMeta("run-20260521-d-cl", {
      status: "cleaned",
      startedAt: "2026-05-21T13:00:00Z",
    }));
    const r = await listReviews({ runsDir: root });
    expect(r.valid.map((e) => e.runId).sort()).toEqual([
      "run-20260521-a-nr",
      "run-20260521-b-cr",
    ]);
  });

  it("--all includes every status", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-a-nr", baseMeta("run-20260521-a-nr"));
    writeRun(root, "run-20260521-d-cl", baseMeta("run-20260521-d-cl", {
      status: "cleaned",
    }));
    const r = await listReviews({ runsDir: root, all: true });
    expect(r.valid).toHaveLength(2);
  });

  it("--status filters to the requested statuses", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-a-nr", baseMeta("run-20260521-a-nr"));
    writeRun(root, "run-20260521-e-fpv", baseMeta("run-20260521-e-fpv", {
      status: "failed-policy-violation",
    }));
    const r = await listReviews({
      runsDir: root,
      statuses: ["failed-policy-violation"],
    });
    expect(r.valid.map((e) => e.runId)).toEqual(["run-20260521-e-fpv"]);
  });

  it("--domain filters to a single domain", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-cat", baseMeta("run-20260521-cat", {
      domain: "apps/catalog",
    }));
    writeRun(root, "run-20260521-ord", baseMeta("run-20260521-ord", {
      domain: "apps/orders",
    }));
    const r = await listReviews({ runsDir: root, domain: "apps/orders" });
    expect(r.valid.map((e) => e.runId)).toEqual(["run-20260521-ord"]);
  });

  it("--limit caps the number of valid rows", async () => {
    const root = makeTmpDir("harness-list-");
    for (let i = 0; i < 5; i++) {
      writeRun(root, `run-20260521-x-${i}`, baseMeta(`run-20260521-x-${i}`, {
        startedAt: `2026-05-21T1${i}:00:00Z`,
      }));
    }
    const r = await listReviews({ runsDir: root, limit: 2 });
    expect(r.valid).toHaveLength(2);
  });

  it("sorts valid entries newest-first by startedAt", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-x-a", baseMeta("run-20260521-x-a", {
      startedAt: "2026-05-21T10:00:00Z",
    }));
    writeRun(root, "run-20260521-x-c", baseMeta("run-20260521-x-c", {
      startedAt: "2026-05-21T15:00:00Z",
    }));
    writeRun(root, "run-20260521-x-b", baseMeta("run-20260521-x-b", {
      startedAt: "2026-05-21T12:00:00Z",
    }));
    const r = await listReviews({ runsDir: root });
    expect(r.valid.map((e) => e.runId)).toEqual([
      "run-20260521-x-c",
      "run-20260521-x-b",
      "run-20260521-x-a",
    ]);
  });

  it("surfaces parentRunId / reviewer / commandSummary", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-rich", baseMeta("run-20260521-rich", {
      status: "changes_requested",
      reviewer: "knkn",
      reviewedAt: "2026-05-21T11:00:00Z",
      parentRunId: "run-20260521-parent",
      commandResults: [
        { command: "npm test", exitCode: 0, durationMs: 1, timedOut: false },
        { command: "npm run lint", exitCode: 1, durationMs: 2, timedOut: false },
      ],
    }));
    const r = await listReviews({ runsDir: root });
    const e = r.valid[0]!;
    expect(e.reviewer).toBe("knkn");
    expect(e.parentRunId).toBe("run-20260521-parent");
    expect(e.commandSummary).toEqual({ ok: 1, total: 2 });
  });

  it("commandSummary is null when the run ran no commands", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-nocmd", baseMeta("run-20260521-nocmd"));
    const r = await listReviews({ runsDir: root });
    expect(r.valid[0]?.commandSummary).toBeNull();
  });

  it("separates unreadable / malformed run dirs into invalid", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-ok", baseMeta("run-20260521-ok"));
    mkdirSync(join(root, "run-20260521-badjson"), { recursive: true });
    writeFileSync(
      join(root, "run-20260521-badjson", "meta.json"),
      "{ not json",
    );
    mkdirSync(join(root, "run-20260521-nometa"), { recursive: true });
    const r = await listReviews({ runsDir: root, all: true });
    expect(r.valid.map((e) => e.runId)).toEqual(["run-20260521-ok"]);
    expect(r.invalid.map((e) => e.runId).sort()).toEqual([
      "run-20260521-badjson",
      "run-20260521-nometa",
    ]);
  });

  it("treats runId / directory-name mismatch as invalid", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-dir", baseMeta("run-20260521-OTHER"));
    const r = await listReviews({ runsDir: root, all: true });
    expect(r.valid).toEqual([]);
    expect(r.invalid[0]?.error).toMatch(/does not match directory/);
  });

  it("ignores directories that don't match the run-id shape", async () => {
    const root = makeTmpDir("harness-list-");
    mkdirSync(join(root, "not-a-run"), { recursive: true });
    mkdirSync(join(root, ".cache"), { recursive: true });
    writeRun(root, "run-20260521-real", baseMeta("run-20260521-real"));
    const r = await listReviews({ runsDir: root, all: true });
    expect(r.valid.map((e) => e.runId)).toEqual(["run-20260521-real"]);
    expect(r.invalid).toEqual([]);
  });

  it("missing counts render as null", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-old", baseMeta("run-20260521-old"));
    const r = await listReviews({ runsDir: root });
    expect(r.valid[0]?.changedFilesCount).toBeNull();
    expect(r.valid[0]?.secretSuspectCount).toBe(null);
  });

  it("routes a run with malformed commandResults to invalid (no crash)", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-badcmd", baseMeta("run-20260521-badcmd", {
      commandResults: [null],
    }));
    const r = await listReviews({ runsDir: root, all: true });
    expect(r.valid).toEqual([]);
    expect(r.invalid[0]?.error).toMatch(/commandResults/);
  });

  it("routes a run with an unknown status to invalid", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-weird", baseMeta("run-20260521-weird", {
      status: "totally-made-up",
    }));
    const r = await listReviews({ runsDir: root, all: true });
    expect(r.valid).toEqual([]);
    expect(r.invalid[0]?.error).toMatch(/unknown status/);
  });

  it("routes a run with a non-string runId to invalid", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-numid", baseMeta("run-20260521-numid", {
      runId: 42,
    }));
    const r = await listReviews({ runsDir: root, all: true });
    expect(r.valid).toEqual([]);
    expect(r.invalid[0]?.error).toMatch(/does not match directory/);
  });

  it("throws RangeError for a non-integer / negative limit", async () => {
    const root = makeTmpDir("harness-list-");
    writeRun(root, "run-20260521-x", baseMeta("run-20260521-x"));
    await expect(
      listReviews({ runsDir: root, limit: -1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      listReviews({ runsDir: root, limit: 1.5 }),
    ).rejects.toThrow(RangeError);
  });
});

describe("formatTable", () => {
  it("returns 'no runs' for empty valid list", () => {
    expect(formatTable({ valid: [], invalid: [] })).toBe("no runs\n");
  });

  it("renders header + a row with the spec columns", () => {
    const out = formatTable({
      valid: [
        {
          runId: "run-X",
          domain: "apps/user",
          status: "needs_review",
          safetyStatus: "allowed",
          reviewer: null,
          reviewedAt: null,
          parentRunId: null,
          commandSummary: { ok: 3, total: 3 },
          changedFilesCount: 2,
          secretSuspectCount: 0,
          ignoredUntrackedCount: 0,
          startedAt: "2026-05-21T10:00:00Z",
          finishedAt: "2026-05-21T10:02:00Z",
        },
      ],
      invalid: [],
    });
    expect(out).toMatch(
      /runId.*domain.*status.*safety.*reviewer.*parent.*commands.*secrets.*ignored.*startedAt/,
    );
    expect(out).toMatch(/run-X/);
    expect(out).toMatch(/3\/3/);
  });
});

describe("formatJson", () => {
  it("emits validRuns / invalidRuns separately and parses back", () => {
    const json = formatJson({
      valid: [
        {
          runId: "run-X",
          domain: "apps/user",
          status: "needs_review",
          safetyStatus: "allowed",
          reviewer: null,
          reviewedAt: null,
          parentRunId: null,
          commandSummary: null,
          changedFilesCount: null,
          secretSuspectCount: 0,
          ignoredUntrackedCount: 0,
          startedAt: "2026-05-21T10:00:00Z",
          finishedAt: null,
        },
      ],
      invalid: [{ runId: "run-bad", error: "meta.json invalid JSON" }],
    });
    const parsed = JSON.parse(json);
    expect(parsed.validRuns).toHaveLength(1);
    expect(parsed.invalidRuns).toHaveLength(1);
    expect(parsed.validRuns[0].runId).toBe("run-X");
    expect(parsed.invalidRuns[0].error).toMatch(/invalid JSON/);
  });
});
