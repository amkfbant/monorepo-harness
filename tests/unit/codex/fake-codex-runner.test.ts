import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCodexRunner } from "../../../src/codex/fake-codex-runner.js";

describe("fakeCodexRunner", () => {
  it("invokes the configured editor on the worktree and returns success", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-fake-"));
    mkdirSync(join(wt, "apps/user"), { recursive: true });
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, "apps/user/profile.ts"), "ok", { flag: "w" });
      },
      stdout: "fake done\n",
    });

    const r = await runner.run({
      worktreePath: wt,
      prompt: "ignored",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(wt, "apps/user/profile.ts"))).toBe(true);
    expect(readFileSync(join(wt, "out.log"), "utf8")).toContain("fake done");
  });

  it("forwards an exit code when the fake fails", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-fake-"));
    const runner = createFakeCodexRunner({
      edit: async () => {
        throw new Error("boom");
      },
      stderr: "boom\n",
      exitCode: 17,
    });
    const r = await runner.run({
      worktreePath: wt,
      prompt: "",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
      },
    });
    expect(r.exitCode).toBe(17);
  });
});
