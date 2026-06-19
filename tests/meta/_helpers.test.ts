import { describe, it, expect } from "vitest";
import {
  trackedSrcTsPaths,
  listTrackedSrcSizes,
  assertEnumerationSane,
} from "./_helpers.js";

describe("meta/_helpers tracked src enumeration", () => {
  it("追跡 src .ts を妥当な数だけ列挙する（sanity floor）", () => {
    // 現状 288。厳密一致は正常なファイル増減で割れるため、列挙バグ/大量取りこぼしを
    // 検知する floor のみを置く。
    expect(trackedSrcTsPaths().length).toBeGreaterThanOrEqual(250);
  });

  it("src 直下ファイル（src/index.ts）と run.ts を取りこぼさない", () => {
    const paths = trackedSrcTsPaths();
    // `src/**\/*.ts` glob が src/index.ts を落とす回帰を pin する。
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/cli/run.ts");
  });

  it("全 path が src/ 始まり・.ts 終わり・未追跡コピー非混入", () => {
    for (const p of trackedSrcTsPaths()) {
      expect(p.startsWith("src/")).toBe(true);
      expect(p.endsWith(".ts")).toBe(true);
      // 未追跡コピーは top-level `workspaces/` ディレクトリ配下に現れる。正規の
      // src ファイル（例 src/db/repositories/workspaces.ts）を誤検知しないよう、
      // `workspaces` は path segment（前後がスラッシュ/行頭）としてのみ拒否する。
      expect(p).not.toMatch(/(^|\/)workspaces\/|node_modules|\/tmp\/|\.\./);
    }
  });

  it("loc は非負整数で run.ts は >4000（baseline sanity）", () => {
    const sizes = listTrackedSrcSizes();
    const run = sizes.find((s) => s.path === "src/cli/run.ts");
    expect(run).toBeDefined();
    expect(run?.loc ?? 0).toBeGreaterThan(4000);
    expect(sizes.every((s) => Number.isInteger(s.loc) && s.loc >= 0)).toBe(true);
  });

  describe("assertEnumerationSane（fail-closed ガードの discriminating 負例）", () => {
    it("0 件は loud fail（meta-test の silent 無効化を防ぐ）", () => {
      expect(() => assertEnumerationSane([])).toThrow(/0 tracked src/);
    });
    it("workspaces/ 未追跡コピー混入は loud fail", () => {
      expect(() =>
        assertEnumerationSane(["workspaces/run-x/repo/src/cli/run.ts"]),
      ).toThrow(/混入|fs-walk/);
    });
    it("node_modules 混入は loud fail", () => {
      expect(() =>
        assertEnumerationSane(["node_modules/foo/index.ts"]),
      ).toThrow();
    });
    it("クリーンな列挙は通る（誤発火しない最小構成）", () => {
      expect(() =>
        assertEnumerationSane(["src/index.ts", "src/cli/run.ts"]),
      ).not.toThrow();
    });
  });
});
