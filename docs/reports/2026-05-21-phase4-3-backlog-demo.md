# Phase 4-3 — Personal Backlog 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-3-backlog.md`（Phase 4-3 設計）
**Harness range:** Phase 4-3 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase4`

## 背景

Phase 3 までは「やりたいこと」はその場で `harness run` する前提だった。Phase 4-3 で backlog item として積み、run と双方向に紐づける。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/backlog.ts`（新規） | `addItem` / `listItems` / `showItem` / `setItemStatus` / `recordBacklogRun` / `findBacklogItemForRun` |
| `src/cli/run.ts` | `harness backlog add/list/show/run/done/defer`。`cmdRun` / `cmdReviewedRun` を runId 返却型にリファクタ（exit は action 側へ） |
| `src/config/paths.ts` / `.gitignore` | `backlog/`（gitignore 対象） |

item は `backlog/<status>/item-YYYYMMDD-NNN.yaml`。**435 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1×2 + P2×3、全件 same-cycle fix:

| # | severity | 概要 | 修正 |
|---|----------|------|------|
| 1 | P1 | `moveItemFile` が write-new→rm-old でクラッシュ時に item が 2 status dir に残る | 更新内容を旧 path に書いてから `rename` で atomic 移動。`locate` は全 status 走査し重複検出で `BacklogError` |
| 2 | P1 | `recordBacklogRun` が lock 無しで `meta.json` を後追い patch → 並行 review/cleanup と last-writer-wins | meta patch を**廃止**。link は backlog 側のみに保持し、`run show` が `linkedRuns` を逆引き（`findBacklogItemForRun`）— write 競合の余地を排除 |
| 3 | P2 | `nextItemId` scan→write の race で並行 add が同じ id を採番 | `writeFile({flag:"wx"})` で排他作成、EEXIST なら次番号で retry |
| 4 | P2 | `recordBacklogRun` が runId 未検証で path に使用 | `RUN_ID_RE` で検証 |
| 5 | P2 | `backlog run --max-attempts` が friendly validation を経ない | 既存 reviewed-run と同じ positive-integer 検証を追加 |

## 実機デモ — E4-3

### E4-3-1: add / list / show

```
$ harness backlog add --title "catalog isOnSale フラグ" --domain apps/catalog \
    --goal "products に isOnSale(product) を追加" --priority high --tags catalog,validation
added item-20260521-001 [open]
$ harness backlog list
item-20260521-002  [open] medium apps/orders  orders 配送料計算
item-20260521-001  [open] high   apps/catalog  catalog isOnSale フラグ
$ harness backlog show --item-id item-20260521-001  → Title/Domain/Priority/Tags/Goal/Linked runs
```
✅ add（連番 id、priority/tags）/ list / show。

### E4-3-2 / E4-3-4: backlog run と双方向参照（実機 codex）

```
$ harness backlog run --item-id item-20260521-002 --repo /Users/kn/dev/mini-commerce \
    --repo-id mini-commerce --workflow run
run=run-20260521-apps-orders-mpfjvmpvcdeccedb status=needs_review ...
backlog item-20260521-002 → doing, linked run run-...-mpfjvmpvcdeccedb (1 total)

$ harness run show --run-id run-...-mpfjvmpvcdeccedb
  ... Backlog item:
        item-20260521-002
$ harness backlog show --item-id item-20260521-002
  Linked runs:
    run-...-mpfjvmpvcdeccedb
```
✅ `backlog run` で実機 run が起動、item の `linkedRuns` に記録、item は `doing` へ。`run show` は backlog を逆引きして item を表示（双方向参照）。

### E4-3-3 / E4-3-5: done / defer / status 別 list

```
$ harness backlog defer --item-id item-20260521-001  →  item-20260521-001 → deferred
$ harness backlog list --status open      → No backlog items.
$ harness backlog list --status doing     → item-20260521-002 [doing]
$ harness backlog list --status deferred  → item-20260521-001 [deferred]
```
✅ done/defer で item が status dir 間を移動、status 別に一覧できる。

## 閉じる条件チェック（Phase 4-3 設計 4-3.6）

```txt
[x] backlog item を追加できる            — E4-3-1
[x] backlog list/show が動く             — E4-3-1
[x] backlog run で run を起動できる       — E4-3-2（実機）
[x] linkedRuns が記録される              — E4-3-2
[x] done/defer できる                    — E4-3-3
[x] run show から backlog item が分かる   — E4-3-4（backlog 逆引き）
```

## 新規 finding

なし。codex review の P1×2 + P2×3 は実装直後に fix 済み。

## 後片付け

- demo 用 backlog item（001/002）と E4-3-2 の run は残置（後続フェーズのデモ素材になる）
