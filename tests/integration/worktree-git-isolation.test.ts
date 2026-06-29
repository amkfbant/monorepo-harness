import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAllowedCommands } from "../../src/core/command-runner.js";
import type { ResolvedCommand } from "../../src/policy/schema.js";
import {
  createCloneWorkspace,
  createWorktree,
} from "../../src/workspace/git-worktree.js";
import { makeTmpDir } from "../helpers/tmp.js";

// (#410 Phase 2 — Task 7) End-to-end structural regression for the #410 trigger:
// an allowed-command running `git config core.bare true` INSIDE the run workspace.
// A `git worktree` shares the target's `.git` (config lives in the common dir),
// so the write hits the SHARED config and flips the *target* to bare — the
// original bug, demonstrated here as a contrast. A clone workspace owns its own
// `.git/config`, so the write stays local and the target is untouched — the fix,
// pinned GREEN. Both cases are driven through `runAllowedCommands` so the real
// command-execution path is exercised, not a hand-rolled `git config`.
//
// All writes use git's LOCAL config (no `--global`) for the core.bare cases, and
// every child runs with an ISOLATED HOME so even a `--global` probe can never
// touch the developer's real ~/.gitconfig.

let bareRemote: string; // GitHub stand-in origin
let source: string; // local target (clone source / worktree parent)
let worktreesDir: string;
let logDir: string;
let isolatedHome: string;
let baseSha: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

function argvCmd(id: string, cmd: string, args: string[]): ResolvedCommand {
  return { id, cmd, args, shell: false };
}

// Children get PATH (to locate `git`) and an isolated HOME so any global git
// write is contained in tmp, never the real ~/.gitconfig.
function isolatedEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: isolatedHome };
}

beforeEach(() => {
  bareRemote = makeTmpDir("harness-bare-");
  source = makeTmpDir("harness-src-");
  worktreesDir = makeTmpDir("harness-wt-");
  logDir = makeTmpDir("harness-cmd-log-");
  isolatedHome = makeTmpDir("harness-home-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bareRemote], {
    stdio: "ignore",
  });
  const r = (args: string[]) =>
    execFileSync("git", args, { cwd: source, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "t@e.com"]);
  r(["config", "user.name", "T"]);
  writeFileSync(join(source, "f.txt"), "x");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);
  r(["remote", "add", "origin", bareRemote]);
  r(["push", "-q", "origin", "main"]);
  baseSha = git(source, ["rev-parse", "HEAD"]);
});

describe("run workspace git isolation under runAllowedCommands (#410)", () => {
  it("clone mode: a close-check `git config core.bare` cannot corrupt the target (#410 fixed; #396 part 1)", async () => {
    // This is also the #396 part (1) regression guard: the close-check runs its
    // commands (e.g. the full `vitest-run`) through this same `runAllowedCommands`
    // path in the run workspace. Under clone isolation, a git write from that
    // command lands in the clone's OWN `.git` and cannot reach the target's
    // shared config — which is what made #396's self-driven close-check corrupt
    // the workspace (a worktree shared the target's `.git`). The worktree-mode
    // contrast below shows the same command flipping the target, pre-isolation.
    const wt = await createCloneWorkspace({
      repoPath: source,
      worktreesDir,
      runId: "run-clone",
      branch: "harness/run-clone/x",
      base: baseSha,
    });
    const { results, allPassed } = await runAllowedCommands({
      worktreePath: wt.path,
      commands: [argvCmd("bare", "git", ["config", "core.bare", "true"])],
      logDir,
      env: isolatedEnv(),
    });
    expect(allPassed).toBe(true);
    expect(results[0]?.exitCode).toBe(0);
    // The write really ran and landed in the CLONE's own config ...
    expect(git(wt.path, ["config", "--local", "core.bare"])).toBe("true");
    // ... but the target's own .git/config is untouched — still non-bare.
    expect(git(source, ["rev-parse", "--is-bare-repository"])).toBe("false");
  });

  it("worktree mode: the SAME command flips the target to bare (#410 trigger, shown for contrast)", async () => {
    const wt = await createWorktree({
      repoPath: source,
      worktreesDir,
      runId: "run-wt",
      branch: "harness/run-wt/x",
      base: "main",
    });
    const { results, allPassed } = await runAllowedCommands({
      worktreePath: wt.path,
      commands: [argvCmd("bare", "git", ["config", "core.bare", "true"])],
      logDir,
      env: isolatedEnv(),
    });
    expect(allPassed).toBe(true);
    expect(results[0]?.exitCode).toBe(0);
    // A worktree shares the target's .git/config, so the write corrupts the
    // TARGET into a bare repo. This is exactly the leak the clone mode prevents.
    expect(git(source, ["rev-parse", "--is-bare-repository"])).toBe("true");
  });

  it("passes the isolated env through to child commands", async () => {
    const wt = await createCloneWorkspace({
      repoPath: source,
      worktreesDir,
      runId: "run-env",
      branch: "harness/run-env/x",
      base: baseSha,
    });
    const probe = "isolated-env-probe-value";
    const { allPassed } = await runAllowedCommands({
      worktreePath: wt.path,
      commands: [
        {
          id: "echo-env",
          cmd: 'printf "%s" "$HARNESS_PROBE" > probe.txt',
          args: [],
          shell: true,
        },
      ],
      logDir,
      env: { ...isolatedEnv(), HARNESS_PROBE: probe },
    });
    expect(allPassed).toBe(true);
    expect(readFileSync(join(wt.path, "probe.txt"), "utf8")).toBe(probe);
  });

  it("a --global git write lands in the isolated HOME, never the real ~/.gitconfig", async () => {
    const wt = await createCloneWorkspace({
      repoPath: source,
      worktreesDir,
      runId: "run-global",
      branch: "harness/run-global/x",
      base: baseSha,
    });
    const probeKey = "harness410.probe";
    const probeVal = "isolated-home-only";
    const realGitconfig = join(homedir(), ".gitconfig");
    const before = existsSync(realGitconfig)
      ? readFileSync(realGitconfig, "utf8")
      : null;

    const { allPassed } = await runAllowedCommands({
      worktreePath: wt.path,
      commands: [
        argvCmd("global", "git", ["config", "--global", probeKey, probeVal]),
      ],
      logDir,
      env: isolatedEnv(),
    });
    expect(allPassed).toBe(true);
    // The --global write went into the ISOLATED HOME ...
    const isolatedGitconfig = join(isolatedHome, ".gitconfig");
    expect(existsSync(isolatedGitconfig)).toBe(true);
    expect(readFileSync(isolatedGitconfig, "utf8")).toContain(probeVal);
    // ... and the developer's real ~/.gitconfig is byte-for-byte unchanged.
    const after = existsSync(realGitconfig)
      ? readFileSync(realGitconfig, "utf8")
      : null;
    expect(after).toBe(before);
  });
});
