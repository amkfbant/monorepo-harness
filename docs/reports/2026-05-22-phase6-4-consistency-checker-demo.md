# Phase 6-4 — DB consistency checker

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-4.md`（Phase 6-4 設計）
**Scope tag:** （Phase 6-4、close タグなし）

## 目的

DB（read model）と file state のズレを検出する。ダッシュボードが古い/壊れた DB を
見ていないか operator が判断できるようにする。

## 成果物

- `src/db/consistency.ts` — `checkConsistency()` → `ConsistencyReport`。
  `ConsistencyItem`（status: `ok` / `drift` / `missing-file` / `missing-db`）、
  `formatConsistencyReport()`。
- `src/db/import/runs.ts` — `runFingerprint()` を export（checker が再計算に使う）。
- `src/cli/db.ts` — `harness db check-consistency [--json]`。drift/missing で exit 1。

## 検査内容

- **runs** — DB の各 run について `runFingerprint` を再計算し `source_meta_sha256`
  と比較。run dir 不在 → `missing-file`、`runs/` に未取り込みの run → `missing-db`、
  fingerprint 不一致 → `drift`。
- **projects** — `projects` から現行 `profile_version` の `project_profiles` を
  join し、`profile_path` のファイルの sha256 を比較。`missing-db` は parse した
  `project_id` で判定（filename には依存しない）。
- **policies** — `policies/repos/<id>.yaml` の sha256 を `repo_policy_sha256` と
  比較。`.generated.json` sidecar が disk にあり DB に無ければ `missing-db`。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 2 / P2: 1。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | project 検査が `project_profiles` 全行 + filename=project_id を仮定。version 変更で false drift、filename≠project_id で false missing-file/missing-db | `projects` から現行 version を join し `profile_path` を使用。missing-db は parse した `project_id` で判定 |
| P1 | policy 検査が DB 行のみ走査し、未取り込みの sidecar を `missing-db` 報告しない | `policies/repos/*.generated.json` を走査し DB 行の有無を確認 |
| P2 | テストが policy drift/missing-db、filename≠project_id を未カバー | 該当ケースのテストを追加 |

## テスト

- `tests/unit/db/consistency.test.ts`（7 件）— import 直後 ok、run drift /
  missing-file / missing-db、filename≠project_id で false-warn しない、
  policy sidecar の missing-db、project profile drift。
- `tests/integration/cli-db.test.ts` — `check-consistency` の ok 報告、
  profile drift での exit 1。
- `npm run typecheck` green。`npm test` 692 pass / 1 skip（Phase 6-4 で +9）。

## Close 条件

- [x] DB ↔ files の drift / missing を検出できる。
- [x] ダッシュボード表示の信頼性を check できる（snapshot に status を載せる準備）。
