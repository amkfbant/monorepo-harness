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
  従来どおり CLI コマンドの guard 経由でのみ行う。HTTP mutation は
  `harness operations serve`（Phase 13）だけで起動でき、既存 core オペレーションの
  薄いラッパとして同じ guard を通す（bearer token + CSRF 必須）。
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
- `overview` — run / review / retry / safety / lock-contention 指標。
  `DbMetricsSummary` の `oneShotApprovalRate` / `policyViolationRate` /
  `secretSuspectRate` / `lockContentionCount` を含む。
  D1 KPI の式は [`cli.md`](./cli.md) の `harness metrics` 節を正規定義とし、
  dashboard snapshot でも同じ定義を使う
- `usage` — `DbTokenUsageSummary`。scope 内 usage 付き DISTINCT run 数、
  `exact` invocation rows の token 合算、`usage_source` 別件数、kind 別内訳。
  式は [`cli.md`](./cli.md) の
  `harness metrics` 節を正規定義とし、dashboard snapshot でも同じ定義を使う
  （snapshot / read API が `usage`(byKind 込み)を持つ。HTML dashboard 上の usage
  section 描画は未実装で `docs/future-features.md` の follow-up）
- `metricsTrend` — 直近 30 件までの `metrics_snapshots` から作る軽量 trend。
  各点は `{ createdAt, totalRuns, approvedRate, totalTokens }` で、適用中の
  project / repo filter に従う。未指定の project / repo / domain 列は `NULL` scope
  の snapshot のみを対象にする。snapshot は導出値なので、trend は表示専用であり
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

## serve（実装済み: Phase 12 read-only / Phase 14 asset reads）

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

### Read contract（dashboard-split D1）

この節が dashboard read side の確定契約。将来 `src/dashboard/server/server.ts`
の route table を分割しても、ここに列挙した挙動を維持する。

- **read surface**: `defaultRoutes()` が read 契約。`mutationRoutes()` は
  operations surface（`src/operations/operations-api.ts`）の契約で、dashboard read
  side には含めない。
- **method**: `GET` と `HEAD` のみが read。`HEAD` は `GET` handler を使う。
  dashboard 上の `POST` / `PUT` / `PATCH` / `DELETE` は常に
  `405 method_not_allowed`。存在しない path は `404 not_found`。
- **dispatch**: route match は method + path で行う。同一 path を共有する
  `GET /api/runs/:runId/review` と `POST /api/runs/:runId/review` は別契約であり、
  POST が read handler に吸われてはいけない。POST は `harness operations serve`
  の listener だけで処理する。
- **DB mutation**: HTTP read handlers は DB を read-only handle で開くか、
  `loadDashboardSnapshot(..., autoImport: false)` を使う。read request は import /
  migration / workflow state transition / operation execution を起動しない。
  `mcpConfirmations` の expired 判定などの derived value は response 内だけで
  effective status を計算し、DB row は更新しない。
- **auth**: `--token-env` 設定時は read request も含めて全 request に
  `Authorization: Bearer <token>` が必要。token 未設定の localhost read-only bind は
  operator UX として許可し、非 localhost bind で token 未設定なら `401`。
  CSRF は operations POST 専用で、dashboard HTML には CSRF meta / inline JS /
  mutation controls を出さない。
- **response shape**: JSON API は `application/json; charset=utf-8`。error は
  `{ "error": { "code": "<snake_case>", "message": "...", "details"?: ... } }`。
  `GET /` は HTML、artifact body endpoint は artifact の `content_type` または
  `application/octet-stream` の raw bytes を返す。
- **security headers**: 全 response に `X-Content-Type-Options: nosniff` /
  `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`。`--cors-origin`
  指定時のみ `Access-Control-Allow-Origin` と `Vary: Origin` を返す。

### Read endpoint inventory（GET / HEAD）

