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
- **read-only が既定** — `export` および `serve` は既定で観測専用。状態遷移は
  従来どおり CLI コマンドの guard 経由でのみ行う。`serve --enable-mutation`
  （Phase 13）でのみ POST mutation route を有効化でき、その場合も既存 core
  オペレーションの薄いラッパとして同じ guard を通す（bearer token + CSRF 必須）。
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
- `overview` — run / review / retry / safety 指標。`DbMetricsSummary` の
  `oneShotApprovalRate` / `policyViolationRate` / `secretSuspectRate` を含む。
  D1 KPI の式は [`cli.md`](./cli.md) の `harness metrics` 節を正規定義とし、
  dashboard snapshot でも同じ定義を使う
- `usage` — `DbTokenUsageSummary`。scope 内 `run_usage` の件数、`exact` 行だけの
  token 合算、`usage_source` 別件数。式は [`cli.md`](./cli.md) の
  `harness metrics` 節を正規定義とし、dashboard snapshot でも同じ定義を使う
- `metricsTrend` — 直近 30 件までの `metrics_snapshots` から作る軽量 trend。
  各点は `{ createdAt, totalRuns, approvedRate, totalTokens }` で、適用中の
  project / repo filter に従う。snapshot は導出値なので、trend は表示専用であり
  状態遷移や判定には使わない。未知の `payload_schema` / payload schema は
  fail-open でその点を除外する。
- `hitchMetrics` — `DbHitchMetricsSummary`（hitch session / review cycle /
  rerun attempt / finding resolution KPI）
- `mcpConfirmations` — `DbMcpConfirmationSummary`（confirmation request status
  と confirmation / expired rate）。snapshot 内では project / repo filter 非適用の
  global 値（`mcp_confirmation_requests` は project 列を持たない）で、dashboard の
  filter は伝播しない。`confirmationRate` は
  `(confirmed + consumed) / (confirmed + consumed + rejected + expired)`、
  `expiredRate` は
  `expired / (confirmed + consumed + rejected + expired)`。分母 0 の場合はいずれも
  `null`。stored `pending` かつ `expires_at <= snapshot 時刻` の request は
  read-only に effective `expired` として集計し、DB は更新しない。
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
HTML は `metricsTrend` を最小テーブル（created / runs / approved rate /
total tokens）として表示する。グラフ描画ライブラリは使わない。

DB が無いときは既定で `db import --from-files` 相当を一度実行してから export し、
その旨を出力に明示する。`--no-auto-import` で抑止できる（CI 用）。

## serve（実装済み: Phase 12 read-only / Phase 13 mutation / Phase 14 asset reads）

```bash
harness dashboard serve [--host <host>] [--port <port>] [--token-env <ENV>] \
  [--cors-origin <origin>] [--no-artifact-body] \
  [--max-inline-artifact-bytes <n>] [--enable-mutation]
```

`dashboard serve` は DB を read model とする HTTP サーバを起動する（実装:
`src/dashboard/server/server.ts`）。既定は `127.0.0.1:8787`、GET / HEAD のみを
受け付ける read-only サーバ。`GET /` は live HTML ダッシュボード（`export` と
同じスナップショットをサーバ上で都度生成）、`/api/*` は JSON を返す。

DB-first 化された write は即時この read model に反映されるため、`export` と異なり
再生成手順は不要。`export` は依存ゼロの静的成果物、`serve` は常時最新の動的 UI と
いう住み分け。

### Read endpoints（GET, Phase 12 / 14）

