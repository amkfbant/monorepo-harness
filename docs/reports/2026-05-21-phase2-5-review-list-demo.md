# Phase 2-5 — Review / Run List 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase2/phase2-5-review-run-list.md`（Phase 2-5 設計）の実装と E2-5-1〜5 デモ
**Harness range:** `02947f4`（Phase 2-5 実装 + codex review fix）
**Scope tag:** `mvp-validation`

## 背景

Phase 2-4 時点で `harness review list` は `--all` のみ、default は `needs_review` のみ。Phase 2-5 で運用可能な list CLI に拡張した:

- default を **review queue**（`needs_review` + `changes_requested`）に変更
- `--status` / `--domain` / `--limit` / `--json` を追加
- 壊れた run dir を **invalid** として分離（table は stderr 警告、`--json` は `invalidRuns[]`）
- table 列を spec に合わせ拡張（reviewer / parent / commands を追加）

## 実装

| 層 | 変更 |
|----|------|
| `src/core/review-lister.ts` | `listReviews` が `{ valid, invalid }` を返す形に。status/domain/limit フィルタ、`formatTable` / `formatJson` |
| `src/cli/run.ts` | `review list` に `--status` / `--domain` / `--limit` / `--json` |
| `src/logging/run-log.ts` | `RunStatus` / `SafetyStatus` を runtime 配列 `RUN_STATUSES` / `SAFETY_STATUSES` から導出（single source of truth） |
| `src/core/cleanup.ts` | 重複していた `RUN_STATUS_SET` を共有版に置換 |

unit 21 ケース / integration 11 ケース。**283 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1 ×1 + P2 ×3、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P1 | `commandSummaryOf` が `commandResults` の要素形状を未検証 → `[null]` で list 全体がクラッシュ | 各要素を `object && exitCode:number && timedOut:boolean` で検証、不正なら run を invalid に分離 |
| 2 | P2 | 非 string / missing の `meta.runId`、未知の `status` / `safetyStatus` が valid をすり抜ける | runId 必須一致、status を `RUN_STATUSES`、safetyStatus を `SAFETY_STATUSES` で検証 → 不正は invalid |
| 3 | P2 | `--status` の typo が exit 0 の `no runs` になり、queue が空と誤認させる | CLI で既知 RunStatus に対し検証、未知値は exit 1 |
| 4 | P2 | `--limit` 検証が CLI 側のみ。core に `-1` / `NaN` / `1.5` が直接渡ると曖昧 | `listReviews` 冒頭で `Number.isInteger && >= 0` を検証、不正は `RangeError` |

## 実機デモ — E2-5-1〜5（mini-commerce）

### E2-5-1 / E2-5-2: default queue（needs_review + changes_requested）

```
$ harness review list
runId                                       domain        status             safety   reviewer  parent  commands  secrets  ignored  startedAt
run-20260521-apps-orders-mpf2gzf6024a6602   apps/orders   changes_requested  allowed  knkn      -       -         0        0        2026-05-21T05:45:12Z
run-20260520-apps-catalog-mpe9vluk4ec0ec90  apps/catalog  needs_review       allowed  -         -       2/2       0        0        2026-05-20T16:24:46Z
...
```

✅ `changes_requested` の run（reviewer=knkn）と `needs_review` の run が両方表示。`commands` 列に `2/2`、reviewer / parent も表示。

### E2-5-3: cleaned はデフォルト非表示

```
$ harness review list --all | grep -c cleaned
2
```

✅ default では cleaned 0 件、`--all` で 2 件表示。

### E2-5-4: フィルタ + JSON

- `--status changes_requested` → changes_requested の 1 件のみ ✅
- `--domain apps/orders` → orders domain のみ ✅
- `--limit 2` → 上位 2 行のみ ✅
- `--json` → `{ validRuns, invalidRuns }` で parse 可能、`commandSummary` / `reviewedAt` / `finishedAt` 等のフィールド込み ✅

### E2-5-5: 壊れた meta.json

`runs/run-20260521-broken-demo/meta.json` に不正 JSON を置いて確認:

```
# table モード
$ harness review list
（表は正常 run のみ）
[stderr] warning: 1 unreadable run dir(s) hidden; use --all or --json to inspect
exit=0

# --json モード
validRuns: 13  invalidRuns: 1
invalid[0]: { runId: "run-20260521-broken-demo",
              error: "meta.json invalid JSON: Expected property name ..." }

# --all モード
[stderr]   run-20260521-broken-demo: meta.json invalid JSON: ...
```

✅ CLI は落ちず exit 0。壊れた run は table から除外され stderr 警告、`--json` では `invalidRuns[]` に分離、`--all` では理由も列挙。

## 閉じる条件チェック（Phase 2-5 設計 2-5.6）

```txt
[x] harness review list が needs_review / changes_requested を表示できる
[x] --status / --domain / --all / --json が動く
[x] cleaned はデフォルト非表示
[x] parentRunId があれば表示される（parent 列）
[x] command summary が表示される（commands 列 ok/total）
[x] secretSuspectCount / ignoredUntrackedCount が表示される
[x] 壊れた run dir で CLI が落ちない
[x] unit / integration test がある（283 PASS）
[x] docs/specs/cli.md に使い方がある
```

`--limit` は設計の close 条件には無いが追加実装・検証済み。

## 新規 finding

なし。デモ中に harness の不具合は検出されなかった（codex review の P1/P2 は実装直後に fix 済み）。

## 後片付け

- デモで作った `runs/run-20260521-broken-demo/` は削除済み
- 既存の demo run（`mpf2gzf…` changes_requested 等）は runs/ に残置（gitignore 対象）

## Deferred

- `--status` の複数値 UX（現状カンマ区切り。繰り返しフラグ対応は将来）
- run artifact の本文検索 / 全文インデックス → Phase 3（DB 導入時）
