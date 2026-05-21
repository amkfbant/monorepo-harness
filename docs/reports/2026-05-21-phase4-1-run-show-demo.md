# Phase 4-1 — Run Show / Timeline 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-1-run-show-timeline.md`（Phase 4-1 設計）
**Harness range:** Phase 4-1 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase4`

## 背景

Phase 3 までは 1 run の状態を meta.json / summary.md / events.jsonl 等を個別に見る必要があった。Phase 4-1 で `harness run show` / `timeline` / `artifacts` を追加し、read-only で一画面集約する。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/run-viewer.ts`（新規） | `renderRunShow` / `renderRunTimeline` / `renderRunArtifacts` |
| `src/cli/run.ts` | `run show/timeline/artifacts` サブコマンド。`run` の requiredOption → option 化（サブコマンド共存のため）+ action 内で必須引数チェック |
| `src/logging/run-log.ts` | `RunMeta.backlogItemId`（Phase 4-3 で populate する先行追加） |

**416 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0/P1 なし。P2×3、全件 same-cycle fix:

| # | 概要 | 修正 |
|---|------|------|
| 1 | `Review: decision` に常に `meta.status` を表示 → needs_review でも review 済みに見える | `reviewedAt` がある時だけ decision/reviewer/reviewedAt を表示、無ければ `(not reviewed)` |
| 2 | unparseable JSONL 行が event 番号（ordinal）を消費 → 順序表示が misleading | parse 成功時のみ番号 increment、末尾に `skipped N unparseable line(s)` |
| 3 | `RUN_ID_RE` の `{0,127}` 長さ上限が runId 生成と不整合 | review-lister / run-index と同じ `/^run-[A-Za-z0-9][A-Za-z0-9._-]+$/`（length cap なし、path traversal は拒否） |

## 実機デモ — E4-1（既存 runs/、codex 不要）

### E4-1-1: approved run を show

```
$ harness run show --run-id run-20260521-apps-orders-mpfcxfug931cbadc
Run: ...  Domain: apps/orders  Status: approved  Safety: allowed
Reviewer: codex-reviewer-p31
Files: changed 1 / secret 0 / ignored 0
Review: decision approved / reviewedAt 2026-05-21T10:38:56Z
PR: https://github.com/amkfbant/mini-commerce/pull/1
Artifacts: 15 件
```
✅ status / files / review / PR / artifacts が一画面に集約。

### E4-1-3: failed-policy-violation run を show

```
$ harness run show --run-id run-20260520-apps-catalog-mpe41lnne60d2633
Status: failed-policy-violation  Safety: denied
```
✅ failed run も表示。Review は `(not reviewed)`。

### E4-1-5: timeline

```
$ harness run timeline --run-id run-20260521-apps-orders-mpfcxfug931cbadc
  01. run_started
  02. worktree_created
  03. codex_exec_started
  04. codex_exec_completed exitCode=0 timedOut=false
  05. policy_validation_completed stage="post-codex" status="allowed"
  06. diff_collected stage="post-codex"
  07. run_completed status="needs_review"
  08. review_processed decision="approved" reviewer="codex-reviewer-p31"
  09. pr_created prNumber=1 @ 2026-05-21T12:13:00Z
```
✅ events.jsonl を順序付きで人間向けに整形。timestamp を持つ pr_created は併記。

### E4-1-6: artifact 欠損 / 存在しない run

```
$ harness run show --run-id run-20260521-does-not-exist
exit=1（harness error: run ... not found）
```
✅ 存在しない run・artifact 欠損で CLI が落ちず exit 1 で説明的に終了（unit test でも meta.json 破損 / events.jsonl 欠損 / unparseable 行を担保）。

## 閉じる条件チェック（Phase 4-1 設計 4-1.4）

```txt
[x] run show で1 runの概要が見える          — E4-1-1
[x] run timeline で events.jsonl を読める    — E4-1-5
[x] run artifacts で artifact 一覧が見える    — デモ実行
[x] parent/root/attempt が表示される         — unit test E4-1-4
[x] PR情報があれば表示される                 — E4-1-1（PR URL）
[x] artifact欠損時に落ちない                 — E4-1-6
[x] docs/specs/cli.md に記載がある           — 「run show / timeline / artifacts」節
```

## 新規 finding

なし。codex review の P2×3 は実装直後に fix 済み。
