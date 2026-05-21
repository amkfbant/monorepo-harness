# Phase 2-7 — Rerun Convergence 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase2/phase2-7-rerun-convergence.md`（Phase 2-7 設計）の実装と E2-7 デモ
**Harness range:** `69f99ec`（Phase 2-7 実装 + codex review fix）
**Scope tag:** `mvp-validation`

## 背景

Phase 2-4 で `changes_requested → rerun` の仕組みは実装済み。Phase 2-7 は **bounded retry（収束制御）** を加えた:

- `rootRunId` / `rerunAttempt` を chain で carry（`parentRunId` は既存）
- `--max-attempts`（default 2）超過で拒否
- `harness rerun chain` で再実行系譜を表示
- 同じ `required_changes` の繰り返しを警告

## 実装

| 層 | 変更 |
|----|------|
| `src/logging/run-log.ts` | `RunMeta` に `rootRunId` / `rerunAttempt` |
| `src/core/rerun.ts` | root/attempt 計算、`--max-attempts` gate、重複 `required_changes` 警告、`buildRerunChain` / `formatChain` |
| `src/core/workflow-runner.ts` | root/attempt を meta に書き込み |
| `src/cli/run.ts` | `rerun --max-attempts`、`rerun chain` subcommand、`--from-review` を option 化 |

unit +14 / integration +4。**320 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1 ×1 + P2 ×1、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P1 | legacy rerun（`parentRunId` あり / chain フィールド無し、Phase 2-4 製）を original run 扱いし、`rerunAttempt` を 1 にリセット → `--max-attempts` が chain 長を過小評価し bounded retry をすり抜ける | `resolveParentChainPosition` が chain フィールド欠落時に `parentRunId` リンクを（cycle guard 付きで）walk して深さ・root を復元 |
| 2 | P2 | `formatChain` が全 child を `└─` 描画 → 複数子で tree 表示が誤解を招く | `├─` / `└─` / `│ ` ガイドで proper tree drawing |

## 実機デモ — E2-7（mini-commerce）

実機 codex 呼び出し計 3 回（初回 run / rerun / 子の review auto）。E2-7-2/3/4/5 はメタデータ操作のみ。

### E2-7-1: full E2E（初回 → changes_requested → rerun → review auto → review process → approved）

`apps/orders` の `note` フィールド検証追加タスクで:

1. **初回 run** → `run-20260521-apps-orders-mpf6zz9b2f9790ee` status=needs_review
2. **人間 reviewer** が `review-decision.yaml` に `changes_requested` + 2 件の `required_changes`（エラーメッセージに上限値を含める / 空文字列を通す）を記入 → `review process` → `needs_review → changes_requested`
3. **`rerun --from-review`** → 子 run `run-20260521-apps-orders-mpf75yuncc79b763`
   - `parentRunId` = 初回 run、`rootRunId` = 初回 run、`rerunAttempt` = 1
   - `codex-prompt.md` に `required_changes` が埋め込まれた
4. **子を `review auto`**（reviewer agent / codex-reviewer-p27）→ decision=**approved**
   - non_blocking_comments: 「note validation covers omitted, empty, boundary-length, non-string, and over-limit cases」
5. **`review process`** → 子 run `needs_review → approved`

✅ **rerun ループが approved まで通った。** Phase 2-4 close 時に Phase 3 送りとした「rerun 後の成果品質 E2E」をここで消化。reviewer agent が「required_changes（空文字列ケース等）が満たされている」と判断し approved を出した。

### E2-7-2: required_changes 空 → rerun 拒否

`changes_requested` だが `required_changes: []` の run に `rerun`:

```
harness error: … review-decision.yaml must have decision=changes_requested and at least one required_changes entry
exit=1
```

✅ exit 1。

### E2-7-3: --max-attempts 超過 → 拒否

`rerunAttempt: 2` の親（`rootRunId` 記録済み）に `rerun --max-attempts 2`:

```
harness error: rerun would be attempt 3 from root run-20260521-x-root, exceeding --max-attempts 2.
  The chain is not converging — review manually instead of another rerun.
exit=1
```

✅ exit 1。attempt 3 が cap 2 を超えて拒否。

### E2-7-4: parent cleaned → 拒否

`status: cleaned` の run に `rerun`:

```
harness error: parent run … status is "cleaned", only changes_requested can be reused as a rerun base
exit=1
```

✅ exit 1。

### E2-7-5: rerun chain 表示

```
$ harness rerun chain --run-id run-20260521-apps-orders-mpf75yuncc79b763
run-20260521-apps-orders-mpf6zz9b2f9790ee  changes_requested
└─ run-20260521-apps-orders-mpf75yuncc79b763  approved (attempt 1)
```

✅ 子 run を起点に与えても、`parentRunId` を walk して root から系譜を表示。

## 閉じる条件チェック（Phase 2-7 設計 2-7.8）

```txt
[x] changes_requested から child run を作れる             — E2-7-1
[x] child run に parentRunId / rootRunId / rerunAttempt    — E2-7-1（meta 確認）
[x] required_changes が prompt に入る                     — E2-7-1（codex-prompt.md）
[x] required_changes 空なら拒否                           — E2-7-2
[x] parent status が changes_requested 以外なら拒否        — E2-7-4
[x] parent cleaned / missing なら拒否                     — E2-7-4（cleaned）+ gate（missing）
[x] maxAttempts を超えると拒否                            — E2-7-3
[x] rerun後に review auto → review process → approved E2E — E2-7-1
[x] chain表示または相当の監査導線がある                    — E2-7-5
[x] docs に rerun の収束条件が明記される                   — docs/specs/cli.md「収束ルール」表
```

## 新規 finding

なし。codex review の P1×1 + P2×1 は実装直後に fix 済み。

## Deferred

- 重複 `required_changes` 警告は実装・unit test 済みだが、実機デモでは収束が 1 回で済んだため発火していない（自然な結果）。多段収束失敗の実機サンプルは Phase 3
- 完全自動 retry loop（`review process` → `rerun` → `review` の自動連鎖）は Phase 2 範囲外、Phase 3

## 後片付け

- demo run（`mpf6zz…` changes_requested / `mpf75y…` approved）は runs/ に残置（gitignore 対象、chain 監査用に保持）
- `tmp/validation/e271-*` は .gitignore 配下
