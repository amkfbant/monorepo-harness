# Phase 7 close レポート — DB-first write path

**日付:** 2026-05-22
**対象:** `monorepo-harness` Phase 7（DB-first write path）
**設計:** [`../superpowers/specs/2026-05-22-phase7-db-first-write-path-design.md`](../superpowers/specs/2026-05-22-phase7-db-first-write-path-design.md)
**タグ:** `phase7-close`

## 概要

Phase 7 は DB 完全移行の第 2 段階。runtime write path を DB-first 化し、DB
トランザクションを canonical な書き込み、files をその compatibility export と
した。

```txt
Phase 6（完了）: files = write-source,  DB = read-source
Phase 7（本フェーズ）: DB = write-source, files = compatibility export
Phase 8（将来）: DB complete,            file scan = migration-only
```

## サブフェーズ

| # | 内容 | コミット種別 |
|---|------|------|
| 7-0 | 設計 spec / migration invariant | docs |
| 7-1 | schema v2 / write repository skeleton | feat + fix |
| 7-2 | scoped export engine（atomic write / export 追跡） | feat + fix |
| 7-3 | `runDomainCoding` DB-first（run state / events） | feat + fix |
| 7-4 | `runDomainCoding` DB-first（diff results / manifest） | feat + fix |
| 7-5 | `review process` DB-first | feat + fix |
| 7-6 | `rerun` DB-first | feat + fix |
| 7-7 | `cleanup` DB-first | feat + fix |
| 7-8 | `backlog` DB-first | feat + fix |
| 7-9 | `knowledge` DB-first（decision state） | feat + fix |
| 7-10 | `pr create` DB-first | feat + fix |
| 7-11 | `db export-files` / import・consistency 確定 | feat + fix |
| 7-12 | fixture matrix / crash・並行性テスト | test |
| 7-13 | docs / close package | docs |

各サブフェーズは TDD 実装 → codex（gpt-5.5, xhigh）外部レビュー → P0/P1/P2
修正の作法で進めた。全サブフェーズで codex レビューの P0 はゼロ、P1/P2 は
修正コミット（`fix(...) — codex レビュー反映`）で反映済み。Phase 7 は
per-subphase のデモレポートを持たず、テスト + codex レビューで検証した。

加えて Phase 7 **全体**の横断 codex レビュー（gpt-5.5, xhigh）を実施し、
P0 ゼロ・P1×4 を `fix(runtime): Phase 7 — 全体 codex レビュー反映` で修正した:
knowledge entry の canonical 境界統一（`.md` body は file-backed、
`knowledge_entries` は read model）、knowledge decision の failed export を
`db export-files` で復旧可能に、run 系 export failure の warning surface
（`warnIfExportFailed`）、unknown `source_mode` の一貫した `SourceModeError`。

## close 条件チェック（19 項目）

- [x] 全 runtime write コマンドが DB トランザクションを canonical 書き込みとする
      — `runDomainCoding` / `review process` / `rerun` / `cleanup` / `backlog` /
      `knowledge` / `pr create`。
- [x] files が DB から export され、`db import` で正規化 round-trip する
      — `exportRun` / `exportBacklogItem` / `exportKnowledgeEntry`、import は
      db-first row を巻き戻さない。
- [x] `run_changed_files` / `policy_violations` が populate される（7-4）。
- [x] DB-first row を file-first command が直接 mutate しない guard
      — `source_mode` invariant + `SourceModeError`。
- [x] `db import --from-files` が DB-first row を stale file で上書きしない
      — runs / backlog item は skip、knowledge candidate は decision 保持、
      knowledge entry は skip、`--reset` も db-first を保持。
- [x] `export_status` / `export_records` で stale export を検出・再 export
      — `db check-consistency` の export 追跡 + `db export-files`。
- [x] scoped export が atomic write（temp + rename）を使い、partial export を
      検出できる（`.exporting` marker）。
- [x] run status transition が expected-status guard で守られている
      — `StateConflictError`。
- [x] `operation_id` idempotency ledger（`operations` テーブル + `findOperation`
      / `recordOperation`）が実装され、`RunRepository.updateRunStatus` が使用。
      他の write コマンドの再実行 idempotency は自然な冪等性で担保している
      （`pr create` = `pull_requests` の findByRun、`backlog`/`knowledge` =
      status guard の no-op、`cleanup` = status==cleaned の no-op）。各コマンドへ
      の operation_id plumbing は未実施（必要になれば追加可能）。
- [x] `pr create` が duplicate PR を作らない — `pull_requests` canonical +
      lock 内 findByRun 再確認。
- [x] cleanup は DB canonical state を削除せず、export files の削除/更新として
      扱う（`cleanup_actions`）。
- [x] artifact body / knowledge body の canonical source が明文化されている
      — `db.md`「canonical source の範囲」。
- [x] `harness db export-files`（全 export）がある（7-11）。
- [x] DB v1 → v2 migration が idempotent（`migrations-v2.test.ts`）。
- [x] 安全モデル（policy 検証 / 状態遷移 gate / review auto 境界）が不変。
- [x] crash safety / 並行性のテストがある（7-12 `phase7-scenarios.test.ts`）。
- [x] Phase 6 DB-backed dashboard が Phase 7 DB-first writes を即時に読める
      — write が即 DB commit のため `dashboard export` 再実行で最新。
- [x] 既存テストが green、typecheck green。
- [x] docs / specs 更新、`phase7-close` タグ。

## スコープ外（Phase 8 以降 / 別トラック）

- artifact body / 大型 body の DB 格納（Phase 8、`artifact_blobs`）。
- knowledge entry の markdown body は file-backed のまま（DB は read model）。
- project profile / generated policy の write path 自体の DB-first 化。
- `dashboard serve`・mutation UI。
- file export の optional 化（Phase 7 は常に export）。
- import の db_revision 不一致 conflict を `import_errors` に記録する強化
  （現状は `db check-consistency` の `exported_files.sha256` 照合で検出可能）。
- **`review auto` の DB-backed proposal 化。** `review auto`（reviewer agent）は
  `review-decision.yaml` という **operator-input の proposal file** を生成する
  補助コマンドで、DB-canonical state は書かない（status も動かさない）。
  Phase 7 の DB-first 化対象 7 コマンドには含めていない。設計書が言及する
  `review_proposals` テーブル化は Phase 8 候補。
- `pull_requests` の `UNIQUE(run_id)` 制約（現状は per-run domain lock +
  select-then-insert で担保）。schema v4 を開く Phase 8 で同梱予定。
- artifact body の manifest（`artifacts` 行）と実 file body の drift 検出。
  Phase 8 の artifact body DB 化と合わせて `check-consistency` に追加予定。

## 検証

- `npm test`: 853 passed / 1 skipped。
- `npm run typecheck`: green。
- v1 → v2 → v3 migration: idempotent。
- 既存 file-based テスト: 回帰なし（legacy-file path は不変）。

## post-close hardening

`phase7-close` タグ後に外部 zip レビューを受け、P0:0 / P1:7 / P2:4 / P3:4 の
うち受け入れた指摘を修正した（`fix(runtime): Phase 7 — 外部レビュー反映`）。
主な修正: review decision の lifecycle（rerun が DB review rows を読む、
`review-decision.yaml` を DB から export）、`pr create` の DB-first gate、
`cleanup --scope run/all` の tombstone（bulk export が復活させない）、
knowledge entry を file-derived read model に統一、`knowledge-decisions.yaml`
の export 追跡。P2-3（artifact body drift 検出）/ P2-4（`pull_requests`
`UNIQUE(run_id)`）は Phase 8 へ defer。
