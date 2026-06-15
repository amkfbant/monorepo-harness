import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { runAllowedCommands } from "../../../src/core/command-runner.js";
import type { ResolvedCommand } from "../../../src/policy/schema.js";
import { COMMAND_LOG_LINE_WITHHELD } from "../../../src/reporter/secret-scan.js";
import { makeTmpDir } from "../../helpers/tmp.js";

function shellCmd(id: string, raw: string): ResolvedCommand {
  return { id, cmd: raw, args: [], shell: true };
}

function argvCmd(id: string, cmd: string, args: string[]): ResolvedCommand {
  return { id, cmd, args, shell: false };
}

describe("runAllowedCommands", () => {
  it("returns allPassed=true and empty results when commands list is empty", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [],
      logDir,
    });
    expect(r.allPassed).toBe(true);
    expect(r.results).toEqual([]);
  });

  it("runs a single successful command and captures stdout/stderr to log files", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("cmd-0", "echo hello")],
      logDir,
    });
    expect(r.allPassed).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.id).toBe("cmd-0");
    expect(r.results[0]?.exitCode).toBe(0);
    expect(r.results[0]?.timedOut).toBe(false);
    expect(existsSync(r.results[0]!.stdoutPath)).toBe(true);
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8")).toMatch(/hello/);
    expect(r.results[0]!.stdoutPath).toMatch(/cmd-0\.out\.log$/);
  });

  it("flags failure when a command returns non-zero", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("cmd-0", "false")],
      logDir,
    });
    expect(r.allPassed).toBe(false);
    expect(r.results[0]?.exitCode).not.toBe(0);
  });

  it("runs each command independently and reports per-command status", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        shellCmd("ok-1", "true"),
        shellCmd("fail-1", "false"),
        shellCmd("ok-2", "echo ok"),
      ],
      logDir,
    });
    expect(r.results).toHaveLength(3);
    expect(r.results[0]?.exitCode).toBe(0);
    expect(r.results[1]?.exitCode).not.toBe(0);
    expect(r.results[2]?.exitCode).toBe(0);
    expect(r.allPassed).toBe(false);
  });

  it("times out a long-running command via SIGKILL and marks timedOut=true", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("slow", "sleep 30")],
      logDir,
      timeoutMs: 250,
    });
    expect(r.allPassed).toBe(false);
    expect(r.results[0]?.timedOut).toBe(true);
  });

  it("runs in the worktree directory (cwd respected)", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("pwd-check", "pwd")],
      logDir,
    });
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8").trim()).toContain(
      wt.replace(/^\/private/, ""),
    );
  });

  it("filters env to the safe allowlist (no inherited OPENAI_API_KEY etc.)", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        shellCmd("env-check", "sh -c 'echo OPENAI=${OPENAI_API_KEY:-unset}'"),
      ],
      logDir,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8")).toMatch(
      /OPENAI=unset/,
    );
  });

  it("structured (argv) form spawns directly with no shell interpretation", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [argvCmd("echo-literal", "echo", ["$HOME"])],
      logDir,
    });
    expect(r.results[0]?.exitCode).toBe(0);
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8").trim()).toBe(
      "$HOME",
    );
  });

  it("per-command timeoutMs overrides the default", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        { id: "tight", cmd: "sleep 5", args: [], shell: true, timeoutMs: 250 },
      ],
      logDir,
      timeoutMs: 30_000,
    });
    expect(r.results[0]?.timedOut).toBe(true);
  });

  it("per-command env merges on top of the base env", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        {
          id: "env-merge",
          cmd: "sh -c 'echo $CUSTOM_VAR'",
          args: [],
          shell: true,
          env: { CUSTOM_VAR: "merged-ok" },
        },
      ],
      logDir,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8").trim()).toBe(
      "merged-ok",
    );
  });
});

