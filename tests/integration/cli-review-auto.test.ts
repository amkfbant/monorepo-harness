import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  storeArtifactBlob,
  readArtifactBlob,
} from "../../src/db/artifact-blobs.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setupRun(decision = "pending"): { root: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-rauto-cli-"));
  const runId = "run-20260521-apps-user-rauto01";
  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        runId,
        repoId: "t",
        repoPath: "/tmp/t",
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "abc",
        runBranch: "harness/x",
        status: "needs_review",
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
  writeFileSync(join(runDir, "summary.md"), "# summary\nsome content\n");
  const nonPending = decision !== "pending";
  writeFileSync(
    join(runDir, "review-decision.yaml"),
    [
      `runId: ${runId}`,
      "domain: apps/user",
      `decision: ${decision}`,
      decision === "changes_requested"
        ? 'required_changes:\n  - "fix it"'
        : "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      `reviewer: ${nonPending ? "knkn" : "null"}`,
      `reviewed_at: ${nonPending ? "2026-05-21T00:00:00Z" : "null"}`,
      "",
    ].join("\n"),
  );
  return { root, runId };
}

function setupDbFirstRun(): { root: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-rauto-cli-dbf-"));
  const runId = "run-20260521-apps-user-rautodb1";
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    const meta = {
      runId,
      repoId: "t",
      repoPath: "/tmp/t",
      domain: "apps/user",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: "harness/x",
      status: "needs_review",
      safetyStatus: "allowed",
      startedAt: "2026-05-21T00:00:00Z",
    };
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at,
         meta_json)
       VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
         'db-first', 2, 'disabled', '2026-05-21T00:00:00Z', ?)`,
    ).run(runId, JSON.stringify(meta));
    const summary = storeArtifactBlob(db, Buffer.from("# summary\nclean\n"));
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
         content_type, bytes, sha256, storage, blob_sha256, body_status)
       VALUES (?, ?, 'summary', 'summary.md', 'text/markdown', ?, ?, 'db',
         ?, 'db_available')`,
    ).run(
      `${runId}:summary.md`,
      runId,
      summary.bytes,
      summary.sha256,
      summary.sha256,
    );
  } finally {
    db.close();
  }
  return { root, runId };
}

/**
 * A fake codex binary. The codex-cli-runner filters child env to a small
 * allowlist, so we can't pass the desired output via an env var — instead
 * the bin cats a fixed file. Each test writes that file before running.
 */
interface FakeCodex {
  bin: string;
  outputFile: string;
}

function writeFakeCodexBin(): FakeCodex {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-codex-"));
  const bin = join(dir, "codex");
  const outputFile = join(dir, "output.txt");
  writeFileSync(outputFile, "");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const { readFileSync, writeFileSync } = require('node:fs');",
      "const { resolve } = require('node:path');",
      "const args = process.argv.slice(2);",
      "const outputIndex = args.indexOf('-o');",
      "if (!args.includes('--json')) throw new Error('missing --json');",
      "if (outputIndex < 0) throw new Error('missing -o');",
      "const outputPath = resolve(args[outputIndex + 1]);",
      `const allowedTmpRoot = resolve(${JSON.stringify(tmpdir())});`,
      "if (!outputPath.startsWith(`${allowedTmpRoot}/`)) {",
      "  throw new Error(`output escaped tmp root: ${outputPath}`);",
      "}",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      `  const finalMessage = readFileSync(${JSON.stringify(outputFile)}, 'utf8');`,
      "  writeFileSync(outputPath, finalMessage, 'utf8');",
      "  const event = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };",
      "  process.stdout.write(`${JSON.stringify(event)}\\n`, () => process.exit(0));",
      "});",
    ].join("\n"),
  );
  execFileSync("chmod", ["+x", bin]);
  return { bin, outputFile };
}

function writeTamperingFakeCodexBin(secret: string): FakeCodex {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-codex-tamper-"));
  const bin = join(dir, "codex");
  const outputFile = join(dir, "output.txt");
  writeFileSync(outputFile, "");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const { readFileSync, writeFileSync } = require('node:fs');",
      "const { resolve } = require('node:path');",
      "const args = process.argv.slice(2);",
      "const outputIndex = args.indexOf('-o');",
      "if (!args.includes('--json')) throw new Error('missing --json');",
      "if (outputIndex < 0) throw new Error('missing -o');",
      "const outputPath = resolve(args[outputIndex + 1]);",
      `const finalMessage = readFileSync(${JSON.stringify(
        outputFile,
      )}, 'utf8');`,
      "writeFileSync('summary.md', '# summary\\ntampered\\n', 'utf8');",
      `writeFileSync('reviewer-agent.events.jsonl', ${JSON.stringify(
        `{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"leaked ${secret}\\n"}}\\n`,
      )}, 'utf8');`,
      "writeFileSync(outputPath, finalMessage, 'utf8');",
      "process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\\n`, " +
        "() => process.exit(0));",
    ].join("\n"),
  );
  execFileSync("chmod", ["+x", bin]);
  return { bin, outputFile };
}

