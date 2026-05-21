# Phase 6 close — DB Migration Foundation + Project-aware Dashboard

**Date:** 2026-05-22
**Scope tag:** `phase6-close`
**前提:** Phase 5 close（`phase5-close` @ `ccdd68c`）

## サマリ

Phase 6 は DB 完全移行の第一歩。`.harness/harness.sqlite` を **read model**
（files から構築する派生）として導入し、ダッシュボードを DB-backed・project-aware
に刷新した。files は引き続き write-side の source of truth で、既存 workflow は不変。

外部実装計画（`tmp/phase6-dashboard-db-migration-implementation-plan.md`）を土台に、
壁打ちの 4 調整（`dashboard serve` を Phase 6 コアから外す / スコープを最小 viable
に絞る / `DashboardDataSource` seam を残す / Phase 5 整合性修正を importer 前に）を
反映して実装した。

## source-of-truth transition の現在地

```txt
Phase 6（完了）: files = write-source,  DB = read-source（importer で構築）
Phase 7（予定）: DB = write-source,     files = compatibility export
Phase 8（予定）: DB complete,           file scan = migration-only
```

Phase 6 は **read-side のみ**。`harness run` / `review` / `cleanup` / `pr create`
は従来どおり file へ書く。

## サブフェーズと成果

| Phase | 成果 | コミット |
|-------|------|---------|
| 6-0 | DB / dashboard spec skeleton | `b51b38a` |
| 6-1 | Phase 5 attribution 整合性修正（rerun の project 再解決 等 5 件） | `fa5e42f` |
| 6-2 | DB connection / migrations / schema v1（20 テーブル） | `f37bdd1` |
| 6-3 | file importers（idempotent、`import_errors`、`db import`） | `c52d5fe` |
| 6-4 | consistency checker（`db check-consistency`） | `8e941bb` |
| 6-5 | DB-backed run repository / filters / `DashboardDataSource` seam | `9d61180` |
| 6-6 | project-aware metrics / inbox / digest / backlog（Phase 5 follow-up 回収） | `b134296` |
| 6-7 | `DashboardSnapshot` from DB | `ace3a2d` |
| 6-8 | DB-backed 静的 dashboard export（Phase 6 の UI 成果物） | `0593ef4` |
| 6-9 | multi-project DB fixture matrix | `beeac3d` |
| 6-10 | docs / close package | （本コミット） |

各サブフェーズで codex gpt-5.5 xhigh の外部レビュー → 修正 → デモレポート →
コミットを実施。**P0 は全サブフェーズでゼロ**、P1/P2 は全件対応済み。

## import / consistency

- `db import --from-files` は idempotent: run は全 source file（meta + events +
  review-decision + context-pack-manifest + artifact 一覧）の fingerprint で skip、
  projects / backlog のタイムスタンプは source mtime 由来。
- malformed file は `import_errors` に記録され、import 全体は止まらない。
- `db check-consistency` が runs（fingerprint）/ projects（profile hash）/
  policies（repo policy hash + sidecar）の drift / missing-file / missing-db を検出。

## dashboard

- `dashboard export` は `DashboardSnapshot`（DB から構築）を自己完結 HTML に描画。
  file scan をしない。status banner / Overview / Projects / Inbox / Recent runs /
  Backlog / Knowledge。`--project` / `--repo-id` で scope、DB 不在時は auto-import。
- `dashboard serve`（read-only HTTP サーバ）は Phase 6 では**未実装**（follow-up）。

## テスト

- Phase 5 close 時点 651 pass / 1 skip → **Phase 6 close 時点 729 pass / 1 skip**
  （Phase 6 で +78）。
- `npm run typecheck` green。既存 file-based workflow のテストはすべて green
  （後方互換）。

## §9 close checklist

```txt
[x] .harness/harness.sqlite を作成でき、schema migration が idempotent
[x] runs/projects/policies/backlog/knowledge を files から import できる
[x] import が source hash に基づいて idempotent
[x] malformed file が import_errors として記録される
[x] DB consistency checker が drift / missing を検出できる
[x] DB-backed run source が project/repo/domain/status/date filter で動く
[x] metrics/inbox/knowledge digest/backlog が project/repo filter を持つ
[x] DashboardSnapshot が DB から生成される（file scan しない）
[x] dashboard export が DB-backed 静的 HTML を生成する
[x] project health / policy provenance / drift が dashboard に出る
[x] Phase 5 整合性修正（確認分）が入っている
[x] multi-project same-domain fixture が dashboard で混線しない
[x] 既存 file-based workflow が壊れていない（既存テスト green）
[x] npm run typecheck / npm test が green
[x] docs/specs/reports が更新されている
[x] phase6-close タグ — 本 close コミットに付与する
```

## known limitations / follow-up（Phase 7 以降）

- **write-side の DB 化** — `runDomainCoding` 等が DB へトランザクション書き込み、
  files は compatibility export（Phase 7）。
- **`run_changed_files` / `policy_violations`** — schema v1 にテーブルはあるが
  Phase 6 importer では未 populate（diff/artifact 解析が必要）。ダッシュボードは
  scalar の `runs.changed_files_count` を使う。Phase 7 で populate。
- **artifact body の DB 格納** — Phase 6 は manifest のみ（`storage='file'`）。
  `artifact_blobs` テーブルは Phase 7 の migration で追加。
- **`dashboard serve`** — read-only HTTP サーバは未実装。Phase 7 候補。
- **ダッシュボードからの操作（mutation）** — 非ゴール。導入する場合は既存 core
  オペレーションの薄いラッパとして別フェーズで。
- **`project_check_results` テーブル / `project check --write-db`** — Phase 7+。
- **promoted knowledge の project namespace** — `knowledge_entries` の project
  属性は frontmatter 依存（Phase 5 から継続の follow-up）。`knowledgeDigest` の
  `entryTotal` は global count。

## Phase 7 への接続

Phase 7（DB-first write path）は本 Phase の schema / repository / importer を
土台に、write path を DB トランザクション化する。schema migration runner と
`harness db import`（長期互換機能）はそのまま使える。
