# Phase 4-8 — Static HTML Export 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-8-dashboard-export.md`（Phase 4-8 設計）
**Harness range:** Phase 4-8 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase4`

## 背景

Web dashboard（Phase 5）の前段として、server 不要・read-only な静的 HTML レポートを出す。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/dashboard.ts`（新規） | `buildDashboardHtml` / `exportDashboard` |
| `src/cli/run.ts` | `harness dashboard export` |

**484 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0/P1 なし。P2×1、same-cycle fix:

| # | 概要 | 修正 |
|---|------|------|
| 1 | `runLink` が `../../runs/<id>/` を固定生成 — `--out` で別の場所へ出力すると run link が壊れる | `exportDashboard` が `relative(dirname(outPath), runsDir)` で href prefix を計算し `buildDashboardHtml` に渡す。`runId` は `encodeURIComponent` → `esc()` の二段 |

## 実機デモ — E4-8（既存 runs/）

```
$ harness dashboard export
dashboard exported: docs/dashboard/index.html (9475 bytes)
```

検証:
- `<!doctype html>` で始まる自己完結ページ。`<script>` / 外部 `src=`・`href="http` を含まない（read-only・server 不要）
- セクション: **Metrics** / **Inbox**（needs_review・changes_requested・failed・cleanup・knowledge）/ **Recent runs** / **Knowledge**
- 各 run は `../../runs/<runId>/` への相対リンク（run dir の artifact へ辿れる）
- domain 等の補間値は HTML エスケープ（`apps/<script>x` → `apps/&lt;script&gt;x`、unit test で担保）
- `--out` で出力先を変えると run link prefix が追従（`<root>/reports/` 出力なら `../runs/`、unit test で担保）

生成された `docs/dashboard/index.html` を成果例としてリポジトリにコミット（ユーザー承認済み）。

## 閉じる条件チェック（Phase 4-8 設計 4-8.4）

```txt
[x] static HTML を生成できる        — dashboard export
[x] server不要                      — JS なし・外部アセットなしの自己完結ページ
[x] read-only                       — 表示のみ、操作要素なし
[x] run detail へリンクできる        — 各 run → ../../runs/<id>/ 相対リンク
[x] docs に dashboard export がある   — cli.md「dashboard export」節
```

## 新規 finding

なし。codex review の P2×1 は実装直後に fix 済み。