| Path | 内容 |
|------|------|
| `GET /` | live HTML ダッシュボード |
| `GET /api/health` | `ok` / schema_version 等の health |
| `GET /api/snapshot` | `DashboardSnapshot` 全体 |
| `GET /api/runs` / `GET /api/runs/:runId` | run 一覧 / 単体 |
| `GET /api/runs/:runId/timeline` | run の timeline |
| `GET /api/runs/:runId/artifacts` | run の artifact 一覧 |
| `GET /api/runs/:runId/review` | run の review 状態 |
| `GET /api/review/proposals` / `consensus` / `reviewers` | review governance |
| `GET /api/artifacts/:artifactIdB64` | artifact メタ（id は base64url） |
| `GET /api/artifacts/:artifactIdB64/body` | artifact 本体（`--no-artifact-body` で無効化、`--max-inline-artifact-bytes` で上限） |
| `GET /api/db/status` / `stats` / `consistency` | DB 状態 |
| `GET /api/locks` | runtime lock |
| `GET /api/operations` / `GET /api/operations/:operationId` | operation audit（Phase 13） |
| `GET /api/assets/exports` / `projects` / `policies` / `knowledge`（および `:id` 系の詳細） | human-authored asset の health / revision（Phase 14） |
| `GET /api/storage/blobs` / `GET /api/archives` / `GET /api/doctor/latest` | infrastructure 系 read（Phase 15/16） |

### Mutation endpoints（POST, Phase 13 — `--enable-mutation` 時のみ）

既定では POST は `405`。`--enable-mutation` を渡したときだけ以下が wire され、
いずれも既存 core オペレーションの guard を通る。

| Path | 操作 |
|------|------|
| `POST /api/runs/:runId/review` | review 判定の記録 |
| `POST /api/runs/:runId/cleanup` | cleanup |
| `POST /api/runs/:runId/pr` | PR 作成 |
| `POST /api/runs/:runId/rerun` | rerun |
| `POST /api/backlog/:itemId/run` | backlog item の実行 |

### Auth / CSRF / security headers

認証の運用詳細は [`../ops/setup-and-secrets.md`](../ops/setup-and-secrets.md) の
「Dashboard server auth」節を参照。仕様の要点のみ:

- **Bearer token** — `--token-env <ENV>` で env var からトークンを読む。設定時は
  全リクエストに `Authorization: Bearer <token>` が必要（定数時間比較）。read-only
  かつ localhost bind で未設定なら認証はスキップ（operator UX）。非ローカル bind で
  未設定の場合は fail-closed で `401`。
- **`--enable-mutation`** — POST route を有効化する。bearer token が**必須**で、
  未設定なら起動時に fail-fast。さらに boot 時に **CSRF token** を生成して一度だけ
  stdout に出力し、live HTML の `<meta name="harness-csrf-token">` に埋め込む。
  ブラウザからの POST は `X-CSRF-Token` ヘッダでそれを送る必要がある（不一致は `403`）。
- **security headers** — 全レスポンスに `X-Content-Type-Options: nosniff` /
  `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`。`--cors-origin <origin>`
  指定時のみ `Access-Control-Allow-Origin` を返す。

### Mutation UI（Phase 4 — `--enable-mutation` 時のみ）

`--enable-mutation` 時、`GET /` の live HTML に **mutation UI** を描画する
（`src/dashboard/render.ts` の `renderDashboardHtml(snapshot, { mutation:
{ csrfToken } })`）。read-only（既定 / static `export`）では UI・JS・CSRF meta を
一切出さない（`renderDashboardHtml(snapshot)`）。

- **構成**: CSRF meta タグ + bearer token 入力 + dry-run トグル（既定 ON）+ 各 run の
  操作ボタン（needs_review は review approve/changes_requested/rejected、全 run に
  pr / rerun / cleanup）+ backlog item の run ボタン + 結果表示領域 + inline JS。
- **送信**: inline JS が `fetch` で各 POST route に送る。header は CSRF meta から読む
  `X-CSRF-Token`、入力欄の bearer を `Authorization: Bearer`、非 dry-run 時は
  `Idempotency-Key`（UUID）。
- **誤操作防止**: 破壊的操作（cleanup / pr / rerun / backlog run）は非 dry-run 時に
  `confirm()`。`409`（stale 状態 / replay）・`401`（bearer 不正）・`403`（CSRF 不正）
  をラベル表示。
- **安全**: 状態遷移は backend の operation / state guard のみ。UI は POST を組み立て
  るだけ。snapshot 由来の id は escape して data-* 属性に埋め、JS には信頼できない値を
  補間しない。mutation page の読込自体も（token 設定時は）bearer を要する。

## CLI

CLI の確定仕様は [`cli.md`](./cli.md) の `harness dashboard` 節を参照。
