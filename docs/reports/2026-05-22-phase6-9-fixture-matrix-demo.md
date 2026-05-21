# Phase 6-9 — Multi-project DB fixture matrix

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-9.md`（Phase 6-9 設計）
**Scope tag:** （Phase 6-9、close タグなし）

## 目的

DB import + ダッシュボードが複数 project / legacy / 異常系で正しく動くことを保証。

## 成果物

`tests/integration/db-fixture-matrix.test.ts`（7 件）— 1 つの harness root に
DB read model を stress するケースを集約:

- 同一 domain id `apps/catalog` を持つ 2 project（`mini-commerce` /
  `web-app`）。`web-app` は `project_id` ≠ `repo.id`（`web-shop`）で
  project/repo filter conflation を検出。
- 生成 repo policy + provenance sidecar。
- run ごとの knowledge candidate。
- legacy `--repo-id` run（`project_id` = NULL）。
- malformed run（`import_errors`）。
- import 後に drift する profile / generated policy。

## 検証

- import: projects 2 / runs 3 / policies 1 / errors 1。
- 同一 domain が project filter で分離、`domains` に project_id 別の 2 行。
- `repoId: web-app`（project_id を repo として誤用）→ 0 件。
- legacy run は repo filter で包含、project filter で除外。
- consistency が profile drift と generated policy drift を両方検出。
- `DashboardSnapshot` の per-project domainCount / runCount / hasGeneratedPolicy。
- knowledge / inbox aggregate が project scope で正しく絞られる。
- `dashboard export` が matrix 全体と単一 project の両方で動く。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 1 / P2: 3。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | 両 project とも `project_id` = `repo_id` で、project/repo filter conflation を検出できない | `web-app` の `repo.id` を `web-shop` にし、`repoId: web-app` が 0 件になる assertion を追加 |
| P2 | `domains` 行の分離を assert していない | project_id 別の 2 `domains` 行、project summary の domainCount/runCount を assert |
| P2 | 生成 policy の import/drift が未カバー | generated policy fixture を追加、`policies` count / `hasGeneratedPolicy` / policy drift を検証 |
| P2 | scoped な dashboard assertion が run 数のみで浅い | run ごとの knowledge candidate を追加し、all vs scoped の `candidateTotal` / `knowledgeCandidateRuns` を assert |

## テスト

- `npm run typecheck` green。`npm test` 729 pass / 1 skip（Phase 6-9 で +7）。

## Close 条件

- [x] 複数 project / legacy / malformed / drift / 生成 policy で import → snapshot
  → export が通る。
- [x] same-domain がダッシュボードで混線しない。
- [x] malformed / drift が正しく検出・表示される。
