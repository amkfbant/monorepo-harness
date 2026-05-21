# Phase 4-6 — Personal Metrics 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-6-metrics.md`（Phase 4-6 設計）
**Harness range:** Phase 4-6 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase4`

## 背景

個人運用の改善に使う指標（run / review / retry / safety / maintenance）を期間・domain 別に集計する。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/metrics.ts`（新規） | `buildMetrics` / `formatMetricsSummary` / `formatFailures` |
| `src/cli/run.ts` | `harness metrics summary / domain / failures` |

**468 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1×1 + P2×3、全件 same-cycle fix:

| # | severity | 概要 | 修正 |
|---|----------|------|------|
| 1 | P1 | `policyViolations` を `status==="failed-policy-violation"` のみで計上 — safetyStatus は final status と直交（failed-codex かつ denied を見落とす） | `r.safetyStatus === "denied"` で計上 |
| 2 | P2 | rerun chain 収束を filtered runs のみで判定 → `--since`/`--domain` で chain の approved run が落ちると誤って非収束 | chain-approved を**全 run**で計算、収束率の分母 root のみ filtered から |
| 3 | P2 | `formatFailures` が `[index]/[file-scan]` を表示せず summary と不一致 | failures header に `[source]` を追加 |
| 4 | P2 | 設計の Retry 指標 `maxAttempts 到達数` が欠落 | root run の `workflow.json` の `finalStatus==="not_converged"` を集計、`notConverged` として表示 |

## 実機デモ — E4-6（既存 runs/）

### metrics summary

```
$ harness metrics summary
Metrics: all time  [file-scan]
Runs: 26
  approved: 3 / changes_requested: 2 / cleaned: 3 / failed-policy-violation: 1 / needs_review: 17
Review:
  approved: 3  changes_requested: 2  rejected: 0
  approved rate: 60%
  reviewers: codex-reviewer-p31=2, knkn=2, ...
Retry:
  reruns: 1  chains: 1  converged: 1
  convergence rate: 100%
  not_converged workflows: 0
Safety: policy violations: 1 / secret suspects: 2
Maintenance: cleanup pending: 3
```
✅ run/review/retry/safety/maintenance を集計。

### metrics failures / domain

```
$ harness metrics failures
Failures: all time  [file-scan]
  failed-policy-violation: 1
Total failed: 1

$ harness metrics domain apps/orders
Metrics: all time (domain apps/orders)  [file-scan]
Runs: 11  ...
```
✅ failed-* の status 別内訳 / domain 別 summary。

run 読み込みは index → file-scan フォールバック（`[file-scan]` 表示）。`--since` も unit test で担保。

## 閉じる条件チェック（Phase 4-6 設計 4-6.4）

```txt
[x] 期間別summaryが出る           — metrics summary --since
[x] domain別summaryが出る         — metrics domain
[x] failed reason別summaryが出る   — metrics failures
[x] review/rerun収束率が出る       — approved rate / convergence rate
[x] SQLite index を使える          — loadAllRuns（index 優先、source 表示）
```

## 新規 finding

なし。codex review の P1×1 + P2×3 は実装直後に fix 済み。P1（safetyStatus による violation 集計）は、failed-codex かつ scope 違反のケースを取りこぼさないための重要な修正だった。
