# Phase 3-6 — GitHub PR Integration 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase3/phase3-6-github-pr-integration.md`（Phase 3-6 設計）
**Harness range:** Phase 3-6 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase3`

## 背景

approved run を GitHub draft PR にする。worktree の reviewed 変更を run branch に commit → push → `gh pr create`。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/pr-creator.ts`（新規） | `createPullRequest`（approved gate / commit / push / publish / meta 記録）、`PrPublisher` interface |
| `src/core/gh-pr-publisher.ts`（新規） | `gh` CLI ベースの publisher（head branch で冪等） |
| `src/logging/run-log.ts` | `RunMeta.prUrl` / `prNumber` |
| `src/cli/run.ts` | `harness pr create`、`HARNESS_GH_BIN` |

**392 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1×2 + P2×1、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P1 | `git add -A` が ignore_untracked ファイル（dist/** 等、未検証）も commit | run の `diff_collected` event から **reviewed paths**（tracked + untrackedAllowed）を読み、それだけを `git add -- <paths>` |
| 2 | P1 | pr create が domain lock を取らず、並行 cleanup と競合（stale meta 上書き） | `acquireDomainLock` を取得、lock 内で meta を再読込・全処理 |
| 3 | P2 | gh 成功後 meta write 失敗 → 再実行で duplicate PR | gh publisher が `gh pr list --head` で既存 PR を先に探し、あれば返す（冪等） |

## 実機デモ — E3-6（amkfbant/mini-commerce）

### E3-6-2 / E3-6-3: 非 approved run の拒否

```
$ harness pr create --run-id <needs_review run>
harness error: ... has status "needs_review"; only approved runs can be turned into a PR
exit=1

$ harness pr create --run-id <failed-policy-violation run>
harness error: ... has status "failed-policy-violation"; only approved runs ...
exit=1
```

✅ `needs_review` / `failed-policy-violation` を exit 1 で拒否（副作用なし）。`changes_requested` も同様（unit test で担保）。

### E3-6-1: approved run → draft PR

デモ準備: ローカル `mini-commerce` に `origin`（`git@github.com:amkfbant/mini-commerce.git`）を追加し `main` を push（GitHub repo が空だったため）。

```
$ harness pr create --run-id run-20260521-apps-orders-mpfcxfug931cbadc
run=run-20260521-apps-orders-mpfcxfug931cbadc pr=#1 head=harness/run-.../apps-orders
https://github.com/amkfbant/mini-commerce/pull/1
exit=0
```

検証:
- `meta.json`: `{ "prUrl": ".../pull/1", "prNumber": 1 }` ✅
- `events.jsonl`: `{"type":"pr_created","prUrl":...,"prNumber":1,"head":...,"base":"main"}` ✅
- `gh pr view 1`: `{"isDraft":true,"state":"OPEN","title":"harness run-... (apps/orders)"}` — **draft PR** ✅
- PR 本文に goal / runId / domain / safetyStatus / commands / reviewer の run summary を含む

✅ approved run が draft PR 化され、reviewed paths のみ（`apps/orders/src/orders.ts`）が commit された。

デモ後、作成した PR #1 はクローズ済み（`gh pr close 1`）。

## 閉じる条件チェック（Phase 3-6 設計 3-6.7）

```txt
[x] approved run だけ PR化できる                       — E3-6-1
[x] needs_review / changes_requested / failed-* は拒否  — E3-6-2/3 + unit test
[x] draft PR が作れる                                  — E3-6-1（isDraft: true）
[x] PR本文に run summary が入る                         — buildPrBody（goal/domain/commands/reviewer 等）
[x] meta/events にPR情報が残る                          — E3-6-1（meta.prUrl/prNumber、pr_created event）
[x] docs にGitHub設定手順がある                         — cli.md「前提（GitHub 設定）」節
```

## 新規 finding

なし。codex review の P1×2 + P2×1 は実装直後に fix 済み。

## 後片付け

- demo PR `amkfbant/mini-commerce#1` はクローズ済み
- ローカル `mini-commerce` の `origin` remote とその `main` ブランチ（GitHub）は残置（mini-commerce は検証用ダミー repo）
