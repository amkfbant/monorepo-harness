# Phase 7 — DB-first write path 設計

**作成日:** 2026-05-22
**対象:** Phase 6 close（`phase6-close` @ `d4dbfc8`）後の `monorepo-harness`
**ステータス:** 設計（brainstorming 承認済み）。実装計画は別途。

## Context — なぜこの変更をするか

Phase 6 で DB（`.harness/harness.sqlite`）を **read model** として導入した。
現状は files（`runs/` / `projects/` / `policies/` / `backlog/` / `docs/knowledge/`）
が write-side の source of truth で、DB は `harness db import --from-files` で
files から構築する派生キャッシュにすぎない。

DB 完全移行の 3 段階移行表:

```txt
Phase 6（完了）: files = write-source,  DB = read-source（importer で構築）
Phase 7（本設計）: DB = write-source,    files = compatibility export
Phase 8（将来）: DB complete,            file scan = migration-only
```

Phase 7 は **write-side を DB-first にする**。write コマンドが DB へ
トランザクション書き込みし、files は DB から導出される compatibility export に
なる。これにより read/write 両方の source of truth が DB に一本化され、Phase 8
（artifact body の DB 格納・file export optional 化）の土台になる。

## Goal

`runDomainCoding` / `review process` / `review auto` / `rerun` / `cleanup` /
`backlog` / `knowledge` / `pr create` の各 write コマンドを、DB トランザクションを
canonical な書き込みとし、files をその export とする形に移行する。既存の安全
モデル（policy 検証・状態遷移 gate）と観測挙動は変えない。

## 確定した設計判断（brainstorming）

1. **スコープ = DB-first write path のみ。** `dashboard serve` / mutation UI /
   read model の小粒 follow-up は別トラック。
2. **files は DB commit 後に即 export。** 各 write コマンドが DB トランザクション
   確定の直後に、影響した files を DB から書き出す。files は常に最新の
   compatibility export。
3. **`runs` は直接 UPDATE + event 追記。** write コマンドが各 stage で `runs` 行を
   直接 UPDATE し、あわせて `run_events` に append。full event-sourcing は採らない
   （`runs` は projection ではなく current state のまま）。
4. **実装アプローチ = 案 A。** Phase 6 の read repository に write メソッドを足し、
   コマンドごとに「DB-write → export」へ段階移行する。

## アーキテクチャ

### write+export パターン（コア単位）

移行された各 write コマンドは次の形をとる:

```txt
openDb(read-write)
  → db.transaction(() => { repository の write メソッド群 })
  → commit
  → exportFiles(db, 影響した id 群)
  → close
```

- **DB トランザクションが atomic 単位。** runs 行の UPDATE、`run_events` への
  append、child 行（command_results / changed_files / violations / review）を
  1 トランザクションで確定する。
- **`exportFiles` は DB 行を読み戻して file artifact を書く。** 既存の file 書き込み
  コード（`run-log.ts` の meta.json/events.jsonl 出力、`reporter/` の各 artifact、
  `backlog.ts` の yaml 出力等）を「export ステップ」として再利用する。供給元が
  in-memory state から DB 行に変わるだけ。
- **export 失敗は rollback しない。** commit 済みの DB が canonical で正しい。
  export が失敗しても files が stale になるだけで、`db check-consistency` と
  再 export で回復できる（warning 扱い）。

### トランザクション粒度と crash safety

`runDomainCoding` は codex exec で数分かかるため **1 トランザクションにしない**。
現行の「stage ごとの `meta.json` 逐次更新」と同じく、**stage ごとに短い
トランザクション + export** を行う:

| stage | DB トランザクション | export |
|-------|------|--------|
| run 作成 | `runs` 行 insert（status=in-progress）+ `run_started` event | meta.json / events.jsonl |
| codex 完了 | status / safety 更新 + event | meta.json / events.jsonl / codex-*.log |
| diff 検証 | changed_files / violations / safety_status + event | meta.json / final-diff.patch 等 |
| finalize | 最終 status / commandResults + `run_completed` event | meta.json / summary.md / review-decision.yaml 等 |

- codex exec をまたぐトランザクションは無い → SQLite single-writer の競合は
  各 stage の短い書き込みに限定される。
- crash 時は最後に commit した stage で `runs` 行が止まる。現行の部分
  `meta.json` と同じ観測挙動で、`maintenance` の orphan 検出もそのまま効く。

### write repository 層

Phase 6 の read repository（`src/db/repositories/`）に write メソッドを追加する
（read+write を 1 entity 1 repository に集約。SQL は repository のまま集約）。

