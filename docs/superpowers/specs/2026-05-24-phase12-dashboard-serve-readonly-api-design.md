# Phase 12 — Dashboard serve + read-only HTTP API 設計書

**作成日:** 2026-05-24
**対象:** `phase11-close` (commit `0b65fdd`) 後の `monorepo-harness`
**実装計画:** `tmp/phase10-16-design-plans/phase12-dashboard-serve-readonly-api-plan.md`
**ステータス:** 設計確定 (Phase 12-0)。実装は 12-1 以降。

---

## 1. 位置づけ — Phase 11 までの output を live で見せる

Phase 6 で static dashboard export が導入。Phase 7-11 で runtime / asset
が DB canonical 化、review consensus / overrides まで揃った。Phase 12 は
これらを **live read-only HTTP server** として公開し、operator が `harness
dashboard serve` で localhost に dashboard を立てられるようにする。

Phase 12 のスコープは **read-only**。mutation (approve / cleanup / pr
create) は Phase 13 で扱う。

## 2. Canonical 境界

schema 変更なし。Phase 12 は **purely read**:

- `openManagedDb({ readonly: true })` のみ
- すべての HTTP handler は GET/HEAD のみ受け付ける
- POST/PUT/PATCH/DELETE は 405 Method Not Allowed
- DB write / file write / import / export / materialize / cleanup を
  trigger しない

mutation invariant test として、各 endpoint hit 前後で `harness.sqlite`
の mtime を比較する。

---

## 3. 確定した設計判断

### A. Read-only invariant

| Verb | Status |
|---|---|
| GET | OK |
| HEAD | OK (GET と同じ handler、body 省略) |
| OPTIONS | 通常 405。明示的 CORS 設定時のみ minimal preflight 200 |
| POST / PUT / PATCH / DELETE | 405 |

Non-GET response shape:

```json
{ "error": { "code": "method_not_allowed", "message": "GET only" } }
```

### B. Bind policy

```
default:    host=127.0.0.1, port=8787
explicit:   --host 0.0.0.0 → start 時に stderr warning
            "warning: binding to 0.0.0.0 exposes the dashboard to the
             network. Use --token-env to require Bearer auth."
```

`--port` の競合検出は `EADDRINUSE` を catch して exit 1 + 別 port hint。

### C. Token auth

optional bearer token。

```
config: --token-env HARNESS_DASHBOARD_TOKEN
header: Authorization: Bearer <token>
```

token 未設定 + localhost bind → auth check skip (operator UX)。
token 未設定 + 0.0.0.0 bind → start 時 warning + 全 request に
`401 Unauthorized` を返す safe default (Phase 12-7 で実装)。

### D. Artifact body safety

| Risk | Mitigation |
|---|---|
| path traversal | `/api/artifacts/:artifactId/body` の `artifactId` を整数として parse。任意 string 無効化 |
| secret leak | `artifacts.secret_suspect=1` のとき response header に `X-Harness-Secret-Suspect: 1` + body は 200 で返す (operator が見たい用途想定) |
| huge body | default 1 MiB を超える body は inline 不可。Content-Disposition: attachment で download 強制 |
| body 無効化 | `--no-artifact-body` で `/api/artifacts/:id/body` のみ 403 |

### E. DB shared maintenance lock

各 GET handler は `openManagedDb({ dbPath, readonly: true })` で開く。
shared maintenance lock を握るため、destructive `db restore` 中は handler
が待たされる。重い endpoint (`/api/snapshot` / `/api/db/stats`) は acquire
を 30s timeout で打ち切り、`423 Locked` を返す。

### F. Server architecture

```
src/dashboard/server/
  server.ts          # createDashboardServer() — http.Server を返す
  router.ts          # method + path → handler dispatch
  handlers/
    health.ts
    snapshot.ts
    runs.ts
    artifacts.ts
    review.ts
    db.ts
    locks.ts
    index-html.ts    # GET / and /assets/*
  middleware/
    method-guard.ts
    auth.ts
    cors.ts
    errors.ts
    security-headers.ts
  api-types.ts
```

Node built-in `http`。external framework は使わない。router は path-based
prefix tree (手書き)。

### G. Error response shape

```json
{
  "error": {
    "code": "<snake_case_code>",
    "message": "...",
    "details": { /* optional */ }
  }
}
```

`code` 一覧:

| Code | Status |
|---|---|
| `not_found` | 404 |
| `bad_request` | 400 |
| `method_not_allowed` | 405 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `conflict` | 409 |
| `maintenance_lock_busy` | 423 |
| `internal_error` | 500 |

