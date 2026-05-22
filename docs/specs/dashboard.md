# Dashboard

**Phase 6 で刷新。** Phase 4-8 のダッシュボードは `runs/` を直接 scan する静的
HTML エクスポートだった。Phase 6 では **DB（[`db.md`](./db.md)）を read model と
する project-aware なダッシュボード**にする。

実装: `src/dashboard/`。

> **ステータス: Phase 6 close 済み（現状仕様）。** ダッシュボードは
> `src/dashboard/` に実装済み。`DashboardSnapshot` の確定値は
> `src/dashboard/snapshot.ts`、CLI は [`cli.md`](./cli.md) の `harness dashboard` 節。

## 設計原則

- **DB-backed** — ダッシュボードは file scan をせず、DB から `DashboardSnapshot`
  を組み立てる。データ取得は `DashboardDataSource` interface 越し（将来の backend
  差し替えに備える seam）。
- **read-only** — ダッシュボードは観測専用。状態を変える操作（mutation）は持た
  ない。状態遷移は従来どおり CLI コマンドの guard 経由でのみ行う。
- **project-aware** — `--project` / `--repo-id` で filter できる。同一 domain id
  を持つ別 project が混線しない。

## DashboardSnapshot

ダッシュボードの source of truth は、DB から生成する 1 つの `DashboardSnapshot`
オブジェクト。確定形は実装後の `src/dashboard/snapshot.ts` を参照。主な内容:

- `generatedAt` / `dbPath` / `dbSchemaVersion`
- `importStatus` — 最終 import の時刻・件数
- `consistencyStatus` — `ok` / `warn` / `error`（[`db.md`](./db.md) の checker）
- `filters` — 適用中の project / repo（`DashboardFilters` は project / repo のみ）
- `projects` — project ごとの health / policy provenance / drift
- `overview` — run / review / retry / safety 指標
- `inbox` — needs_review / changes_requested / failed / cleanup / knowledge
- `recentRuns` — filter 済みの run 一覧
- `backlog` / `knowledge`
- `warnings` — stale DB / drift / import error 等

## export（Phase 6 の UI 成果物）

```bash
harness dashboard export [--out <path>] [--project <id>] [--repo-id <id>] [--no-auto-import]
```

`DashboardSnapshot` を自己完結の静的 HTML に描画する（既定出力先
`docs/dashboard/index.html`）。サーバ不要・依存ゼロでブラウザから直接開ける。

DB が無いときは既定で `db import --from-files` 相当を一度実行してから export し、
その旨を出力に明示する。`--no-auto-import` で抑止できる（CI 用）。

## serve（別トラック・未実装）

`dashboard serve`（read-only の GET-only HTTP サーバ）は**未実装**。現状の UI
成果物は静的 `dashboard export`。`dashboard serve` は Phase 7（DB-first write
path）のスコープ外（runtime write path に限定）で、別トラック扱い。Phase 7 で
DB-first 化された write は即時 read model に反映されるため、`dashboard export`
を再実行すれば最新状態が出力される。

ダッシュボードからの mutation（操作実行）は Phase 6 の非ゴール。導入する場合は
既存 core オペレーションの薄いラッパとして別フェーズで追加する。

## CLI

CLI の確定仕様は [`cli.md`](./cli.md) の `harness dashboard` 節を参照。
