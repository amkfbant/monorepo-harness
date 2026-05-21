# Phase 4-2 — Inbox 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-2-inbox.md`（Phase 4-2 設計）
**Harness range:** Phase 4-2 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase4`

## 背景

`review list` は review queue のみ。個人運用では failed / cleanup候補 / knowledge候補 も含め「今日見るべきもの」を 1 コマンドに集約したい。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/run-source.ts`（新規） | `loadAllRuns` — SQLite index があれば使い、無ければ / 古ければ file scan にフォールバック |
| `src/core/inbox.ts`（新規） | `buildInbox` / `formatInbox` / `formatInboxJson` — 5 section に分類 + action hint |
| `src/cli/run.ts` | `harness inbox`（`--today` / `--needs-action` / `--failed` / `--cleanup` / `--json`） |

**425 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0/P1 なし。P2×3、全件 same-cycle fix:

| # | 概要 | 修正 |
|---|------|------|
| 1 | `--json` が section 絞り込みより先に return → `inbox --failed --json` が全 section を出す | section 決定を JSON 分岐の前に移動、`formatInboxJson` を section 対応に |
| 2 | action hint に未実装/不正コマンド（`knowledge digest` 未実装、`knowledge list` は `--run-id` 必須、rejected に `pr create`） | hint を実コマンドに修正、cleanup の `pr create` は「approved のみ」と明記 |
| 3 | `--today` が `startedAt.slice(0,10)` で offset 付き timestamp を UTC 正規化しない | `new Date(startedAt).toISOString()` で UTC 日付比較、invalid/null は除外 |

## 実機デモ — E4-2（既存 runs/、codex 不要）

### E4-2-1〜5: 5 section の分類

```
$ harness inbox
Needs review:
  run-... apps/catalog  changed=2 commands=3/3      ... 16 件
  → harness review auto --run-id <id>
Changes requested:
  run-... apps/orders  reviewer=knkn                ... 2 件
  → harness rerun --from-review <id>
Failed:
  run-20260520-apps-catalog-mpe41lnne60d2633 apps/catalog  failed-policy-violation
  → harness run show --run-id <id>
Cleanup candidates / Knowledge: ...
```
✅ needs_review / changes_requested / failed / cleanup候補 / knowledge候補 を分類、各 section に hint。

### E4-2-4: cleanup candidate

approved/rejected かつ `workspaces/<runId>/repo` 残存の run のみ cleanup candidate。worktree が無い approved は出ない（unit test で担保）。実機では 3 件検出。

### E4-2-6: `--json` / `--failed`

```
$ harness inbox --failed
Failed:
  run-20260520-apps-catalog-mpe41lnne60d2633 apps/catalog  failed-policy-violation
$ harness inbox --json  →  source=file-scan needsReview=16 cleanup=3 knowledge=4
```
✅ `--json` は parse 可能、`source` で index/file-scan を確認できる。section 絞り込みは JSON にも効く。

## 閉じる条件チェック（Phase 4-2 設計 4-2.5）

```txt
[x] inbox が needs_review / changes_requested / failed / cleanup / knowledge を表示  — E4-2-1〜5
[x] action hint が出る                       — 各 section に → hint
[x] --today が動く                           — UTC 正規化込みで実装、unit test
[x] --json が動く                            — E4-2-6
[x] index があれば使える                     — loadAllRuns（index 優先）
[x] index が無ければ file scan で動く         — fallback、source=file-scan で確認
```

## 新規 finding

なし。codex review の P2×3 は実装直後に fix 済み。