- `RunRepository` — `insertRun` / `updateRunStage` / `appendEvents` /
  `upsertCommandResults` / `upsertChangedFiles` / `upsertViolations` /
  `upsertReviewDecision`。
- `BacklogRepository` — `insertItem` / `updateItemStatus` / `linkRun` 等。
- `KnowledgeRepository` — `insertEntry` / `setCandidateDecision` 等。

コマンド（が使う state writer）は 1 つの `db.transaction(...)` でこれらを呼ぶ。

### export 層

- `src/db/export-files.ts` — `import-files.ts` の逆。DB と影響 id（runId /
  projectId / itemId）を渡すと、その範囲の file artifact を書く。コマンドは
  **影響範囲だけの scoped export** を呼ぶ。
- CLI `harness db export-files`（全 export）を追加。Phase 8 が必要とするが、
  Phase 7 で導入し full export の経路を確立する。

### `run_changed_files` / `policy_violations`

Phase 6 で「file import から取れない」として繰り延べた 2 テーブルは、Phase 7 で
`runDomainCoding` 自身が changed-files / violations を in-memory に持っているため
DB へ直接書ける。**`runDomainCoding` の移行でこの read-side の穴が自然に閉じる。**

## 安全モデルは不変（最重要）

Phase 7 が変えるのは state の**保存先**（file → DB）だけで、**何が state 遷移を
gate するかは一切変えない**:

- 事後 `git diff` policy 検証は `runDomainCoding` 内でそのまま実行する。検証結果の
  保存先が `meta.json` → `runs` 行に変わるだけ。
- `approved` / `changes_requested` / `rejected` への遷移は引き続き
  `review process` のみが行う。LLM の出力が状態を動かさない原則も不変。
- run の最終 status は `needs_review` / `failed-*` で確定する規則も不変。

## スコープ外（Phase 8 以降）

- **artifact body の DB 格納**（`artifact_blobs` / `--storage db`）— 移行表どおり
  Phase 8。Phase 7 は artifact を file-backed のまま（manifest は DB）。
- **file export の optional 化** — Phase 8。Phase 7 は常に export する。
- **`domain_locks` テーブル** — locks は write path と直交する並行制御。Phase 7 は
  file lock を維持する（スコープとリスクを増やさない）。Phase 8 候補。
- **`dashboard serve` / dashboard からの mutation** — 別トラック。

## 移行中の整合性

- `db import --from-files` は Phase 7 中も動く（旧 file-only run、未移行コマンド用）。
- DB-first 化したコマンドの run は DB canonical。export された files から
  `import` し直しても idempotent で同結果なので、`import` と DB-first は共存する。
- `db check-consistency` の意味は「export された files が DB と乖離していないか」へ
  微変する。検査ロジック（file hash 再計算 vs DB）はそのまま使える。
- リスク緩和: DB-first 完了後も files は full record として export 済み →
  万一 DB に問題が出ても files から再構築できる。

## 移行順（サブフェーズ）

```txt
7-0  spec / write+export パターン / repository write メソッド skeleton
7-1  runDomainCoding を DB-first 化（最大。run_changed_files/policy_violations も閉じる）
7-2  review process / review auto を DB-first 化
7-3  rerun を DB-first 化
7-4  cleanup を DB-first 化
7-5  backlog（add/run/done/defer）を DB-first 化
7-6  knowledge（promote/reject）を DB-first 化
7-7  pr create を DB-first 化
7-8  db export-files（全 export）+ import/consistency の位置づけ整理
7-9  docs / close package
```

files が常時 export されるので、未移行コマンドは export 済み files で動き続ける
（段階移行の橋渡し）。順序は実装計画で微調整可。

## テスト

各移行コマンドで次を検証する:

- DB 行（runs / events / child）がコマンド後に正しい。
- export された files が DB 行と一致する。
- その files の `db import --from-files` が round-trip する（DB → files → DB が同一）。
- crash safety: run の途中 stage で停止しても `runs` 行が sane。
- 並行性: 複数 run を並行実行しても短トランザクションで DB が壊れない。
- 既存 file-based テストの回帰なし（移行済みコマンドの観測挙動が不変）。

## close 条件（暫定）

- [ ] 全 write コマンドが DB トランザクションを canonical 書き込みとする。
- [ ] files が DB から export され、`db import` で round-trip する。
- [ ] `run_changed_files` / `policy_violations` が populate される。
- [ ] `harness db export-files`（全 export）がある。
- [ ] 安全モデル（policy 検証 / 状態遷移 gate）が不変。
- [ ] crash safety / 並行性のテストがある。
- [ ] 既存テストが green、typecheck green。
- [ ] docs / specs 更新、`phase7-close` タグ。
