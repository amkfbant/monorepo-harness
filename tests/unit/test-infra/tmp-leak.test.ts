import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import globalTmpSweep, {
  removeRunTmpRoot,
  RUN_TMP_PREFIX,
} from "../../global-tmp-sweep.js";
import { makeTmpDir } from "../../helpers/tmp.js";

describe("per-run private TMPDIR subroot teardown", () => {
  it("removeRunTmpRoot deletes the private subroot (and only what it is given)", () => {
    // Isolated synthetic root — never the live os.tmpdir().
    const sandbox = makeTmpDir("harness-tmpleak-root-");

    const runRoot = mkdtempSync(join(sandbox, RUN_TMP_PREFIX));
    // Content created "by tests" lands under the private subroot.
    mkdirSync(join(runRoot, "nested"), { recursive: true });
    writeFileSync(join(runRoot, "nested", "leaked.txt"), "x");
    // A sibling under the same sandbox must be untouched.
    const sibling = mkdtempSync(join(sandbox, "harness-sibling-"));

    removeRunTmpRoot(runRoot);

    expect(existsSync(runRoot)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it("removeRunTmpRoot swallows removal errors (fail-safe teardown)", () => {
    const sandbox = makeTmpDir("harness-tmpleak-root-");
    const runRoot = mkdtempSync(join(sandbox, RUN_TMP_PREFIX));
    const remove = vi.fn(() => {
      throw new Error("busy");
    });

    expect(() => removeRunTmpRoot(runRoot, remove)).not.toThrow();
    expect(remove).toHaveBeenCalledOnce();
    // The dir is still there (removal threw) but no exception escaped.
    expect(existsSync(runRoot)).toBe(true);
  });

  it("removeRunTmpRoot never follows a symlink it is handed", () => {
    const sandbox = makeTmpDir("harness-tmpleak-root-");
    const target = mkdtempSync(join(sandbox, "harness-symlink-target-"));
    const guarded = join(target, "keep.txt");
    writeFileSync(guarded, "keep");
    const link = join(sandbox, `${RUN_TMP_PREFIX}link`);
    symlinkSync(target, link);

    removeRunTmpRoot(link);

    // The symlink itself may be unlinked, but rmSync must not recurse into the
    // target's contents: the guarded file behind the link survives.
    expect(existsSync(guarded)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("globalSetup creates a private subroot, redirects TMPDIR, and returns a teardown that removes only that root", async () => {
    const before = process.env.TMPDIR;
    try {
      const teardown = await globalTmpSweep();
      const runRoot = process.env.TMPDIR;

      expect(typeof teardown).toBe("function");
      expect(runRoot).toBeDefined();
      expect(runRoot).not.toBe(before);
      expect(runRoot?.includes(RUN_TMP_PREFIX)).toBe(true);
      expect(existsSync(runRoot as string)).toBe(true);

      teardown();

      expect(existsSync(runRoot as string)).toBe(false);
    } finally {
      // Restore so the redirect set up by this test does not leak into the
      // worker's other test files.
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });
});
