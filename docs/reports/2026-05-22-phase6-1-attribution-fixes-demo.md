# Phase 6-1 — Phase 5 attribution consistency fixes

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-1.md`（Phase 6-1 設計）
**Scope tag:** （Phase 6-1、close タグなし）

## 目的

DB importer（6-3）が誤った `project_id` / `repo_id` / `domain` / `base_branch` を
取り込まないよう、Phase 5 の attribution 残課題を先に直す。外部計画 6-10 が断定した
6 候補を**実コードと照合**し、確認できたものだけを修正した。

## 照合結果

| # | 候補 | 判定 | 対応 |
|---|------|------|------|
| 1 | standalone `rerun` が project profile を再解決しない | **実在** | 修正 |
| 2 | `backlog run` が item の `projectId` を使わない | **実在** | 修正 |
| 3 | `backlog run` で `baseBranch` が `"undefined"` 文字列になりうる | **実在** | 修正 |
| 4 | `--project` と `--repo-id` の混在を reject しない | **実在** | 修正 |
| 5 | `prepareProjectRun` / `project check` の repo path directory 検証なし | **実在** | 修正 |
| 6 | root-only repo で inspect/init の fallback domain がない | **feature** | 非修正 |

候補 #6 は「attribution の誤り」ではなく profile discovery の UX gap（現状は
zero candidates + 明示警告を返し、誤データは生じない）。attribution 修正を主眼と
する 6-1 の範囲外と判断し、修正しない（codex レビューもこの判断を妥当と確認）。

## 成果物

- `src/core/rerun.ts` — `RerunPrepResult` に optional `projectId`。
  `meta.project?.projectId` から populate。
- `src/cli/run.ts`:
  - `rejectProjectRepoIdMix()` helper を追加。`run` / `workflow reviewed-run` /
    `backlog run` で `--project` + `--repo-id` 混在を reject（`--repo` override は許容）。
  - `rerun` action — 親が project run なら `prepareProjectRun()` で profile を
    再解決し、compiled policy / context pack / `meta.project` を子へ引き継ぐ。
    親の `meta.repoPath` を `repoOverride` として渡す（profile に `repo.path` が
    無い場合への対応）。`prepared.repoId !== prep.repoId` は attribution drift
    として reject。
  - `backlog run` — `--repo`/`--repo-id` を required から外し、item の
    `projectId` で project / repo-id mode を選択。`--base-branch` は指定時のみ転送。
- `src/project/run-project.ts` — `prepareProjectRun()` が repo path の
  directory 検証（非ディレクトリは `ProjectError`）。
- `src/project/checker.ts` — `checkRepo()` が非ディレクトリを error 報告。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 1 / P2: 0。対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | rerun の project 再解決が親の `repoPath` を引き継がず、`--repo` override 付き run の rerun が失敗または別 repo を対象にしうる | 親 `meta.repoPath` を `repoOverride` として `prepareProjectRun` に渡し、`repoId` drift を reject。project-parent rerun の統合テストを追加 |

## テスト

- `tests/unit/core/rerun.test.ts` — `projectId` の propagate（project run / 非 project run）。
- `tests/unit/project/checker.test.ts` — repo path がファイルのとき error。
- `tests/integration/cli-run-project-dry-run.test.ts` — `--project`+`--repo-id`
  混在 reject、非ディレクトリ repo path エラー。
- `tests/integration/cli-backlog-run.test.ts`（新規）— project item の `--repo-id`
  reject、非 project item の `--repo`+`--repo-id` 必須。
- `tests/integration/cli-rerun.test.ts` — project-parent の rerun が profile を
  parent の `repoPath` override で再解決し、子 meta が project 帰属を保持。
- `npm run typecheck` green。`npm test` 659 pass / 1 skip（Phase 6-1 で +8）。

## Close 条件

- [x] 6 候補すべてをコード照合し、結果を記録。
- [x] 確認できたバグ（#1〜#5）は修正済み + 回帰テストあり。
- [x] run / rerun / backlog run で project attribution が一貫する。
