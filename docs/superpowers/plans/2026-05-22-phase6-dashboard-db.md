# Phase 6 — DB Migration Foundation + Project-aware Dashboard（総合設計）

**作成日:** 2026-05-22
**対象:** Phase 5 close（`phase5-close` @ `ccdd68c`）後の `monorepo-harness`
**出典:** `tmp/phase6-dashboard-db-migration-implementation-plan.md`（外部実装計画）+
ダッシュボード方式に関する壁打ち（2026-05-22）

---

## 1. このフェーズの位置づけ

Phase 6 のユーザー意図は **「ダッシュボードの作成」**。あわせて **Phase 6 以降で
DB への完全移行**を進める方針が確定した。したがって Phase 6 は

> **DB の read-side 移行 + project-aware なダッシュボード**

とし、DB を「ダッシュボードの canonical read model」にする。write-side の DB 化
（`runDomainCoding` 等が DB へ書く）は **Phase 7 以降**に分ける。

## 2. 壁打ちで確定した方針（外部計画への 4 調整）

外部計画 `tmp/phase6-dashboard-db-migration-implementation-plan.md` を土台にしつつ、
壁打ちの結論を優先して次の 4 点を調整する。

### 調整1 — `dashboard serve` を Phase 6 コアから外す

ダッシュボードからの operation（mutation）は「可能性レベル」であり確定ではない。
壁打ちの結論は「`DashboardSnapshot` を描画する view 層は static / server で共通、
Phase 6 は静的 export で出し、serve（HTTP 層）は後から薄く足す」。
よって **Phase 6 の UI 成果物は `dashboard export`（静的 HTML）**。
`dashboard serve`（read-only GET API）は **任意 stretch**。時間が余れば Phase 6 で
着手、なければ Phase 7 へ送る（§7 参照）。

### 調整2 — Phase 6 スコープを「最小 viable」に絞る

外部計画本体は 13 サブフェーズ・19 テーブルで Phase 5 より大きい。Phase 6 は
**ダッシュボードを成果物に、DB は read-side が必要な範囲だけ**を作る。
write-side 用の足場は schema migration の後続版（Phase 7+）へ送る:

- `artifact_blobs`（artifact body の DB 格納）→ Phase 7+
- `project_check_results` + `project check --write-db` → Phase 7+
- `domain_locks`（lock の DB 化）→ Phase 7+
- write 用の完全 repository layer → Phase 7+

### 調整3 — data-source seam を明示的に残す

ダッシュボードは `DashboardDataSource` interface 越しにデータを読む。Phase 6 は
DB-backed 実装を主にするが、ダッシュボードを「DB or die」に溶接しない。
将来 serve / 別 backend に差し替えても描画コードは不変。

### 調整4 — Phase 5 整合性修正は「コード照合で確認 → 確認分を importer 前に」

外部計画 6-10 は Phase 5 の attribution バグを 6 件断定しているが、Phase 5 close
では未 surface。**6-1 で実コードと照合し、確認できたものだけ**を修正する。
importer（6-3）より前に置くことで、誤った `project_id` / `repo_id` / `domain` /
`base_branch` を DB に取り込まないようにする。

## 3. 後方互換（全フェーズ共通）

- 既存 file-based workflow（`harness run` / `review` / `cleanup` / `pr create`）は
  Phase 6 では**一切壊さない**。files は引き続き write-side の source of truth。
- DB は Phase 6 では **read model（importer で files から構築する派生）**。
  files を消しても `db import --from-files` で再構築できる。
- 既存 `policies/repos/*.yaml` / `projects/*.yaml` / `runs/` の形式は不変。
- 既存 `index.sqlite`（`src/index/run-index.ts`）は Phase 6 で deprecated。
  正式 DB `.harness/harness.sqlite` に置き換える（外部計画 §14.4）。
  `index rebuild/status/show` は deprecation warning を出すか新 DB を読む（6-5 で決定）。

## 4. source-of-truth transition

```txt
Phase 6: files = write-source,  DB = read-source（importer で構築）
Phase 7: DB = write-source,     files = compatibility export
Phase 8: DB complete,           file scan = migration-only
```

Phase 6 close 条件は「DB が read model として成立し、ダッシュボードが DB から
生成される」こと。write-side は触らない。

## 5. DB schema v1（read-side のみ）

DB file: `.harness/harness.sqlite`。SQLite + `better-sqlite3`（既存 `run-index.ts`
と同じ依存）。schema は migration version を持つ。

v1 で作るテーブル（read-side が必要とするものだけ）:

- `schema_migrations` / `db_meta` — migration metadata
- `projects` / `project_profiles` / `domains` — Project Abstraction
- `policy_generations` — 生成 policy + provenance
- `runs` — run current state（index 群つき）
- `run_events` — run lifecycle log（`events.jsonl` を取り込む append-only）
- `command_results` — allowedCommands 実行結果
- `run_changed_files` / `policy_violations` — diff 検証結果
- `review_decisions` / `review_required_changes` — レビュー結果
- `artifacts` — artifact **manifest のみ**（`storage='file'` 固定。body は持たない）
- `run_context_packs` / `run_context_pack_files` — context pack manifest
- `backlog_items` / `backlog_run_links` — backlog
- `knowledge_candidates` / `knowledge_entries` — knowledge
- `import_errors` — malformed file の記録

