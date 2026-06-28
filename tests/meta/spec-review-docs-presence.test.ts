import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot } from "./_helpers.js";

/**
 * spec-review 起案テンプレ doc の presence + 相互リンク健全性 meta-test（#356・#231 follow-up）。
 *
 * なぜ必要か（防ぐ回帰）: #231（案C spec-review 層）の AC1「起案→批判→統合の成果物テンプレが
 * 存在」は、spec-review-layer.md と、それが reuse する consulting-frameworks.md /
 * deliberation.md / 設計 proposal に依存して充足している。これらが削除/rename/移動しても
 * CI が落ちない（doc rot が無検出）弱点を、この meta-test が機械的に pin する。
 *
 * 何を pin するか:
 *  1. spec-review 層の正本 doc 群が存在する（SOURCE_OF_TRUTH_DOCS）。
 *  2. spec-review-layer.md 内の相対 markdown リンクがすべて解決する（rename/削除を回帰検出）。
 *
 * readme-presence.test.ts と同じ作法（repoRoot 基準・fs-walk 禁止・存在は existsSync）に倣う。
 */

// spec-review 層が依拠する正本 doc（1つでも欠けたら #231 のテンプレ充足が崩れる）。
const SOURCE_OF_TRUTH_DOCS = [
  "docs/specs/spec-review-layer.md",
  "docs/design/consulting-frameworks.md",
  "docs/design/deliberation.md",
  "docs/design/proposals/design-231-spec-drafting-review-layer.md",
] as const;

// 相互リンク健全性の検査対象（spec-review 層の入口 doc）。
const LINK_GRAPH_ROOT = "docs/specs/spec-review-layer.md";

/**
 * markdown 本文から「相対パスへのリンク先」だけを抽出する。
 * 対象外: 絶対 URL（http(s):// / mailto:）と、同一ファイル内アンカー（`#...`）のみのリンク。
 * 各リンク先からは `#anchor` と `?query` を落とした path 部分を返す。
 */
function extractRelativeLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const linkRe = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(markdown)) !== null) {
    const raw = (m[1] ?? "").trim();
    if (raw.length === 0) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, https:, mailto: 等
    if (raw.startsWith("#")) continue; // 同一 doc 内アンカー
    const pathPart = raw.split("#")[0]?.split("?")[0] ?? "";
    if (pathPart.length === 0) continue; // `#` のみ
    targets.push(pathPart);
  }
  return targets;
}

describe("spec-review 起案テンプレ doc presence + 相互リンク (#356)", () => {
  const root = repoRoot();

  it.each(SOURCE_OF_TRUTH_DOCS)("正本 doc が存在する: %s", (rel) => {
    expect(existsSync(join(root, rel))).toBe(true);
  });

  it(`${LINK_GRAPH_ROOT} の相対リンクがすべて解決する（doc rot 検出）`, () => {
    const docPath = join(root, LINK_GRAPH_ROOT);
    expect(existsSync(docPath)).toBe(true);

    const content = readFileSync(docPath, "utf8");
    const targets = extractRelativeLinkTargets(content);

    // 0 件 loud-fail ガード（非対称・fail-closed）: リンクが取れない＝抽出が壊れて
    // テストが silently 無効化された状態。readme-presence.test.ts の 0 件ガードに倣う。
    expect(targets.length).toBeGreaterThan(0);

    const baseDir = dirname(docPath);
    const broken = targets.filter(
      (t) => !existsSync(resolve(baseDir, t)),
    );
    expect(broken).toEqual([]);
  });
});
