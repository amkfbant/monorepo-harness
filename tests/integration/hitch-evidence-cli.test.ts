/**
 * CLI tests for `hitch evidence add/list/show` (#91 Stage A).
 *
 * TDD: written BEFORE the implementation. All tests should fail (RED) until
 * `src/cli/hitch/evidence-commands.ts` is implemented and registered.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { HitchRepository } from "../../src/hitch/repository.js";

const CLI = join(process.cwd(), "src/cli/run.ts");
// A GHP-shaped token — secret-scanner will flag this as a secret.
const SECRET = "ghp_0123456789abcdefghijklmnopqrstuvwx";
// Resolve tsx to an ABSOLUTE path so `--import` works even when the spawned CLI
// runs with a different cwd.
const TSX = createRequire(import.meta.url).resolve("tsx");

function runCli(
  root: string,
  args: string[],
): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", TSX, CLI, ...args], {
      env: {
        ...process.env,
        HARNESS_ROOT: root,
        HARNESS_SUPPRESS_EXPORT_MODE_WARNING: "1",
      },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

function seed(root: string): string {
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    repo.createSession({
      hitchId: "h-ev-1",
      title: "Evidence test hitch",
      scope: {},
      closeConditions: [],
      createdBy: "t",
      createdSource: "cli",
    });
  } finally {
    db.close();
  }
  return root;
}

function setup(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-hitch-ev-cli-"));
  seed(root);
  return { root };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

describe("hitch evidence add", () => {
  it("persists a note-type evidence and returns evidence_id in text output", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "manual check passed",
      "--output",
      "all green",
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/evidence=/);
    expect(out).toMatch(/attester=operator/);
    expect(out).toMatch(/kind=note/);
  });

  it("--json output contains evidenceId, hitchId, attester=operator, kind", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "json test",
      "--output",
      "payload",
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as Record<string, unknown>;
    expect(typeof data.evidenceId).toBe("string");
    expect((data.evidenceId as string).startsWith("ev-")).toBe(true);
    expect(data.hitchId).toBe("h-ev-1");
    expect(data.attester).toBe("operator");
    expect(data.kind).toBe("note");
  });

  it("parses --metric k=v pairs into summaryMetrics object", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "metrics test",
      "--metric",
      "coverage=92",
      "--metric",
      "passing=1234",
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as Record<string, unknown>;
    expect(data.summaryMetrics).toMatchObject({ coverage: "92", passing: "1234" });
    expect(data.kind).toBe("metrics");
  });

  it("exits non-zero with a malformed --metric (no '=')", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "bad metric",
      "--command",
      "c",
      "--metric",
      "no-equals",
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/--metric must be in k=v format/);
  });

  it("does not echo a secret-shaped token in a malformed --metric error", () => {
    const { root } = setup();
    // malformed (empty value) AND the key is a secret-shaped token — the parser
    // error must NOT echo the raw entry, mirroring the writer's leak-free reject.
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "secret metric",
      "--metric",
      `${SECRET}=`,
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/--metric must be in k=v format/);
    expect(out).not.toContain(SECRET);
  });

  it("exits non-zero with an empty --metric value (k=)", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "empty metric value",
      "--command",
      "c",
      "--metric",
      "coverage=",
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/--metric must be in k=v format/);
  });

  it("exits non-zero when both --output and --output-file are given", () => {
    const { root } = setup();
    const outFile = join(root, "mutex-output.txt");
    writeFileSync(outFile, "from file");
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "mutual exclusion",
      "--output",
      "inline output",
      "--output-file",
      outFile,
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/mutually exclusive/);
  });

  it("reads --output-file content and passes it as output", () => {
    const { root } = setup();
    const outFile = join(root, "output.txt");
    writeFileSync(outFile, "command output text");
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "file output",
      "--command",
      "npm test",
      "--output-file",
      outFile,
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as Record<string, unknown>;
    expect(data.outputExcerpt).toBe("command output text");
  });

  it("redacts --output-file content that contains a secret", () => {
    const { root } = setup();
    const secretFile = join(root, "secret-output.txt");
    writeFileSync(secretFile, `token=${SECRET}`);
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "secret output",
      "--output-file",
      secretFile,
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as Record<string, unknown>;
    expect(data.redacted).toBe(true);
    expect(data.secretSuspect).toBe(true);
    expect(data.outputExcerpt).toBe("[redacted]");
    // the raw secret must not appear anywhere in the output
    expect(out).not.toContain(SECRET);
  });

  it("exits non-zero when no payload fields are supplied", () => {
    const { root } = setup();
    const { code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "empty payload",
    ]);
    expect(code).not.toBe(0);
  });

  it("accepts --command and stores it (kind inferred as command)", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "typecheck before/after",
      "--command",
      "npm run typecheck",
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as Record<string, unknown>;
    expect(data.kind).toBe("command");
    expect(data.command).toBe("npm run typecheck");
  });

  it("exits non-zero for an unknown hitch id", () => {
    const { root } = setup();
    const { code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "no-such-hitch",
      "--label",
      "x",
      "--output",
      "y",
    ]);
    expect(code).not.toBe(0);
  });

  it("does NOT expose --status or --attester options on evidence add", () => {
    const { root } = setup();
    // `--help` lists all options; neither --status nor --attester should appear.
    const helpResult = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "--help",
    ]);
    // help exits 0 (commander default)
    expect(helpResult.out).not.toMatch(/--status\b/);
    expect(helpResult.out).not.toMatch(/--attester\b/);
  });

  // ── F1 (REJECT): before/after/note inputs were accepted but their content was
  // silently dropped (no storage column). Stage A removes the flags entirely
  // rather than accept-and-drop. Free-text bodies go via --output.
  it("does NOT expose --before / --after / --note options on evidence add", () => {
    const { root } = setup();
    const helpResult = runCli(root, ["hitch", "evidence", "add", "--help"]);
    expect(helpResult.out).not.toMatch(/--before\b/);
    expect(helpResult.out).not.toMatch(/--after\b/);
    expect(helpResult.out).not.toMatch(/--note\b/);
  });

  it("rejects an unknown --note flag with a non-zero exit", () => {
    const { root } = setup();
    const { code } = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "x",
      "--note",
      "y",
    ]);
    // commander reports unknown option → non-zero exit (not a silent accept).
    expect(code).not.toBe(0);
  });
});

describe("hitch evidence list", () => {
  it("returns empty output when no evidence exists", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "list",
      "h-ev-1",
    ]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });

  it("lists evidence after add (round-trip)", () => {
    const { root } = setup();
    runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "round-trip label",
      "--output",
      "body text",
    ]);
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "list",
      "h-ev-1",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("round-trip label");
    expect(out).toContain("operator");
  });

  it("--json returns { evidence: [...] } array", () => {
    const { root } = setup();
    runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "json list",
      "--output",
      "n",
    ]);
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "list",
      "h-ev-1",
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as { evidence: unknown[] };
    expect(Array.isArray(data.evidence)).toBe(true);
    expect(data.evidence.length).toBeGreaterThan(0);
    const first = data.evidence[0] as Record<string, unknown>;
    expect(first.attester).toBe("operator");
  });

  it("exits non-zero for an unknown hitch id", () => {
    const { root } = setup();
    const { code } = runCli(root, [
      "hitch",
      "evidence",
      "list",
      "no-such-hitch",
    ]);
    expect(code).not.toBe(0);
  });
});

describe("hitch evidence show", () => {
  it("shows a created evidence by evidence_id (round-trip through add)", () => {
    const { root } = setup();
    const addResult = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "show test",
      "--output",
      "detail",
      "--json",
    ]);
    expect(addResult.code).toBe(0);
    const addData = JSON.parse(addResult.out) as { evidenceId: string };
    const evId = addData.evidenceId;

    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "show",
      evId,
    ]);
    expect(code).toBe(0);
    expect(out).toContain(evId.slice(0, 8));
    expect(out).toContain("show test");
    expect(out).toContain("operator");
  });

  it("--json returns the full evidence object", () => {
    const { root } = setup();
    const addResult = runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "show json",
      "--output",
      "n",
      "--json",
    ]);
    const addData = JSON.parse(addResult.out) as { evidenceId: string };
    const evId = addData.evidenceId;

    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "show",
      evId,
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as Record<string, unknown>;
    expect(data.evidenceId).toBe(evId);
    expect(data.attester).toBe("operator");
  });

  it("exits non-zero with a clear message for an unknown evidence id", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "evidence",
      "show",
      "ev-00000000-0000-0000-0000-000000000000",
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/not found/i);
  });
});

// ── #91 Stage A Task 5: hitch status surfaces evidence ───────────────────────

describe("hitch status surfaces attached evidence (#91 Stage A Task 5)", () => {
  it("--json output includes empty evidence array when no evidence attached", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "hitch",
      "status",
      "h-ev-1",
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as { evidence: unknown[] };
    expect(Array.isArray(data.evidence)).toBe(true);
    expect(data.evidence).toHaveLength(0);
  });

  it("human text renders NO evidence section when no evidence is attached", () => {
    const { root } = setup();
    const { out, code } = runCli(root, ["hitch", "status", "h-ev-1"]);
    expect(code).toBe(0);
    // The output must be a single line (no evidence rows appended).
    // Evidence rows start with a tab-separated timestamp field.
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("--json includes attached evidence rows in the evidence array", () => {
    const { root } = setup();
    // attach evidence first
    runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "status test label",
      "--output",
      "status test body",
    ]);
    const { out, code } = runCli(root, [
      "hitch",
      "status",
      "h-ev-1",
      "--json",
    ]);
    expect(code).toBe(0);
    const data = JSON.parse(out) as {
      evidence: Array<{
        evidenceId: string;
        kind: string;
        attester: string;
        label: string;
      }>;
    };
    expect(data.evidence).toHaveLength(1);
    expect(data.evidence[0].kind).toBe("note");
    expect(data.evidence[0].attester).toBe("operator");
    expect(data.evidence[0].label).toBe("status test label");
  });

  it("human text renders an evidence line for each attached row (≥1)", () => {
    const { root } = setup();
    runCli(root, [
      "hitch",
      "evidence",
      "add",
      "h-ev-1",
      "--label",
      "visible in status",
      "--output",
      "body",
    ]);
    const { out, code } = runCli(root, ["hitch", "status", "h-ev-1"]);
    expect(code).toBe(0);
    expect(out).toContain("visible in status");
    expect(out).toContain("note");
    expect(out).toContain("operator");
  });
});
