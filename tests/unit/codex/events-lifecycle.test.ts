import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishRedactedCodexEvents } from "../../../src/codex/events-lifecycle.js";

function fixture(): {
  dir: string;
  rawPath: string;
  tmpPath: string;
  officialPath: string;
  secret: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-events-life-"));
  const rawPath = join(dir, ".codex-events.raw.jsonl");
  const tmpPath = join(dir, ".codex-events.redacted.tmp");
  const officialPath = join(dir, "codex-events.jsonl");
  const secret = "AKIAABCDEFGHIJKLMNOP";
  writeFileSync(
    rawPath,
    `${JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        aggregated_output: `leaked ${secret}\n`,
      },
    })}\n`,
  );
  return { dir, rawPath, tmpPath, officialPath, secret };
}

describe("publishRedactedCodexEvents", () => {
  it("keeps raw bytes out of the official artifact when tmp write fails", async () => {
    const f = fixture();
    const result = await publishRedactedCodexEvents({
      runId: "run-test",
      rawPath: f.rawPath,
      tmpPath: f.tmpPath,
      officialPath: f.officialPath,
      io: {
        async writeFile(path, content) {
          if (path === f.tmpPath) throw new Error("tmp denied");
          writeFileSync(path, content);
        },
      },
    });

    expect(result.failed).toBe(true);
    const official = readFileSync(f.officialPath, "utf8");
    expect(official).toBe(
      `${JSON.stringify({ type: "redaction.failed", reason: "write_failed" })}\n`,
    );
    expect(official).not.toContain(f.secret);
  });

  it("leaves the official artifact absent when sentinel write also fails", async () => {
    const f = fixture();
    const result = await publishRedactedCodexEvents({
      runId: "run-test",
      rawPath: f.rawPath,
      tmpPath: f.tmpPath,
      officialPath: f.officialPath,
      io: {
        async writeFile(): Promise<void> {
          throw new Error("write denied");
        },
      },
    });

    expect(result.failed).toBe(true);
    expect(existsSync(f.officialPath)).toBe(false);
  });

  it("warns when fail-closed cleanup of raw and tmp files fails", async () => {
    const f = fixture();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let warnings = "";
    try {
      await publishRedactedCodexEvents({
        runId: "run-test",
        rawPath: f.rawPath,
        tmpPath: f.tmpPath,
        officialPath: f.officialPath,
        io: {
          async writeFile(path, content) {
            if (path === f.tmpPath) throw new Error("tmp denied");
            writeFileSync(path, content);
          },
          async rm(): Promise<void> {
            throw new Error("rm denied");
          },
        },
      });
      warnings = stderr.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      stderr.mockRestore();
    }

    expect(warnings).toContain("warning: run run-test:");
    expect(warnings).toContain("could not remove quarantined codex events");
    expect(warnings).toContain(".codex-events.raw.jsonl");
    expect(warnings).toContain(".codex-events.redacted.tmp");
    const official = readFileSync(f.officialPath, "utf8");
    expect(official).not.toContain(f.secret);
  });
});
