import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { repoRoot, trackedSrcTsPaths } from "./_helpers.js";

/**
 * src 内の相対 import による循環依存検出 meta-test（#125 B9）。
 *
 * 目的: 依存グラフに循環があると tree-shaking/lazy-loading・テスト隔離・型推論が
 * 壊れやすくなる。DFS back-edge で循環を列挙し、新規追加を阻止する。
 *
 * 対象: 相対 import（`from "./..."` / `from "../..."`）のみ。
 *   - .js 拡張子 → .ts に解決（ESM 出力規約）。
 *   - type-only import（`import type { ... } from "..."` / `import { type ... }`）も
 *     含む。TypeScript はコンパイル時に消去するが、循環は設計臭として同等に扱う。
 *     実行時 cycle を絞りたい場合は type-only を除外する方が精確だが、現状は
 *     保守的（fail-closed 方向）にすべて検査する。
 *
 * grandfather（既知循環）:
 *   現状 19 の循環が存在する技術的負債。いずれも相互参照型や宣言的台帳に起因する。
 *   これらを ALLOWLIST で grandfather し、新規循環の追加のみを失敗とする。
 *
 * 既知循環の解消は #125 Track B の後続作業として別 PR で行う。
 */

type Cycle = readonly string[];

/** 相対 import の正規表現（type-only 含む）。 */
const RELATIVE_IMPORT_RE = /from\s+['"](\.[^'"]+)['"]/g;

/**
 * src ファイル群の隣接リストを構築する。
 * - .js 拡張子を .ts に変換して解決。
 * - パスが tracked src リストに存在しない場合は無視（外部 package import は非対象）。
 */
function buildAdjacency(
  paths: readonly string[],
  root: string,
): Map<string, string[]> {
  const pathSet = new Set(paths);
  const adj = new Map<string, string[]>(paths.map((p) => [p, []]));

  for (const p of paths) {
    const content = readFileSync(join(root, p), "utf8");
    RELATIVE_IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RELATIVE_IMPORT_RE.exec(content)) !== null) {
      let imp = m[1] ?? "";
      // ESM 出力規約: .js → .ts に解決
      if (imp.endsWith(".js")) {
        imp = imp.slice(0, -3) + ".ts";
      }
      const absResolved = resolve(join(root, dirname(p)), imp);
      const rel = absResolved.slice(root.length + 1);
      if (pathSet.has(rel)) {
        adj.get(p)!.push(rel);
      }
    }
  }

  return adj;
}

/** DFS で back-edge を検出し、循環のある経路を返す（重複経路を含む）。 */
function detectCycles(adj: Map<string, string[]>): Cycle[] {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>(
    [...adj.keys()].map((k) => [k, WHITE]),
  );
  const cycles: Cycle[] = [];

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) {
        // back-edge: 循環を記録
        const start = path.indexOf(neighbor);
        cycles.push(Object.freeze([...path.slice(start), neighbor]));
      } else if (color.get(neighbor) === WHITE) {
        dfs(neighbor, path);
      }
    }
    path.pop();
    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node, []);
    }
  }

  return cycles;
}

/**
 * 循環を文字列キーに正規化する（比較・差分計算用）。
 * 経路を最小語彙の node から始める canonical rotation を使う。
 */
function canonicalize(cycle: Cycle): string {
  // 末尾 = 始端の再訪なので除いて処理
  const body = cycle.slice(0, -1);
  const minIdx = body.indexOf(body.reduce((a, b) => (a < b ? a : b)));
  const rotated = [...body.slice(minIdx), ...body.slice(0, minIdx)];
  return rotated.join(" -> ");
}

