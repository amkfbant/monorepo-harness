import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_TMP_PREFIX } from "../global-tmp-sweep.js";

// Created at MODULE TOP LEVEL (before any hook), exactly like the ~66 integration
// files this fix (#270) targets. Under the real vitest config, globalSetup has
// already created the per-run private subroot and redirected process.env.TMPDIR
// to it, so os.tmpdir() in this forked worker resolves to that subroot and this
// dir lands UNDER it. This is the committed regression guard for the Approach-B
// fork-inheritance contract (if a future vitest pre-forks workers before
// globalSetup, this test fails loudly instead of silently leaking).
const moduleTopDir = mkdtempSync(join(tmpdir(), "harness-redirect-probe-"));

afterAll(() => {
  rmSync(moduleTopDir, { recursive: true, force: true });
});

describe("globalSetup TMPDIR redirect reaches forked workers (#270 Approach B)", () => {
  it("redirects os.tmpdir() in the worker to the per-run private subroot", () => {
    const workerTmp = tmpdir();
    expect(workerTmp).toContain(RUN_TMP_PREFIX);
    expect(process.env.TMPDIR).toBe(workerTmp);
  });

  it("a module-top-level mkdtemp lands under the private subroot", () => {
    expect(moduleTopDir.startsWith(tmpdir())).toBe(true);
    expect(moduleTopDir).toContain(RUN_TMP_PREFIX);
  });
});