---

## 4. API contract (Phase 12)

```
GET /api/health                              → { status, version, dbSchemaVersion, generatedAt }
GET /api/snapshot?project=&repo=&domain=&status=&since=&until=
                                             → DashboardSnapshot
GET /api/runs                                → DashboardRunSummary[]
GET /api/runs/:runId                         → run detail
GET /api/runs/:runId/timeline                → events array
GET /api/runs/:runId/artifacts               → artifact manifest array
GET /api/runs/:runId/review                  → consensus + proposals
GET /api/artifacts/:artifactId               → artifact metadata
GET /api/artifacts/:artifactId/body          → blob body (or 413 if too large + no inline)
GET /api/review/proposals?runId=             → proposals
GET /api/review/consensus?runId=             → active consensus
GET /api/review/reviewers                    → reviewer registry
GET /api/db/status                           → DB status (schema version / size / wal)
GET /api/db/stats                            → DB stats
GET /api/db/consistency                      → consistency check result
GET /api/locks                               → active DB domain locks
GET /                                        → bundled HTML
GET /assets/*                                → bundled JS/CSS
```

---

## 5. CLI

```
harness dashboard serve [--host 127.0.0.1] [--port 8787]
                        [--token-env HARNESS_DASHBOARD_TOKEN]
                        [--cors-origin <url>]
                        [--no-artifact-body]
                        [--max-inline-artifact-bytes 1048576]
                        [--db <path>]
                        [--open]
```

---

## 6. Sub-phase

```
12-0  Design finalization                          ← 本書
12-1  HTTP server skeleton + GET /api/health + method guard
12-2  GET /api/snapshot (DashboardSnapshot 流用)
12-3  GET /api/runs/* + /api/review/*
12-4  GET /api/artifacts/:id/body (DB blob, large body, secret-suspect)
12-5  GET /api/db/* + /api/locks
12-6  GET / + /assets/* (HTML dashboard, polling refresh)
12-7  Auth + security hardening (token / CORS / 0.0.0.0 warning /
       --no-artifact-body)
12-8  Docs / close package
```

---

## 7. Close conditions

```
[ ] dashboard serve が read-only HTTP server として動く
[ ] GET/HEAD 以外は 405
[ ] DashboardSnapshot を DB から生成する
[ ] run / review / artifact / db / lock API がある
[ ] artifact body は DB blob から安全に配信される
[ ] default bind は 127.0.0.1
[ ] optional token auth がある
[ ] mutation endpoint が存在しない
[ ] static dashboard export との snapshot model が共通
[ ] existing tests green
[ ] npm run typecheck green
[ ] docs / close report / phase12-close tag
```

---

## 8. Phase 13 への接続

Phase 13 (mutation API) は Phase 12 server に **POST endpoints を追加** :

- `POST /api/runs/:id/review` (approve / changes_requested / rejected)
- `POST /api/runs/:id/rerun`
- `POST /api/runs/:id/cleanup`
- `POST /api/runs/:id/pr`
- `POST /api/backlog/:id/run`

これらは `--enable-mutation` flag + token + CSRF で守る。Phase 12 の
read-only invariant test (mtime 比較) は Phase 13 で `--enable-mutation`
flag OFF のときの assertion として残す。

Phase 12-5 / 12-7 で integrate する shape:

- `RequestContext` (db handle + config) を Phase 13 で `OperationRunner`
  に渡せるよう extensible に
- error response shape を Phase 13 mutation で再利用 (同じ codes 拡張)

---

## 9. Risks (Phase 12 固有)

1. **read-only server が隠れた mutation を行う** → endpoint test で
   `fs.statSync(dbPath).mtimeMs` を前後比較 + 全 handler が
   `openManagedDb({ readonly: true })` を使う static check (grep)。
2. **artifact body serving leaks secrets** → secret-suspect flag header /
   `--no-artifact-body` / local bind default / optional token (Phase 12-7)。
3. **frontend scope creep** → framework なし、HTML + fetch polling のみ。
   mutation UI は Phase 13。
4. **Node built-in http の手書き router が複雑化** → 1-file router、path
   based prefix match、middleware は単純 array chain。
5. **shared maintenance lock の deadlock** → `acquire` timeout を 30s、
   超過時 423 Locked を返す。Phase 9 の `openManagedDb` が timeout 対応
   済みなのでそれを使う。
