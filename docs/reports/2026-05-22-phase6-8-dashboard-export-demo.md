# Phase 6-8 — DB-backed static dashboard export

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-8.md`（Phase 6-8 設計）
**Scope tag:** （Phase 6-8、close タグなし）

## 目的

`DashboardSnapshot` を静的 HTML に描画する。**Phase 6 の UI 成果物**。

## 成果物

- `src/dashboard/render.ts`（新規）— `renderDashboardHtml(snapshot)`。サーバ
  不要・JS なし・外部アセットなしの自己完結 HTML。status banner / overview /
  projects / inbox / recent runs / backlog / knowledge の各 section。HTML escape。
- `src/dashboard/export.ts`（新規）— `exportDashboard()`。`loadDashboardSnapshot`
  で snapshot を構築 → render → ファイル書き込み。`{ outPath, bytes, snapshot }`。
- `src/core/dashboard.ts`（削除）— Phase 4-8 の file-scan 版を置き換え。
- `src/cli/run.ts` — `dashboard export` に `--project` / `--repo-id` /
  `--no-auto-import`。`DashboardSnapshotError` を exit 1 にマップ。

## 設計

- ダッシュボードは file scan をせず `DashboardSnapshot` のみから描画。
- `dashboard export` のコマンド名・既定出力先（`docs/dashboard/index.html`）は不変。
- DB 不在時は既定で auto-import。`--no-auto-import` で抑止。
- `serve` は Phase 6 では非実装（任意 stretch / Phase 7。close レポート参照）。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 0 / P2: 1。対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P2 | escaping テストが unsafe な値を seed しておらず、escape regression を見逃す | markup 入りの `DashboardSnapshot` を直接 `renderDashboardHtml` に渡す unit テストを追加 |

レビューは「全 interpolated 値が escape 済み、自己完結 page、`core/dashboard.ts`
の dangling importer なし、`--no-auto-import` mapping 正しい、単一 `render.ts` は
この規模では妥当」と確認。

## テスト

- `tests/integration/dashboard.test.ts`（書き換え、5 件）— export の HTML 生成、
  project filter、`--no-auto-import` での error、CLI smoke。
- `tests/unit/dashboard/render.test.ts`（新規、2 件）— 全 snapshot 値の HTML
  escape、自己完結 page。
- `npm run typecheck` green。`npm test` 722 pass / 1 skip。

## Close 条件

- [x] `dashboard export` が DB-backed 静的 HTML を生成する。
- [x] file scan していない。
- [x] project/repo filter が効く。
- [x] HTML 生成がモジュール分割されている（`src/dashboard/{render,export,snapshot,data-source}.ts`）。