describe("runAllowedCommands — on-disk log redaction (#186)", () => {
  it("withholds a secret-shaped stdout line on disk", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const token = `ghp_${"a".repeat(36)}`;
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("sec", `echo "token=${token}"`)],
      logDir,
    });
    const out = readFileSync(r.results[0]!.stdoutPath, "utf8");
    expect(out).not.toContain(token);
    expect(out).toContain(COMMAND_LOG_LINE_WITHHELD);
  });

  it("preserves benign lines and withholds only the secret line", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const token = `sk-${"b".repeat(40)}`;
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        shellCmd(
          "mixed",
          [
            "printf 'build started\\n'",
            `printf 'OPENAI_API_KEY=${token}\\n'`,
            "printf 'build finished\\n'",
          ].join("; "),
        ),
      ],
      logDir,
    });
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8")).toBe(
      ["build started", COMMAND_LOG_LINE_WITHHELD, "build finished", ""].join(
        "\n",
      ),
    );
  });

  it("withholds a secret split across stream-chunk boundaries", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const head = `ghp_${"c".repeat(12)}`;
    const tail = "d".repeat(24);
    const token = `${head}${tail}`;
    // one logical line (no newline) emitted in two writes 25ms apart
    const script = [
      `process.stdout.write("prefix token=${head}");`,
      `setTimeout(() => process.stdout.write("${tail} suffix"), 25);`,
    ].join("");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [argvCmd("split", process.execPath, ["-e", script])],
      logDir,
    });
    const out = readFileSync(r.results[0]!.stdoutPath, "utf8");
    expect(out).not.toContain(token);
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain(tail);
    expect(out).toBe(COMMAND_LOG_LINE_WITHHELD);
  });

  it("withholds EVERY line of a multi-line PEM block on disk (P1)", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const body1 = "MIIEpAIBAAKCAQEArealkeymaterialbase64line1";
    const body2 = "secondbase64bodylineWithNoTokenShapeAtAll";
    const script = [
      "printf 'starting\\n';",
      "printf -- '-----BEGIN RSA PRIVATE KEY-----\\n';",
      `printf '${body1}\\n';`,
      `printf '${body2}\\n';`,
      "printf -- '-----END RSA PRIVATE KEY-----\\n';",
      "printf 'done\\n';",
    ].join("");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("pem", script)],
      logDir,
    });
    const out = readFileSync(r.results[0]!.stdoutPath, "utf8");
    // the key body lines must NOT survive (they match no token pattern alone)
    expect(out).not.toContain(body1);
    expect(out).not.toContain(body2);
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).not.toContain("END RSA PRIVATE KEY");
    expect(out).toBe(
      [
        "starting",
        COMMAND_LOG_LINE_WITHHELD,
        COMMAND_LOG_LINE_WITHHELD,
        COMMAND_LOG_LINE_WITHHELD,
        COMMAND_LOG_LINE_WITHHELD,
        "done",
        "",
      ].join("\n"),
    );
  });

  it("no leak: a huge newline-less line carrying a secret is withheld wholesale (P2)", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const token = `AKIA${"Z".repeat(16)}`;
    // a single ~2 MiB line (no newline) carrying a secret — must not leak.
    const script =
      `process.stdout.write("lead token=${token}" + "A".repeat(2*1024*1024));`;
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [argvCmd("huge", process.execPath, ["-e", script])],
      logDir,
    });
    const out = readFileSync(r.results[0]!.stdoutPath, "utf8");
    expect(out).not.toContain(token);
    expect(out).toContain(COMMAND_LOG_LINE_WITHHELD);
    expect(out.length).toBeLessThan(10_000);
  });

  it("bounds memory: a BENIGN over-cap newline-less line is withheld, not written verbatim (P2)", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    // NO secret token — only the cap can collapse this. With an unbounded buffer
    // the whole ~2 MiB would be written verbatim; this test fails in that case.
    const script = `process.stdout.write("Z".repeat(2*1024*1024));`;
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [argvCmd("huge-benign", process.execPath, ["-e", script])],
      logDir,
    });
    const out = readFileSync(r.results[0]!.stdoutPath, "utf8");
    expect(out).toContain(COMMAND_LOG_LINE_WITHHELD);
    expect(out).not.toMatch(/Z{1000}/); // no long run survived
    expect(out.length).toBeLessThan(10_000);
  });

  it("P1: a PEM BEGIN hidden inside an over-cap line still opens the block (body withheld)", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const body1 = "MIIByyKeyMaterialBase64BodyLineOne";
    const body2 = "secondKeyBodyLineNoTokenShapeAtAll";
    // first line = 1 MiB+ padding THEN the BEGIN marker (no newline until after
    // it), so the dropping path must still observe the marker and open the block.
    const script = [
      `process.stdout.write("Z".repeat(1024*1024+50)+"-----BEGIN RSA PRIVATE KEY-----\\n");`,
      `process.stdout.write("${body1}\\n${body2}\\n-----END RSA PRIVATE KEY-----\\nafter\\n");`,
    ].join("");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [argvCmd("huge-pem", process.execPath, ["-e", script])],
      logDir,
    });
    const out = readFileSync(r.results[0]!.stdoutPath, "utf8");
    expect(out).not.toContain(body1);
    expect(out).not.toContain(body2);
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).not.toContain("END RSA PRIVATE KEY");
    expect(out).toContain("after");
    expect(out.length).toBeLessThan(10_000);
  });

  it("resync: after an over-cap line, the next secret line is still redacted", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const token = `ghp_${"e".repeat(36)}`;
    const script = [
      `process.stdout.write("Z".repeat(2*1024*1024)+"\\n");`,
      `process.stdout.write("token=${token}\\nplain tail\\n");`,
    ].join("");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [argvCmd("resync", process.execPath, ["-e", script])],
      logDir,
    });
    const out = readFileSync(r.results[0]!.stdoutPath, "utf8");
    expect(out).not.toContain(token);
    expect(out).toContain("plain tail");
    expect(out.length).toBeLessThan(10_000);
  });

  it("PEM with no END marker stays withheld to EOF (fail-closed)", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const body = "openEndedKeyBodyBase64NoTokenShape";
    const script = [
      "printf 'lead\\n';",
      "printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\\n';",
      `printf '${body}\\n';`,
      `printf '${body}-2\\n';`, // EOF without an END marker
    ].join("");
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("pem-noend", script)],
      logDir,
    });
    const out = readFileSync(r.results[0]!.stdoutPath, "utf8");
    expect(out).not.toContain(body);
    expect(out).toContain("lead");
  });

  it("redacts secret-shaped lines on STDERR too", async () => {
    const wt = makeTmpDir("harness-cmd-");
    const logDir = makeTmpDir("harness-cmd-log-");
    const token = `sk-${"f".repeat(40)}`;
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("stderr-sec", `printf 'OPENAI_API_KEY=${token}\\n' 1>&2`)],
      logDir,
    });
    const err = readFileSync(r.results[0]!.stderrPath, "utf8");
    expect(err).not.toContain(token);
    expect(err).toContain(COMMAND_LOG_LINE_WITHHELD);
  });
});