// ---------------------------------------------------------------------------
// ALLOWLIST: 現状の既知循環（技術的負債・grandfather）
// これらは現 codebase に既に存在し、新規でない。解消は後続 PR で行う。
//
// grandfather の理由:
//   - src/db/migrations.ts ↔ src/db/schema-compat.ts:
//       migration と schema compat 定義の相互参照。
//   - src/hitch/types.ts ↔ src/hitch/jury/types.ts:
//       hitch/jury 間の型相互参照（scope-snapshot.ts を経由するバリアントも含む）。
//   - src/hitch/orchestrator-runners.ts ↔ src/hitch/orchestrator-close-check-runner.ts:
//       close-check runner の相互参照。
//   - src/db/doctor.ts ↔ src/db/jury-doctor-checks.ts:
//       doctor チェック登録の双方向依存。
//   - src/db/doctor.ts ↔ src/db/review-refute-vote-doctor-checks.ts:
//       同上（refute vote チェック）。
//   - src/mcp/registry/tool-registry.ts ↔ src/mcp/tools/*:
//       MCP tool 登録の宣言的台帳が tools から registry を import する設計。
//
// ---------------------------------------------------------------------------
const ALLOWLIST_CYCLES = new Set<string>([
  // db: migrations ↔ schema-compat
  "src/db/migrations.ts -> src/db/schema-compat.ts",
  // hitch: types ↔ jury/types
  "src/hitch/jury/types.ts -> src/hitch/types.ts",
  // hitch: types -> jury/types -> jury/scope-snapshot (経路バリアント)
  "src/hitch/jury/scope-snapshot.ts -> src/hitch/types.ts -> src/hitch/jury/types.ts",
  // hitch: orchestrator-runners ↔ orchestrator-close-check-runner
  "src/hitch/orchestrator-close-check-runner.ts -> src/hitch/orchestrator-runners.ts",
  // db: doctor ↔ jury-doctor-checks
  "src/db/doctor.ts -> src/db/jury-doctor-checks.ts",
  // db: doctor ↔ review-refute-vote-doctor-checks
  "src/db/doctor.ts -> src/db/review-refute-vote-doctor-checks.ts",
  // mcp: tool-registry ↔ read-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/read-tools.ts",
  // mcp: tool-registry -> read-tools -> tool-helpers (経路バリアント)
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/read-tools.ts -> src/mcp/tools/tool-helpers.ts",
  // mcp: tool-registry ↔ workspace-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/workspace-tools.ts",
  // mcp: tool-registry ↔ workspace-read-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/workspace-read-tools.ts",
  // mcp: tool-registry ↔ aggregate-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/aggregate-tools.ts",
  // mcp: tool-registry ↔ ops-knowledge-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/ops-knowledge-tools.ts",
  // mcp: tool-registry ↔ release-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/release-tools.ts",
  // mcp: tool-registry ↔ dry-run-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/dry-run-tools.ts",
  // mcp: tool-registry ↔ mutation-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/mutation-tools.ts",
  // mcp: tool-registry -> mutation-tools -> confirmation (経路バリアント)
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/mutation-tools.ts -> src/mcp/security/confirmation.ts",
  // mcp: tool-registry -> hitch-tools -> operation-wrapper (経路バリアント)
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/hitch-tools.ts -> src/mcp/tools/operation-wrapper.ts",
  // mcp: tool-registry ↔ hitch-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/hitch-tools.ts",
  // mcp: tool-registry ↔ course-tools
  "src/mcp/registry/tool-registry.ts -> src/mcp/tools/course-tools.ts",
]);

describe("src import-cycle gate (#125 B9)", () => {
  const root = repoRoot();
  const paths = trackedSrcTsPaths(root);
  const adj = buildAdjacency(paths, root);
  const allCycles = detectCycles(adj);

  it("0 件 loud fail guard: src ファイルが列挙されていること", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  it("新規の循環依存が存在しないこと（grandfather 外）", () => {
    const newCycles = allCycles
      .map((c) => canonicalize(c))
      .filter((key) => !ALLOWLIST_CYCLES.has(key));
    expect(newCycles).toEqual([]);
  });

  it("ALLOWLIST が陳腐化していないこと（解消済み循環は ALLOWLIST から外す）", () => {
    const detectedKeys = new Set(allCycles.map((c) => canonicalize(c)));
    const stale = [...ALLOWLIST_CYCLES].filter((key) => !detectedKeys.has(key));
    // 循環が解消されたら ALLOWLIST から外すことを強制する（ratchet）。
    expect(stale).toEqual([]);
  });
});
