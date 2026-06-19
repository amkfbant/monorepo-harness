import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * meta-test 共通基盤: 「追跡対象の src ソース一覧」を決定論的に列挙する。
 *
 * なぜ git ls-files か（fs-walk 禁止の理由・最重要の不変条件）:
 * このリポジトリは agent workspaces として `workspaces/run-<id>/repo/` 配下に src/ の
 * フルコピーを多数（数千〜万オーダー・.gitignore 済）作る。fs.readdir で src/ を歩くと
 * それらの未追跡コピーまで拾い、file-size / readme-presence 等の meta-test が
 * false-positive する。git ls-files は「追跡されているファイルのみ」を返すため、
 * 未追跡コピー・/tmp・node_modules を構造的に排除できる。**fs-walk へ退行させない。**
 *
 * `src/**\/*.ts` glob を使わない理由（実測で確認した取りこぼし）:
 * git pathspec の `**\/` は1階層以上のディレクトリを要求するため `src/index.ts`
 * （src 直下）を取りこぼす（`src/**\/*.ts`=287 vs 全 src .ts=288）。よって `src` 配下を
 * 全列挙してから拡張子で絞る。
 */

/** リポジトリのルート（git toplevel）。meta-test の cwd 非依存化に使う。 */
export function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

/** 追跡対象の src 配下 .ts（.test.ts / .d.ts 除く）を repo-relative path で返す。 */
export function trackedSrcTsPaths(root = repoRoot()): readonly string[] {
  const out = execFileSync("git", ["ls-files", "--", "src"], {
    cwd: root,
    encoding: "utf8",
  });
  const paths = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((p) => p.endsWith(".ts"))
    .filter((p) => !p.endsWith(".d.ts") && !p.endsWith(".test.ts"));
  assertEnumerationSane(paths);
  return paths;
}

/**
 * 列挙結果の健全性ガード（非対称・fail-closed）。meta-test の信頼性の核。
 * (a) 0 件は「git が走らなかった / 絞り込み過剰」を意味し、meta-test を silently 無効化
 *     する（全部 pass に見える）ため loud fail させる。
 * (b) 将来 fs-walk へ退行した場合に未追跡コピーを掴むのを検知するため、返り path に
 *     workspaces/ ・node_modules ・/tmp/ ・絶対パス ・`..` が混じったら loud fail。
 */
export function assertEnumerationSane(paths: readonly string[]): void {
  if (paths.length === 0) {
    throw new Error(
      "meta enumeration returned 0 tracked src files — git ls-files が走っていない、" +
        "または絞り込みが過剰。fs-walk fallback は禁止（workspaces/ の未追跡コピーを掴む）。",
    );
  }
  const dirty = paths.find(
    (p) =>
      p.includes("/workspaces/") ||
      p.startsWith("workspaces/") ||
      p.includes("node_modules") ||
      p.includes("/tmp/") ||
      p.startsWith("/") ||
      p.includes(".."),
  );
  if (dirty !== undefined) {
    throw new Error(
      `meta enumeration に追跡対象外の path が混入: ${dirty}。` +
        "git ls-files の結果のみを使うこと（fs-walk 退行の疑い）。",
    );
  }
}

export interface SrcFileSize {
  readonly path: string;
  readonly loc: number;
}

/**
 * 追跡 src .ts のサイズ（wc -l 相当 = 改行数）一覧。file-size meta-test（B6a/B6b）の基盤。
 * loc は `wc -l` と一致させるため改行文字数で数える。
 */
export function listTrackedSrcSizes(root = repoRoot()): readonly SrcFileSize[] {
  return trackedSrcTsPaths(root).map((path) => {
    const content = readFileSync(join(root, path), "utf8");
    const loc = (content.match(/\n/g) ?? []).length;
    return { path, loc };
  });
}
