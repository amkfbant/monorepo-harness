# Phase 4-7 — Session Planning 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-7-session-planning.md`（Phase 4-7 設計）
**Harness range:** Phase 4-7 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase4`

## 背景

今日何をすべきかをルールベース順序で提案する。inbox（runs）と backlog を統合し、**提案のみで何も実行しない**。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/session.ts`（新規） | `buildSessionPlan` / `formatSessionPlan` / `formatSessionSummary` |
| `src/cli/run.ts` | `harness session plan / start / summary` |

順序ルール: `failed-*` → `needs_review` → `changes_requested` → cleanup → backlog（priority 高い順）。**477 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1×1 + P2×1、全件 same-cycle fix:

| # | severity | 概要 | 修正 |
|---|----------|------|------|
| 1 | P1 | `loadAllRuns` が SQLite index を無条件優先 → stale index で新規 failed/needs_review run が plan から落ち、最悪「Nothing to do」誤表示 | `loadAllRuns` に freshness チェック — index 行数が `runs/` の dir 数と一致する時のみ index 使用、add/remove があれば file scan |
| 2 | P2 | 空 plan の文言が「inbox and backlog are clear」だが knowledge は plan に含まれない | 文言を「No session-plan items (failed/needs_review/.../backlog all clear)」に修正 |

P1 の freshness チェックは inbox / metrics（同じ `loadAllRuns` 経由）にも効く。

## 実機デモ — E4-7（既存 runs/ + backlog）

### session summary

```
$ harness session summary
Session summary:
  failed:            1
  needs_review:      17
  changes_requested: 2
  cleanup pending:   3
  backlog (open):    0
  23 item(s) in the session plan.
```

### session start --limit 3

```
$ harness session start --limit 3
Session plan (suggestion only — nothing is run):
  1. [failed] run-...-mpe41lnne60d2633  — failed-policy-violation
     → harness run show --run-id run-...-mpe41lnne60d2633
  2. [needs_review] run-...  — changed=0
     → harness review auto --run-id run-...
  3. [needs_review] run-...  — changed=0
     → harness review auto --run-id run-...
  … 20 more (see 'session plan')
```

✅ failed-* を先頭に、ルール順で並ぶ。各項目に実行コマンドが付くが `session` 自体は何も起動しない（unit test「nothing is run」で担保）。`session start --limit` で先頭 N 件。

## 閉じる条件チェック（Phase 4-7 設計 4-7.4）

```txt
[x] current state から session plan を出せる   — E4-7（session plan/start）
[x] plan は実行せず提案だけ                    — session.ts は run/review/cleanup を起動しない
[x] backlog と runs を統合して見られる          — buildInbox + listItems を合成
[x] session summary が生成される               — session summary
```

## 新規 finding

なし。codex review の P1×1 + P2×1 は実装直後に fix 済み。P1（index freshness）は inbox/metrics/session すべてに効く重要な修正で、stale index が「やるべき run」を隠す事故を防ぐ。