function dbBlobText(
  root: string,
  runId: string,
  relativePath: string,
): string | null {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    const row = db
      .prepare(
        `SELECT blob_sha256 FROM artifacts
         WHERE run_id = ? AND relative_path = ?`,
      )
      .get(runId, relativePath) as { blob_sha256: string | null } | undefined;
    if (row?.blob_sha256 === undefined || row.blob_sha256 === null) {
      return null;
    }
    return readArtifactBlob(db, row.blob_sha256)?.toString("utf8") ?? null;
  } finally {
    db.close();
  }
}

function run(
  args: string[],
  harnessRoot: string,
  fakeOutput: string,
  fake: FakeCodex,
): { stdout: string; stderr: string; status: number } {
  writeFileSync(fake.outputFile, fakeOutput);
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    env: {
      ...process.env,
      HARNESS_ROOT: harnessRoot,
      HARNESS_CODEX_BIN: fake.bin,
    },
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

const VALID_YAML = [
  "```yaml",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "```",
].join("\n");

describe("harness review auto", () => {
  const fakeBin = writeFakeCodexBin();

  it("writes review-decision.yaml from valid codex output", () => {
    const { root, runId } = setupRun();
    const { stdout, status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      VALID_YAML,
      fakeBin,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/decision=approved/);
    const yaml = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/decision: approved/);
    expect(yaml).toMatch(/reviewer: codex-reviewer/);
  });

  it("--dry-run does not write review-decision.yaml", () => {
    const { root, runId } = setupRun();
    const before = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    const { stdout, status } = run(
      ["review", "auto", "--run-id", runId, "--dry-run"],
      root,
      VALID_YAML,
      fakeBin,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/NOT written/);
    const after = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("refuses a non-pending decision without --allow-overwrite (exit 1)", () => {
    const { root, runId } = setupRun("approved");
    const { stderr, status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      VALID_YAML,
      fakeBin,
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/--allow-overwrite/);
  });

  it("--allow-overwrite replaces a non-pending decision", () => {
    const { root, runId } = setupRun("changes_requested");
    const { status } = run(
      ["review", "auto", "--run-id", runId, "--allow-overwrite"],
      root,
      VALID_YAML,
      fakeBin,
    );
    expect(status).toBe(0);
    const yaml = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/decision: approved/);
  });

  it("invalid codex output → exit 1, review-auto-error.json written, decision intact", () => {
    const { root, runId } = setupRun();
    const before = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    const { status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      "```yaml\ndecision: maybe\nrequired_changes: []\nnon_blocking_comments: []\nout_of_scope_suggestions: []\n```",
      fakeBin,
    );
    expect(status).toBe(1);
    const errPath = join(root, "runs", runId, "review-auto-error.json");
    expect(existsSync(errPath)).toBe(true);
    const err = JSON.parse(readFileSync(errPath, "utf8"));
    expect(err.type).toBe("review-auto-error");
    const after = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("quarantines reviewer artifacts after tamper before syncing DB blobs", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const { root, runId } = setupDbFirstRun();
    const fake = writeTamperingFakeCodexBin(secret);

    const { stderr, status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      VALID_YAML,
      fake,
    );

    expect(status).toBe(1);
    expect(stderr).toContain("artifacts_quarantined");
    expect(dbBlobText(root, runId, "summary.md")).toBe("# summary\nclean\n");
    expect(dbBlobText(root, runId, "reviewer-agent.events.jsonl")).toBeNull();
    expect(dbBlobText(root, runId, "review-auto-error.json")).not.toBeNull();
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      const leaked = db
        .prepare(
          `SELECT count(*) AS n
             FROM artifact_blob_chunks
            WHERE instr(CAST(content AS TEXT), ?) > 0`,
        )
        .get(secret) as { n: number };
      expect(leaked.n).toBe(0);
      const event = db
        .prepare(
          `SELECT payload_json
             FROM run_events
            WHERE run_id = ? AND type = 'artifacts_quarantined'
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(runId) as { payload_json: string } | undefined;
      expect(event).toBeDefined();
      const payload = JSON.parse(event?.payload_json ?? "{}") as {
        type?: string;
        paths?: string[];
      };
      expect(payload.type).toBe("artifacts_quarantined");
      expect(payload.paths).toContain("reviewer-agent.events.jsonl");
    } finally {
      db.close();
    }
  });

  it("extracts the YAML block even when codex wraps it in prose", () => {
    const { root, runId } = setupRun();
    const prosey = [
      "Here is my review of the run.",
      "",
      "I looked at summary.md and the diff.",
      "",
      VALID_YAML,
      "",
      "Let me know if you need more detail.",
    ].join("\n");
    const { status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      prosey,
      fakeBin,
    );
    expect(status).toBe(0);
    const yaml = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/decision: approved/);
  });
});