v1 で**作らない**（Phase 7+）: `artifact_blobs` / `project_check_results` /
`domain_locks`。schema migration があるので後続版で追加すればよい。

詳細な DDL は `phase-6-2.md`。

## 6. repository layer

DB を直接あちこちから触らない。`src/db/` に集約する。

```txt
src/db/
  connection.ts        better-sqlite3 接続 + PRAGMA（WAL 等）
  migrations.ts        migration runner（version 管理）
  schema.ts            v1 DDL 定数 + zod boundary schema
  import-files.ts      files → DB importer（idempotent / source-hash）
  consistency.ts       DB ↔ files の drift 検出
  repositories/
    runs.ts            RunRepository（list/get/timeline/chain/...）
    projects.ts        ProjectRepository
    policies.ts        PolicyRepository
    backlog.ts         BacklogRepository（read）
    knowledge.ts       KnowledgeRepository（read）
    artifacts.ts       ArtifactRepository（manifest read）
    dashboard.ts       DashboardRepository（snapshot 集約）
```

原則:
- SQL は repository に閉じ込める。ダッシュボードは repository だけを見る。
- DB row ↔ TypeScript type の境界は zod で検証する。
- importer は destructive ではなく upsert / replace-by-source-hash。
- ダッシュボードのデータ取得は `DashboardDataSource` interface 越し（調整3）。

## 7. 任意 stretch — `dashboard serve`

read-only の GET-only HTTP サーバ。`127.0.0.1` バインド、non-GET は 405。
`GET /api/snapshot` / `/api/runs/:id` / `/api/artifacts/:id` / `/api/db/status`。
mutation API は作らない。Phase 6 で時間が余れば着手、なければ Phase 7。
`tmp/phase6/` には専用ファイルを置かず、本 overview の本節に仕様を残す。

## 8. 実装順（推奨）

```txt
6-0   DB migration spec / dashboard spec
6-1   Phase 5 整合性修正（コード照合で確認したサブセット）
6-2   DB connection / migrations / schema v1
6-3   file importers（idempotent / source-hash / import_errors）
6-4   DB consistency checker
6-5   DB-backed run source / filters（DashboardDataSource seam）
6-6   project-aware metrics / inbox / knowledge digest / backlog（Phase 5 follow-up 回収）
6-7   DashboardSnapshot from DB（project health / provenance / drift 含む）
6-8   dashboard export（DB snapshot → 静的 HTML、Phase 6 の UI 成果物）
6-9   multi-project DB fixture matrix
6-10  docs / close package
```

各サブフェーズの作業サイクル（Phase 3/4/5 と同じ）:
1. **実装** — TDD（fail → impl → pass）。strict TS / immutability / 小さいファイル。
2. **codex レビュー** — `codex exec -m gpt-5.5 -c model_reasoning_effort='"xhigh"'
   --sandbox read-only` をバックグラウンド実行。
3. **修正** — P0/P1 は必ず、P2 は可能な範囲で。
4. **デモレポート** — `docs/reports/2026-05-22-phase6-<n>-*-demo.md`。
5. **コミット** — Conventional Commits。

## 9. Phase 6 close 条件

```txt
[ ] .harness/harness.sqlite を作成でき、schema migration が idempotent
[ ] runs/projects/policies/backlog/knowledge を files から import できる
[ ] import が source hash に基づいて idempotent（再実行で同一 state）
[ ] malformed file が import_errors として記録される
[ ] DB consistency checker が drift / missing を検出できる
[ ] DB-backed run source が project/repo/domain/status/date filter で動く
[ ] metrics/inbox/knowledge digest/backlog が project/repo filter を持つ（Phase 5 follow-up 回収）
[ ] DashboardSnapshot が DB から生成される（file scan しない）
[ ] dashboard export が DB-backed 静的 HTML を生成する
[ ] project health / policy provenance / drift が dashboard に出る
[ ] Phase 5 整合性修正（確認分）が入っている
[ ] multi-project same-domain fixture が dashboard で混線しない
[ ] 既存 file-based workflow が壊れていない（既存テスト green）
[ ] npm run typecheck / npm test が green
[ ] docs/specs/reports が更新されている
[ ] phase6-close タグ
```

## 10. Phase 7+ への接続

- **Phase 7** — DB-first write path（`runDomainCoding` 等が DB へトランザクション
  書き込み。files は compatibility export）。`artifact_blobs` 追加。
- **Phase 8** — complete DB mode（`--storage db`、file export optional、
  `db backup/restore`）。
- **operation 確定時** — mutation API（POST、既存 core op の薄いラッパ、CSRF + 監査）。

これらは Phase 6 では非ゴール。schema/repository を additive に拡張できる形で残す。
