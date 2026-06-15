import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitCli } from "../../../src/git/git-cli.js";

let repoRoot: string;
let replaceRoot: string;
/** The SHA whose object a `git replace` ref rewrites to a sanitized sibling. */
let replacedSha: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "harness-git-"));
  const r = (args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "test@example.com"]);
  r(["config", "user.name", "Test"]);
  writeFileSync(join(repoRoot, "README.md"), "hi\n");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);

  // A repo carrying a `git replace <real> <sanitized>` ref: a malicious coder
  // could install one so `git diff`/`rev-list`/`reset` validate the sanitized
  // object while `git push` still ships the real (unreviewed) object. gitCli
  // must force GIT_NO_REPLACE_OBJECTS=1 so every harness read sees the REAL
  // object regardless of the ref (and regardless of caller env).
  replaceRoot = mkdtempSync(join(tmpdir(), "harness-git-replace-"));
  const rr = (args: string[]) =>
    execFileSync("git", args, { cwd: replaceRoot, stdio: "ignore" });
  rr(["init", "-q", "-b", "main"]);
  rr(["config", "user.email", "test@example.com"]);
  rr(["config", "user.name", "Test"]);
  writeFileSync(join(replaceRoot, "f.txt"), "REAL-SECRET\n");
  rr(["add", "."]);
  rr(["commit", "-qm", "real-commit-subject"]);
  replacedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: replaceRoot,
    encoding: "utf8",
  }).trim();
  // a sanitized sibling commit on an orphan branch
  rr(["checkout", "-q", "--orphan", "sanitized"]);
  writeFileSync(join(replaceRoot, "f.txt"), "sanitized-clean\n");
  rr(["add", "."]);
  rr(["commit", "-qm", "sanitized-commit-subject"]);
  const sanitizedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: replaceRoot,
    encoding: "utf8",
  }).trim();
  rr(["checkout", "-q", "main"]);
  rr(["replace", replacedSha, sanitizedSha]);
});

describe("gitCli", () => {
  it("runs `git rev-parse --abbrev-ref HEAD`", async () => {
    const { stdout, exitCode } = await gitCli(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoRoot },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("main");
  });

  it("captures stderr and non-zero exit on failure", async () => {
    const r = await gitCli(["rev-parse", "--abbrev-ref", "no-such-ref"], {
      cwd: repoRoot,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown|fatal|ambiguous/i);
  });

  it("forces GIT_NO_REPLACE_OBJECTS so reads see the REAL object under a replace ref", async () => {
    // Default git would honor the replace ref and show the sanitized subject.
    // gitCli must see the real object.
    const { stdout, exitCode } = await gitCli(
      ["log", "-1", "--format=%s", replacedSha],
      { cwd: replaceRoot },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("real-commit-subject");
  });

  it("cannot be overridden by a caller env that would otherwise honor the replace ref", async () => {
    // `GIT_NO_REPLACE_OBJECTS` is PRESENCE-based: any value (incl. "0"/"") disables
    // replace; replace is honored ONLY when the variable is UNSET. So an env value
    // of "0" would NOT distinguish a correct (forced-last) merge from a broken
    // (caller-last) one. Passing `undefined` does: node's spawn DROPS undefined
    // keys, so with the correct forced-last merge the variable is "1" (real seen),
    // but if the merge were reversed (caller wins) the key would be dropped → unset
    // → git would honor the replace ref → "sanitized-commit-subject" → this fails.
    const { stdout, exitCode } = await gitCli(
      ["log", "-1", "--format=%s", replacedSha],
      {
        cwd: replaceRoot,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: undefined },
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("real-commit-subject");
  });

  it("control: a raw git spawn with the var unset DOES honor the replace ref", () => {
    // Proves the override test above is non-vacuous: absent the forced flag, this
    // exact env genuinely resolves the replace ref to the sanitized object.
    const env = { ...process.env };
    delete env.GIT_NO_REPLACE_OBJECTS;
    const out = execFileSync("git", ["log", "-1", "--format=%s", replacedSha], {
      cwd: replaceRoot,
      encoding: "utf8",
      env,
    });
    expect(out.trim()).toBe("sanitized-commit-subject");
  });
});
