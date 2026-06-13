import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexCliRunner } from "../../../src/codex/codex-cli-runner.js";
import { codexBinaryVersion } from "../../../src/codex/codex-version.js";

const childProcessCalls = vi.hoisted(() => ({
  spawn: [] as string[],
  spawnSync: [] as string[],
}));

interface MockChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  pid: number;
}

vi.mock("node:child_process", () => {
  return {
    spawnSync: (command: string) => {
      childProcessCalls.spawnSync.push(command);
      return {
        error: undefined,
        status: 0,
        stdout: "codex-cli mocked\n",
      };
    },
    spawn: (command: string) => {
      childProcessCalls.spawn.push(command);
      const child = new EventEmitter() as MockChildProcess;
      child.pid = 12345;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          setImmediate(() => {
            child.stdout.end();
            child.stderr.end();
            child.emit("close", 0);
          });
          callback();
        },
      });
      return child;
    },
  };
});

describe("codex binary resolution", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    childProcessCalls.spawn = [];
    childProcessCalls.spawnSync = [];
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("uses the same absolute path for relative runner and version probe bins", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-codex-bin-resolution-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    process.chdir(root);
    const relativeBin = join("tools", "codex");
    const absoluteBin = resolve(process.cwd(), relativeBin);

    expect(codexBinaryVersion(relativeBin)).toBe("codex-cli mocked");
    const runner = createCodexCliRunner({
      codexBin: relativeBin,
      envAllowlist: ["PATH"],
    });
    await runner.run({
      worktreePath: worktree,
      prompt: "hello",
      logPaths: {
        stdout: join(root, "logs", "out.log"),
        stderr: join(root, "logs", "err.log"),
        events: join(root, "logs", "events.jsonl"),
      },
    });

    expect(childProcessCalls.spawnSync).toEqual([absoluteBin]);
    expect(childProcessCalls.spawn).toEqual([absoluteBin]);
  });
});
