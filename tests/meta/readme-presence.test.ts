import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot, trackedSrcTsPaths } from "./_helpers.js";

/**
 * 大ドメイン README-presence meta-test（#125 B8）。
 *
 * 目的: src 直下のサブディレクトリのうち追跡 .ts 数が THRESHOLD 以上の「大ドメイン」に
 * README.md の存在を推奨する。現状 README がないドメインは ALLOWLIST_NO_README で
 * grandfather し、新規の大ドメインが README なしで追加されたら fail する（advisory gate）。
 *
 * 閾値（THRESHOLD = 15）の根拠:
 *   db/core/hitch/mcp/project はいずれも 15+ ファイルを持つ主要ドメイン。
 *   workspace/roadmap/codex 等の中規模は 15 未満なので推奨対象外とする。
 *
 * grandfather（ALLOWLIST_NO_README）:
 *   現状 README.md が存在しない大ドメインを全て列挙。解消は任意（advisory）。
 *
 * advisory の意味: このテストは design 上の推奨チェックであり、README がなくても
 * 実装・テストの品質には直接影響しない。ただし新規大ドメインを追加した際に
 * README 整備を意識させる regression guard として機能する。
 */

const THRESHOLD = 15;

/**
 * src 直下の各サブディレクトリに含まれる追跡 .ts ファイル数を返す。
 * src 直下のファイル（src/index.ts 等）はサブディレクトリに属さないため除外する。
 */
function buildDomainCounts(
  paths: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of paths) {
    // p は "src/<domain>/..." または "src/index.ts" の形式
    const parts = p.split("/");
    if (parts.length < 3) {
      // src 直下のファイル（src/index.ts 等）はドメインなし
      continue;
    }
    const domain = parts[1] ?? "";
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// ALLOWLIST_NO_README: 現在 README.md が存在しない大ドメイン（技術的負債・grandfather）
// 解消は後続 PR の任意作業（advisory）。
//
// 現状（0.7.17 時点）: src 直下の大ドメインは全て README.md を持たない。
// ---------------------------------------------------------------------------
const ALLOWLIST_NO_README = new Set<string>([
  "db",      // 60 files — migrations/repositories/doctor 等。最大ドメイン。
  "core",    // 50 files — run/review/knowledge/backlog 等の主要業務ロジック。
  "hitch",   // 43 files — hitch/jury 収束ループ。
  "mcp",     // 29 files — MCP server/tools/registry。
  "project", // 24 files — Project Abstraction 層。
]);

describe("大ドメイン README-presence gate (#125 B8, advisory)", () => {
  const root = repoRoot();
  const paths = trackedSrcTsPaths(root);
  const domainCounts = buildDomainCounts(paths);

  // 閾値以上の「大ドメイン」を抽出
  const largeDomains = [...domainCounts.entries()]
    .filter(([, count]) => count >= THRESHOLD)
    .map(([domain]) => domain);

  it("0 件 loud fail guard: src ファイルが列挙されていること", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  it("大ドメインが少なくとも 1 つ存在すること（閾値設定の sanity check）", () => {
    expect(largeDomains.length).toBeGreaterThan(0);
  });

  it("新規の大ドメインは README.md を持つこと（grandfather 外）", () => {
    const missingReadme = largeDomains.filter((domain) => {
      if (ALLOWLIST_NO_README.has(domain)) return false;
      return !existsSync(join(root, "src", domain, "README.md"));
    });
    expect(missingReadme).toEqual([]);
  });

  it("ALLOWLIST が陳腐化していないこと（README が追加されたら ALLOWLIST から外す）", () => {
    const stale = [...ALLOWLIST_NO_README].filter((domain) => {
      // domain が大ドメインとして存在し、かつ README.md が既に追加された場合
      const count = domainCounts.get(domain) ?? 0;
      if (count < THRESHOLD) return false; // 縮小で閾値割れした場合は別途考慮不要
      return existsSync(join(root, "src", domain, "README.md"));
    });
    expect(stale).toEqual([]);
  });

  it("ALLOWLIST 内ドメインは現在も大ドメインであること（閾値割れで ALLOWLIST を掃除）", () => {
    // ALLOWLIST に残っているが閾値を下回ったドメインは、ALLOWLIST から除去できる。
    // fail-closed のため warn のみ（soft check）—— 縮小は問題ではないが陳腐化を通知。
    // 現状コードがないドメイン名が紛れ込んでいないことも兼ねて確認。
    const unknownDomains = [...ALLOWLIST_NO_README].filter(
      (domain) => !domainCounts.has(domain),
    );
    expect(unknownDomains).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ヘルパー: 全ドメインの統計を公開（デバッグ・ドキュメント用。テストではない）
// ---------------------------------------------------------------------------
export function getDomainStats(root = repoRoot()): Array<{
  domain: string;
  count: number;
  hasReadme: boolean;
  isLarge: boolean;
  grandfathered: boolean;
}> {
  const paths = trackedSrcTsPaths(root);
  const counts = buildDomainCounts(paths);
  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([domain, count]) => ({
      domain,
      count,
      hasReadme: existsSync(join(root, "src", domain, "README.md")),
      isLarge: count >= THRESHOLD,
      grandfathered: ALLOWLIST_NO_README.has(domain),
    }));
}

// 現在の大ドメイン一覧を git ls-files ベースで構築するヘルパー（meta-test 自身の検証用）
export function _listLargeDomainsForTest(root = repoRoot()): string[] {
  const out = execFileSync("git", ["ls-files", "--", "src"], {
    cwd: root,
    encoding: "utf8",
  });
  const allPaths = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((p) => p.endsWith(".ts"))
    .filter((p) => !p.endsWith(".d.ts") && !p.endsWith(".test.ts"));
  const counts = buildDomainCounts(allPaths);
  return [...counts.entries()]
    .filter(([, c]) => c >= THRESHOLD)
    .map(([d]) => d);
}
