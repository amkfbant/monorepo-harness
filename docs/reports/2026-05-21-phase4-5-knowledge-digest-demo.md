# Phase 4-5 — Knowledge Digest 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-5-knowledge-digest.md`（Phase 4-5 設計）
**Harness range:** Phase 4-5 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase4`

## 背景

knowledge candidate / promoted / rejected が増えたとき、週次・日次で振り返れるようにする。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/knowledge-digest.ts`（新規） | `buildKnowledgeDigest` / `formatDigest` |
| `src/cli/run.ts` | `harness knowledge digest`（`--since` / `--domain`） |

**459 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0/P1 なし。P2×3、全件 same-cycle fix:

| # | 概要 | 修正 |
|---|------|------|
| 1 | `readRejections` が invalid index を `-1` で採用、重複 index を二重計上 | `Number.isInteger && >= 0` のみ採用、`Map<index, decidedAt>` で dedup（重複時は最新 decidedAt） |
| 2 | suggestions の `candidateTotal - promoted - rejected` が別時刻イベントの引き算で誤判定 | candidate を `(runId, index)` 単位で判定。promoted md の `source_run#source_index` 集合 + rejection map で未対応 candidate を持つ run のみ提案 |
| 3 | malformed candidate を `kind:"unknown"` で `candidateTotal` に計上（`knowledge list/promote` は skip するため不一致） | candidate を valid 判定（kind/domain が非空文字列）、malformed は count・suggestion から除外（index 整合のため配列には残す） |

## 実機デモ — E4-5（既存 runs/）

### E4-5-1 / E4-5-2: candidate kind 別集計 + promoted/rejected

```
$ harness knowledge digest
Knowledge digest: all time
Candidates:
  codex_no_changes: 1
  ignored_untracked_output: 1
  policy_improvement: 1
  secret_suspect: 1
Promoted: 0
Rejected: 1
Suggested actions:
  - Review candidates from run-... — harness knowledge list --run-id run-...
```
✅ candidate を kind 別集計、promoted（docs/knowledge）/ rejected（knowledge-decisions.yaml）を計上。

### E4-5-3: domain 別

```
$ harness knowledge digest --domain apps/catalog
Knowledge digest: all time (domain apps/catalog)
Candidates: ...
```
✅ candidate.domain でフィルタ。

### E4-5-4: suggested actions

✅ 未 promote・未 reject の candidate を持つ run に `harness knowledge list --run-id` を提案。`(runId, index)` 単位で対応済みを判定するため、既に rejected/promoted の candidate は提案されない（unit test で担保）。

`--since` の期間フィルタ（run startedAt / decidedAt / promoted_at）も unit test で担保。

## 閉じる条件チェック（Phase 4-5 設計 4-5.5）

```txt
[x] knowledge digest が出る            — E4-5-1
[x] domain別に見られる                 — E4-5-3
[x] promoted/rejected も含む           — E4-5-2
[x] action suggestions が出る          — E4-5-4
```

## 新規 finding

なし。codex review の P2×3 は実装直後に fix 済み。