| Path | Query / path contract | Response |
|------|------------------------|----------|
| `/` | query なし | live HTML dashboard。`autoImport: false` の snapshot を描画。JS / CSRF meta / mutation controls なし |
| `/api/health` | query なし | `{ status, version, dbSchemaVersion, schemaVersionExpected, generatedAt }`。DB unavailable でも troubleshooting 用に `200` + `dbSchemaVersion: null` |
| `/api/snapshot` | `project`, `repo` を `DashboardFilters` に反映。`domain` / `status` / `since` / `until` 等の未知 query は無視 | `DashboardSnapshot` 全体 |
| `/api/runs` | `project`, `repo` を `DashboardFilters` に反映 | snapshot の `recentRuns` slice を `{ runs }` で返す |
| `/api/runs/:runId` | `runId` は `run-` prefix + `[A-Za-z0-9._-]`。不正 shape は `400` | run meta。未存在は `404` |
| `/api/runs/:runId/timeline` | `runId` shape は上記と同じ | `{ events }`。未存在は `404` |
| `/api/runs/:runId/artifacts` | `runId` shape は上記と同じ | `{ artifacts }`。未存在は `404` |
| `/api/runs/:runId/review` | `runId` shape は上記と同じ | `{ runId, proposals, consensus }` |
| `/api/review/proposals` | `runId` 必須。`includeArchived=1` のとき archived proposal も含める | `{ runId, proposals }`。`runId` 欠落 / 不正 shape は `400` |
| `/api/review/consensus` | `runId` 必須 | `{ runId, consensus }`。`runId` 欠落 / 不正 shape は `400` |
| `/api/review/reviewers` | query なし | `{ reviewers }` |
| `/api/artifacts/:artifactIdB64` | path segment は canonical artifact id `<runId>:<relativePath>` の base64url。loose base64 も許容 | artifact metadata row。empty / undecodable segment は `400`、decoded id 未存在は `404` |
| `/api/artifacts/:artifactIdB64/body` | artifact id contract は上記と同じ。`--no-artifact-body` で `403` | artifact body bytes。missing blob は `404`、external blob integrity mismatch は `409 blob_integrity_error`。`secret_suspect=1` は `X-Harness-Secret-Suspect: 1`、`--max-inline-artifact-bytes` 超過時は attachment disposition |
| `/api/db/status` | query なし | `{ dbPath, schemaVersion, schemaVersionExpected, runs, generatedAt }` |
| `/api/db/stats` | query なし | DB stats。shared maintenance lock を保持して読む |
| `/api/db/consistency` | query なし | DB/file consistency report。read-only check で修復はしない |
| `/api/locks` | query なし | `{ locks }` active domain locks |
| `/api/operations` | `targetType`, `targetId`, `status`, `limit`。`limit` が数値でなければ `100` | `{ operations }`。operation audit read は mutation disabled でも利用可 |
| `/api/operations/:operationId` | operation id path segment | `{ operation, events }`。未存在は `404` |
| `/api/assets/exports` | `assetType` optional | `{ exports }` |
| `/api/assets/projects` | query なし | project profile current revision summary |
| `/api/assets/projects/:projectId` | project id path segment | `{ current, history }`。current revision 未存在は `404` |
| `/api/assets/policies` | query なし | policy template summary + recent effective policy snapshots |
| `/api/assets/policies/:scopeType/:scopeId` | `scopeType` は `repo` / `project` / `domain` / `global` | `{ current, history }`。scopeType 不正は `400`、current template 未存在は `404` |
| `/api/assets/knowledge` | query なし | codebase knowledge asset summary。operational knowledge はこの surface から除外 |
| `/api/assets/knowledge/:entryId` | entry id path segment | codebase knowledge の `{ current, history }`。operational knowledge または未存在は `404` |
| `/api/storage/blobs` | query なし | DB blobs aggregate + blob stores + external blobs |
| `/api/archives` | query なし | `{ archives }` |
| `/api/doctor/latest` | query なし | latest doctor run + findings。run 未存在時は `{ run: null, findings: [] }` |

### Operations endpoints（POST, Phase 13 — `harness operations serve`）

dashboard では POST は常に `405`。以下の操作系 API は別 listener の
`harness operations serve` だけが wire し、いずれも既存 core オペレーションの guard
を通る。

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

- **Dashboard Bearer token** — `--token-env <ENV>` で env var からトークンを読む。設定時は
  全リクエストに `Authorization: Bearer <token>` が必要（定数時間比較）。read-only
  かつ localhost bind で未設定なら認証はスキップ（operator UX）。非ローカル bind で
  未設定の場合は fail-closed で `401`。
- **Dashboard `--enable-mutation`** — 互換用に残るが、listen 前に非 0 終了し
  `harness operations serve` へ誘導する。dashboard は CSRF token を生成せず、
  live HTML に `<meta name="harness-csrf-token">` / inline JS / mutation controls を
  出さない。
- **Operations auth / CSRF** — `harness operations serve --token-env <ENV>` は
  bearer token 必須。`--csrf-token-env <ENV>` 指定時は env の CSRF token を使い、
  未指定時は boot 時に CSRF token を生成して stdout に一度だけ表示する。POST は
  `Authorization: Bearer <token>` と `X-CSRF-Token` が必要。
- **security headers** — 全レスポンスに `X-Content-Type-Options: nosniff` /
  `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`。`--cors-origin <origin>`
  指定時のみ `Access-Control-Allow-Origin` を返す。

### Mutation UI

dashboard HTML は read-only。CSRF meta、bearer token input、operation button、
inline mutation JS は出さない。操作は `harness operations serve` の POST API を
外部 client から呼び出す。

## CLI

CLI の確定仕様は [`cli.md`](./cli.md) の `harness dashboard` 節を参照。
