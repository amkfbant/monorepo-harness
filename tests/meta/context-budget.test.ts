import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * always-on / 規約 doc の char budget（#125 RP1: 薄い always-on context）。
 *
 * 真の always-on コスト（毎セッション自動ロード）は repo の `CLAUDE.md` のみ。これを
 * 一番タイトに監視し、`GOAL_RULES.md`（on-demand な「どう作るか」正本）はやや緩く
 * 監視する。budget は ratchet（増やさない・relocate で縮めると締まる）。budget を
 * 上げる変更は PR で明示的に正当化すること（silent な肥大化を防ぐ）。
 *
 * char は code point 数（readFileSync utf8 の length）で測る（行数でなく実コスト寄り）。
 * repo-relative path のみ対象（グローバル ~/.claude/CLAUDE.md は repo 外ゆえ非対象）。
 */

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function chars(root: string, rel: string): number {
  return readFileSync(join(root, rel), "utf8").length;
}

// 着手時(#125 Track B governance 編集後)の実測 + 小幅 headroom。
const BUDGET: Record<string, number> = {
  "CLAUDE.md": 10000,
  "GOAL_RULES.md": 12000,
};

describe("always-on / 規約 doc char budget (#125 RP1)", () => {
  const root = repoRoot();
  for (const [rel, budget] of Object.entries(BUDGET)) {
    it(`${rel} は char budget (${budget}) を超えない`, () => {
      const n = chars(root, rel);
      expect(n).toBeLessThanOrEqual(budget);
    });
  }
});
