# Phase 13 — Mutation API + operation audit 設計書

**作成日:** 2026-05-24
**対象:** `phase12-close` (commit `c3bab3e`) 後の `monorepo-harness`
**実装計画:** `tmp/phase10-16-design-plans/phase13-mutation-api-operation-audit-plan.md`
**ステータス:** 設計確定 (Phase 13-0)。

---

## 1. 位置づけ

Phase 12 で read-only HTTP dashboard が landed。Phase 13 は **operator
が dashboard / API から approve / rerun / cleanup / pr create / backlog
run を実行できる** mutation 基盤を作る。安全モデルは Phase 7-12 の
state guard + Phase 10-5 review idempotency + Phase 11 review governance
を継承し、Phase 13 では:

- **operation audit ledger** ですべての mutation を記録
- **idempotency key** で duplicate 実行を防ぐ
- **dry-run / confirm** で破壊的操作を二段階化
- **CLI と HTTP API が同じ core operation を呼ぶ**
- **dashboard には minimal mutation UI** (button + drawer)
- **policy / review / state transition の safety model は不変**

Phase 13 のスコープは local-only operator UI 想定。multi-user / RBAC /
public deployment は scope 外。

---

## 2. canonical 境界

schema v8 を追加。新 tables:

- `operations` の拡張 (Phase 7-5 で軽量版あり; Phase 13 で audit ledger
  shape に統一)
- `operation_events` (audit timeline)
- `operation_confirmations` (UI dry-run → confirm の token、optional)

mutation API は `--enable-mutation` flag が **OFF (default)** のとき
404 を返す。`OFF` でも `GET /api/operations/...` は public read として
動かす (operations は audit のため)。

---

## 3. 確定した設計判断

### A. Operation as canonical mutation unit

すべての mutation は **1 operation row + N operation_events** で記録:

```
operation_id           ULID-like text key (caller 指定可、未指定なら server 生成)
operation_type         'review.apply' / 'run.rerun' / 'run.cleanup' / 'run.pr_create' / 'backlog.run'
target_type            'run' / 'backlog_item' / ...
target_id              run_id / item_id
actor                  'cli:<pid>' / 'http:<remote_addr>' / 'system'
idempotency_key        caller 指定 (HTTP: Idempotency-Key header / CLI: --operation-id)
dry_run                0 | 1
status                 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
input_json             {dry_run, confirm, ...} の正規化
result_json            success 時の戻り (PR url / cleanup summary 等)
error_code             failure 時の typed code
error_message          stderr equivalent
metadata_json          extras (CSRF check / request_id 等)
created_at, started_at, completed_at
```

### B. Idempotency rules

`(operation_type, target_id, idempotency_key)` UNIQUE。同じ key の再送:

| 既存 status | 振る舞い |
|---|---|
| succeeded | 既存 `result_json` を返す (no-op) |
| running | `OperationInFlightError` (異プロセス処理中) |
| failed | 新 operation_id で再 claim 可能 (caller が同じ key を渡す = 意図的 retry) |
| cancelled | 新 operation_id で再 claim 可能 |

これは design §3.E.E2-bis (Phase 10) を operations table で完成させる。

### C. Dry-run / confirm

破壊的操作 (`run.cleanup` / `run.pr_create` / `review.apply` で
override 指定時 / `review.override`):

```
dry-run=true:
  - 副作用なし
  - result_json に "planned changes" を埋めて返す
  - status: 'succeeded' で record (audit に残る)

real:
  - dry-run=false かつ confirm token が必要
  - confirm 文字列は CLI: --confirm "I understand" (or specific phrase)
                    HTTP: body { confirm: "<phrase>" }
```

`review.apply` (consensus mode の通常 promotion) は dry-run 不要。

### D. Local-only security

- **--enable-mutation flag** (default OFF) — POST routes 自体が無効
- **bearer token** 必須 (Phase 12-7 と同じ) — mutation は localhost
  でも token を強制
- **CSRF token** (browser UI) — server が GET / 時に csrfToken を HTML
  内に埋め、POST は `X-CSRF-Token: <token>` header を要求
- **non-local + mutation** は `--allow-nonlocal-mutation` を要求

### E. CLI と HTTP API は同じ core operation を呼ぶ

```
src/operations/
  operation-repository.ts
  operation-runner.ts
  types.ts
  review-apply.ts       (= core function; CLI と HTTP の両方が呼ぶ)
  run-rerun.ts
  run-cleanup.ts
  run-pr-create.ts
  backlog-run.ts
```

各 core function shape:

```ts
async function reviewApply(
  ctx: OperationContext,
  input: ReviewApplyInput,
): Promise<ReviewApplyResult>;
```

`OperationContext` は db handle + actor + dry_run + operation_id を持つ。
core function 内部で `OperationRunner` を呼んで record する。

### F. Dashboard mutation UI minimum

run detail に 4 buttons: Approve / Request changes / Rerun / Cleanup
/ Create PR。各 button:

1. dry-run preview modal を開く
2. operator が confirm を type
3. POST submission
4. operation drawer で status poll

