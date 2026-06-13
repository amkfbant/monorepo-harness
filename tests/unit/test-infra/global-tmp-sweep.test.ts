import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTmpDirs } from "../../global-tmp-sweep.js";

const STALE_PREFIXES = [
  "harness-",
  "onb-",
  "ws-repo-",
  "legacy-lock-warn-",
] as const;

const OLD_TIME = new Date(Date.now() - 2 * 60 * 60 * 1000);

let sandboxes: string[] = [];

function makeSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-sweep-root-"));
  sandboxes = [...sandboxes, root];
  return root;
}

function makeDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}

function makeOldDir(root: string, name: string): string {
  const dir = makeDir(root, name);
  utimesSync(dir, OLD_TIME, OLD_TIME);
  return dir;
}

afterEach(() => {
  for (const root of sandboxes) {
    rmSync(root, { recursive: true, force: true });
  }
  sandboxes = [];
});

describe("global temp-dir stale sweep", () => {
  it("removes old matching dirs and leaves unrelated siblings alone", () => {
    const root = makeSandbox();
    const stale = makeOldDir(root, "harness-sweeptest-old");
    const unrelated = makeOldDir(root, "unrelated-keep-old");

    expect(() => sweepStaleTmpDirs(root, STALE_PREFIXES)).not.toThrow();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("does not throw when the sweep root is missing or empty", () => {
    const root = makeSandbox();

    expect(() =>
      sweepStaleTmpDirs(join(root, "missing"), STALE_PREFIXES),
    ).not.toThrow();
    expect(() => sweepStaleTmpDirs(root, STALE_PREFIXES)).not.toThrow();
  });

  it("leaves matching files, symlinks, and fresh dirs untouched", () => {
    const root = makeSandbox();
    const file = join(root, "harness-sweeptest-file");
    const target = makeOldDir(root, "target-dir");
    const symlink = join(root, "harness-sweeptest-link");
    const fresh = makeDir(root, "harness-sweeptest-fresh");

    writeFileSync(file, "not a directory");
    symlinkSync(target, symlink);

    sweepStaleTmpDirs(root, STALE_PREFIXES);

    expect(existsSync(file)).toBe(true);
    expect(existsSync(symlink)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it("removes only stale real directories with matching prefixes", () => {
    const root = makeSandbox();
    const oldDir = makeOldDir(root, "onb-sweeptest-old");
    const freshDir = makeDir(root, "ws-repo-sweeptest-fresh");

    sweepStaleTmpDirs(root, STALE_PREFIXES);

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });
});