Phase 13 では minimum HTML + fetch JS。framework なし。

---

## 4. Schema v8

`SCHEMA_VERSION = 8`。Phase 13-1 で land:

```sql
-- 既存 operations table を Phase 13 audit ledger に拡張
-- (Phase 7-5 で導入された軽量 schema を superset 化)
ALTER TABLE operations ADD COLUMN operation_type TEXT;
ALTER TABLE operations ADD COLUMN target_type TEXT;
ALTER TABLE operations ADD COLUMN target_id TEXT;
ALTER TABLE operations ADD COLUMN actor TEXT;
ALTER TABLE operations ADD COLUMN idempotency_key TEXT;
ALTER TABLE operations ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN status TEXT NOT NULL DEFAULT 'succeeded';
ALTER TABLE operations ADD COLUMN input_json TEXT;
ALTER TABLE operations ADD COLUMN error_code TEXT;
ALTER TABLE operations ADD COLUMN error_message TEXT;
ALTER TABLE operations ADD COLUMN started_at TEXT;
ALTER TABLE operations ADD COLUMN completed_at TEXT;
ALTER TABLE operations ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX operations_idempotency_idx
  ON operations(operation_type, target_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX operations_target_idx ON operations(target_type, target_id, created_at);
CREATE INDEX operations_status_idx ON operations(status, created_at);

CREATE TABLE operation_events (
  event_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id       TEXT NOT NULL,
  seq                INTEGER NOT NULL,
  event_type         TEXT NOT NULL,
  message            TEXT,
  data_json          TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE CASCADE,
  UNIQUE(operation_id, seq)
);
CREATE INDEX operation_events_op_idx ON operation_events(operation_id, seq);
```

`operation_confirmations` は Phase 13 minimum では作らない (CSRF token
で十分; confirmation challenge は Phase 14+ で UX を上げるとき検討)。

既存 Phase 7-5 で挿入された operations row は新 columns NULL で残り、
新 logic は NULL 許容 (legacy 互換)。

---

## 5. API contract

### 5.1 Operation status

```
GET /api/operations/:operationId           operation 詳細
GET /api/operations?targetType=&targetId=  operation list
```

これらは `--enable-mutation` が OFF でも有効 (read-only audit)。

### 5.2 Review

```
POST /api/runs/:runId/review

body:
{
  "decision": "approved" | "changes_requested" | "rejected",
  "proposalId": 12,
  "sourceSha256": "...",
  "dryRun": false,
  "confirm": "apply-review",
  "override"?: {
    "actorReviewerId": "lead",
    "reason": "..."
  }
}

response:
{
  "operationId": "...",
  "status": "succeeded",
  "result": { "previousStatus": "needs_review", "newStatus": "approved" }
}
```

### 5.3 Rerun / cleanup / PR

```
POST /api/runs/:runId/rerun     { "dryRun": true, "reason": "..." }
POST /api/runs/:runId/cleanup   { "dryRun": true, "deleteBranch": true, ... }
POST /api/runs/:runId/pr        { "dryRun": false, "confirm": "create-pr" }
POST /api/backlog/:itemId/run   { ... }
```

---

## 6. Sub-phase

```
13-0  Design                                ← 本書
13-1  Schema v8 (operations 拡張 + operation_events)
13-2  OperationRunner + repository (idempotency / status / events)
13-3  CLI core operation refactor (CLI/HTTP shared)
13-4  Mutation API skeleton (--enable-mutation / token / CSRF / status read)
13-5  POST /api/runs/:id/review + rerun
13-6  POST /api/runs/:id/cleanup + pr + /api/backlog/:id/run
13-7  Minimal dashboard mutation UI
13-8  Docs / close
```

---

## 7. Close conditions

```
[ ] operations / operation_events schema がある
[ ] mutation API は --enable-mutation が必要
[ ] token auth + CSRF がある
[ ] every mutation creates operation audit
[ ] idempotency key により二重実行されない
[ ] review / rerun / cleanup / pr / backlog run API がある
[ ] CLI と API が同じ core operation を使う
[ ] minimal dashboard mutation UI がある
[ ] dangerous operations は dry-run / confirm を持つ
[ ] existing tests green
[ ] npm run typecheck green
[ ] docs / close report / phase13-close tag
```

---

## 8. Phase 14 への接続

Phase 14 (human-authored assets DB canonical) は Phase 13 operation
runner を流用して project / policy / knowledge の edit operation を
audit する。`operation_type` = `project.edit` / `policy.edit` /
`knowledge.edit` を追加するだけ。

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| mutation API が CLI safety を bypass | core operation 経由を強制、API は wrapper |
| public exposure | --enable-mutation default OFF + token + CSRF + non-local 警告 |
| operation audit 肥大化 | Phase 15 で retention / archive |
| dry-run と real の意味の混乱 | dry_run = 1 を operation row に残し、UI で明示表示 |
| concurrent same idempotency_key | UNIQUE index + status 検査で fail-closed |
