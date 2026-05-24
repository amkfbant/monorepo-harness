# Phase 11 — Review governance / consensus 設計書

**作成日:** 2026-05-24
**対象:** `phase10-close` (commit `8873591`) 後の `monorepo-harness`
**実装計画:** `tmp/phase10-16-design-plans/phase11-review-governance-consensus-plan.md`
**ステータス:** 設計確定 (Phase 11-0)。実装は 11-1 以降。

---

## 1. 位置づけ — Phase 10 が残した review semantics

Phase 9-8 で `review_proposals` テーブルが導入され、`review auto` の verdict
が DB canonical になった。Phase 10-5 で `markProcessed` の `source_sha256`
guard と `applyReviewDecision` の `state_version` bump が landed。これにより
**単一 reviewer / 単一 proposal / 単一 processed** までは race-safe。

しかし Phase 10 まで:

- proposal の reviewer は **string 列のみ** (`review_proposals.reviewer`)。
  reviewer identity は registry に存在せず、unknown reviewer error も無い。
- review rule は固定 (latest active proposal を取って process)。複数 reviewer
  からの集約 / N-of-M approval は無い。
- human override の audit 経路が無い。
- proposal lifecycle は `active` / `superseded` / `processed` の 3 状態。
  retention / vacuum が無い。
- consensus 評価そのものが無い。

Phase 11 は `review_proposals` を **governance layer に拡張** する。Phase 11
close 時点で:

```txt
reviewer identity:        reviewers table で正規化 (FK)
review rule:              project profile → effective rule → run snapshot
consensus:                pure function evaluator + DB row 永続化
final decision:           consensus result から昇格 + provenance 保持
human override:           audit + reason + allowed-reviewer rule
proposal lifecycle:       active / superseded / processed / rejected_stale / archived
retention:                vacuum --older-than <N>d
```

Phase 11 のスコープは **review governance**。dashboard serve / mutation API
は Phase 12-13、project profile DB canonical 化は Phase 14 で扱う。

---

## 2. canonical 境界 (Phase 11 確定値)

Phase 10 から境界を **拡張** する。Phase 11 で DB canonical に新規追加:

```txt
DB canonical (Phase 11 新規):
  reviewers (reviewer identity registry)
  review_rules (rule template — sourced from project profile YAML)
  run_review_rule_snapshots (run-level effective rule freeze)
  review_consensus (computed consensus rows; superseded_at で履歴)
  review_overrides (human override audit)

review_proposals additions (Phase 11):
  reviewer_id (FK to reviewers; nullable で legacy 互換)
  reviewer_type (human / codex / external / system)
  model / prompt_sha256 / context_pack_id / policy_generation_id
  lifecycle_status / archived_at

file-authored canonical (Phase 14 まで DB 化しない):
  project profile YAML (rule source は YAML から effective rule snapshot
    へ resolve、Phase 14 で DB canonical 化)
  policy YAML / knowledge markdown (Phase 14)
```

---

## 3. 確定した設計判断

### A. Reviewer identity (reviewers table)

#### A1. Schema (v7)

```sql
CREATE TABLE reviewers (
  reviewer_id       TEXT PRIMARY KEY,
  reviewer_type     TEXT NOT NULL CHECK (reviewer_type IN ('human', 'codex', 'external', 'system')),
  display_name      TEXT NOT NULL,
  group_id          TEXT,
  trust_level       TEXT NOT NULL DEFAULT 'normal'
    CHECK (trust_level IN ('advisory', 'normal', 'required', 'policy')),
  metadata_json     TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

#### A2. Default registry (Phase 11-2 seed)

migration v7 適用時に default reviewers を INSERT (idempotent):

```
('human',          'human',  'Local human reviewer',  'humans',  'normal')
('codex',          'codex',  'Codex automated review','codex',   'normal')
('codex-security', 'codex',  'Codex security review', 'security','required')
('system',         'system', 'System / harness',      'system',  'advisory')
```

#### A3. Backward compat with `review_proposals.reviewer` (string)

既存 string 列 `review_proposals.reviewer` は **温存**。Phase 11-1 で:

- `review_proposals.reviewer_id TEXT` (FK to reviewers) を追加 (**nullable**)
- 新 INSERT (Phase 11-2 以降) は両 columns を埋める (`reviewer_id` resolve)
- 既存 row は `reviewer_id IS NULL` で残置 (legacy。consensus 評価で
  reviewer_type='unknown' として扱う or skip)
- string 列削除は Phase 14+ で判断

#### A4. Unknown reviewer error

`review auto --reviewer <name>` で:
- `reviewers.reviewer_id = name` が無い → `UnknownReviewerError` (CLI exit 1)
- `harness review reviewers add` で operator が明示的に追加可能

### B. Review rule snapshot

#### B1. Rule source resolution (effective rule)

```
project profile YAML (review: section)
  ↓
default rule (no project profile or no review: section)
  ↓
effective rule (= 上記いずれか + global defaults overlay)
```

default rule (Phase 11 等価 = pre-Phase11 behaviour):

```yaml
review:
  mode: latest-proposal     # 最新 active proposal を process
  requirements: []           # consensus rule 無し
  overrides:
    allowedReviewers: []     # override 不可
    requireReason: true
  staleProposal:
    rejectSuperseded: true
```

project rule example (project profile に書ける):

```yaml
review:
  mode: consensus
  requirements:
    - group: humans
      minApprovals: 1
      blockingDecisions: [changes_requested, rejected]
    - group: codex
      minApprovals: 1
      blockingDecisions: [rejected]
  overrides:
    allowedReviewers: [lead, maintainer]
    requireReason: true
  staleProposal:
    rejectSuperseded: true
    maxAgeHours: 72
```

#### B2. Run-level snapshot (run_review_rule_snapshots)

run 作成時 (`runDomainCoding` 開始時) に **その時点の effective rule** を
snapshot として `run_review_rule_snapshots(run_id, rule_json, source_sha256)`
へ INSERT。

理由: project profile を後から変更しても、進行中の run の review semantics は
変わらない。

```sql
CREATE TABLE run_review_rule_snapshots (
  run_id            TEXT PRIMARY KEY,
  rule_id           INTEGER,
  rule_json         TEXT NOT NULL,
  source_sha256     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
```

`rule_id` は `review_rules` への参照 (template history)。同 rule_json の重複は
`source_sha256` で一意化し、`rule_id` で reuse。

#### B3. review_rules (rule template history)

```sql
CREATE TABLE review_rules (
  rule_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT,
  repo_id           TEXT,
  domain            TEXT,
  rule_version      INTEGER NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('project-profile', 'default', 'manual')),
  rule_json         TEXT NOT NULL,
  source_sha256     TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX review_rules_scope_idx
  ON review_rules(project_id, repo_id, domain, rule_version);
```

Phase 11-3 で `resolveEffectiveRule(project, repo, domain) → rule_json` を
実装。同 rule_json が既に `review_rules` にあれば reuse、無ければ
`INSERT + rule_id` を返す。run snapshot は rule_id を参照。

### C. Consensus evaluator

#### C1. Pure function semantics

```ts
function evaluateConsensus(
  rule: ReviewRule,
  proposals: ReviewProposalRow[],
  override?: ReviewOverrideRow,
): {
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected';
  summary: ConsensusSummary;
}
```

#### C2. Algorithm

1. **override 優先**: `override !== null` なら `override.decision` を返す
   (`summary` に override actor / reason を含める)。
2. **blocking pass**: rule.requirements の各要素について、proposals 中に
   `reviewer ∈ group AND decision ∈ blockingDecisions` が 1 件でもあれば、
   その decision を返す (rejected > changes_requested 順)。
3. **approval count**: 各 requirement の `minApprovals` を満たすか確認。満た
   さなければ `pending`。
4. **すべて満たす** → `approved`。

#### C3. Tie / conflict

```
rejected           > changes_requested > approved > pending
(blocking strong)    (blocking weak)     (positive)  (insufficient)
```

#### C4. review_consensus 永続化

evaluator 呼び出し時、結果を `review_consensus` に INSERT。同 run_id の
active row (`superseded_at IS NULL`) は 1 つだけ (partial unique index):

```sql
CREATE TABLE review_consensus (
  consensus_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL,
  rule_sha256       TEXT NOT NULL,
  status            TEXT NOT NULL
    CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected')),
  summary_json      TEXT NOT NULL,
  evaluated_at      TEXT NOT NULL,
  evaluated_by      TEXT NOT NULL,
  source_proposals_json TEXT NOT NULL,
  superseded_at     TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX review_consensus_run_idx
  ON review_consensus(run_id, evaluated_at);
CREATE UNIQUE INDEX review_consensus_active_idx
  ON review_consensus(run_id) WHERE superseded_at IS NULL;
```

re-evaluate (新 proposal insert 時など) は既存 active を `superseded_at = now`
で update してから新 row を INSERT。

### D. Human override

#### D1. Schema

```sql
CREATE TABLE review_overrides (
  override_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL,
  consensus_id      INTEGER,
  actor_reviewer_id TEXT NOT NULL,
  decision          TEXT NOT NULL
    CHECK (decision IN ('approved', 'changes_requested', 'rejected')),
  reason            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  source_sha256     TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_reviewer_id) REFERENCES reviewers(reviewer_id)
);
```

#### D2. Authorization

- `actor_reviewer_id` は `rule.overrides.allowedReviewers` に含まれていな
  ければ `UnauthorizedOverrideError` (CLI exit 1)
- `reason` 空文字列 / 未指定なら `OverrideReasonRequiredError`
- 成功時、`run_events` に `review_override` event を追加 (operator / decision
  / reason を含む)

#### D3. CLI

```
harness review process <runId> --override <decision> --reason <reason> \
                               [--actor-reviewer <id>]
```

`--actor-reviewer` 未指定時は `system` reviewer 扱い (CI / 自動運用)。

### E. Proposal lifecycle

#### E1. lifecycle_status 列

```sql
ALTER TABLE review_proposals ADD COLUMN lifecycle_status TEXT
  NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'superseded', 'processed', 'rejected_stale', 'archived'));
ALTER TABLE review_proposals ADD COLUMN archived_at TEXT;
```

state transition:

```
active ─ (review auto inserts newer) ─→ superseded
active ─ (review process) ───────────→ processed
active ─ (maxAgeHours expired) ──────→ rejected_stale
{superseded, processed, rejected_stale} ─ (vacuum) ─→ archived
```

#### E2. Consensus / process 対象から除外

- `consensus evaluator` は `lifecycle_status IN ('active', 'processed')` のみ
  を input proposals に使う (processed は historical context として
  consensus_summary に含める)。
- `review process` は `lifecycle_status='active'` のみ promote 可能。

#### E3. retention / vacuum

```
harness review proposals list <runId> [--include-archived]
harness review proposals archive <proposalId>
harness review proposals vacuum --older-than 30d [--apply]
```

`vacuum` は dry-run default。`superseded` / `rejected_stale` / `processed`
で `created_at < now - threshold` の rows を `archived` 化 (delete はしない;
audit log として残す)。

### F. Final decision 連携 (review_decisions 拡張)

`applyReviewDecision` を変更し、consensus result からの promotion に対応:

- consensus mode で `review process` が呼ばれた場合、`review_decisions` の
  新カラム `consensus_id` / `proposals_summary` (JSON) を埋める
- legacy mode (`mode: latest-proposal`) は Phase 10 までと同じ動作 (proposal
  1 件を直接 process)
- `applyReviewDecision.expectedStateVersion` guard (Phase 10 post-close で
  追加) は引き続き有効

```sql
ALTER TABLE review_decisions ADD COLUMN consensus_id INTEGER;
ALTER TABLE review_decisions ADD COLUMN proposals_summary_json TEXT;
```

---

## 4. schema v7

migration v7 で追加するもの (Phase 11-1 で land):

```
CREATE TABLE reviewers (...)                       -- §A1
CREATE TABLE review_rules (...)                    -- §B3
CREATE TABLE run_review_rule_snapshots (...)       -- §B2
CREATE TABLE review_consensus (...)                -- §C4
CREATE TABLE review_overrides (...)                -- §D1
CREATE UNIQUE INDEX review_consensus_active_idx ...

ALTER TABLE review_proposals ADD COLUMN reviewer_id TEXT REFERENCES reviewers(reviewer_id);
ALTER TABLE review_proposals ADD COLUMN reviewer_type TEXT;
ALTER TABLE review_proposals ADD COLUMN model TEXT;
ALTER TABLE review_proposals ADD COLUMN prompt_sha256 TEXT;
ALTER TABLE review_proposals ADD COLUMN context_pack_id TEXT;
ALTER TABLE review_proposals ADD COLUMN policy_generation_id TEXT;
ALTER TABLE review_proposals ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (...);
ALTER TABLE review_proposals ADD COLUMN archived_at TEXT;

ALTER TABLE review_decisions ADD COLUMN consensus_id INTEGER;
ALTER TABLE review_decisions ADD COLUMN proposals_summary_json TEXT;

-- Default reviewer seed (4 rows)
INSERT OR IGNORE INTO reviewers (reviewer_id, reviewer_type, display_name, group_id, trust_level, created_at, updated_at)
VALUES (...);
```

既存 `review_proposals` row (Phase 9 以降) は `lifecycle_status='active'`
DEFAULT で migrate、`reviewer_id IS NULL` の legacy state。

---

## 5. CLI 変更計画

### 5.1 review reviewers (新規)

```
harness review reviewers list
harness review reviewers add <reviewer_id> --type <human|codex|external|system> \
                             --display-name <name> [--group <id>] [--trust <level>]
```

### 5.2 review auto (Phase 11-2 で reviewer 解決)

```
harness review auto <runId> --reviewer <reviewer_id> [--model <m>]
```

`--reviewer` は reviewers table の `reviewer_id`。unknown なら error。
insert proposal に `reviewer_id` / `reviewer_type` / `model` /
`prompt_sha256` 等の provenance metadata を保存。
完了後 consensus を re-evaluate (Phase 11-4)。

### 5.3 review status (新規; Phase 11-4)

```
harness review status <runId>
```

active consensus (status / requirements 充足度 / blocking / active proposals)
を表示。

### 5.4 review process (Phase 11-5 で consensus mode 追加)

```
harness review process <runId> [--consensus] [--reviewer <id>]
                               [--override <decision> --reason <reason>
                                [--actor-reviewer <id>]]
                               [--operation-id <uuid>]
                               [--expected-state-version <n>]
```

default = `rule.mode` 依存 (consensus or latest-proposal)。

### 5.5 review proposals (Phase 11-7)

```
harness review proposals list <runId> [--include-archived]
harness review proposals archive <proposalId>
harness review proposals vacuum --older-than 30d [--apply]
```

---

## 6. サブフェーズ

```
11-0  Design finalization                            ← 本書
11-1  Schema v7 (5 tables + review_proposals/decisions additions + default reviewer seed)
11-2  Reviewer registry (repository + default seed verify + CLI + review auto integration)
11-3  Review rule snapshot (resolveEffectiveRule + run-level snapshot insert at run start)
11-4  Consensus evaluator (pure function + review_consensus 永続化 + review status CLI)
11-5  Integrate review auto/process (consensus re-evaluate / consensus mode process / decision promotion)
11-6  Human override (CLI + audit + allowed-reviewer + reason + run_events 記録)
11-7  Proposal lifecycle / retention (lifecycle_status state machine + vacuum CLI)
11-8  Docs / close package
```

---

## 7. Close conditions

```
[ ] reviewer identity registry がある
[ ] review rule snapshot が run ごとに固定される
[ ] 複数 reviewer proposal から consensus を評価できる
[ ] review process が consensus result を final decision に昇格できる
[ ] human override が audit 付きで動く
[ ] stale / superseded / processed proposal が安全に扱われる
[ ] proposal retention / vacuum がある
[ ] existing tests green
[ ] npm run typecheck green
[ ] docs / close report / phase11-close tag
```

---

## 8. Phase 12 への接続点

Phase 12 (dashboard serve + read-only API) は Phase 11 の output を表示する:

- `review_consensus` を dashboard の `ReviewDashboardSummary` に集約
- `review_overrides` を dashboard で監査可能に
- `review_proposals.lifecycle_status` で proposal 数を切り出して表示
- consensus status / blocking / required reviewers の現状表示

Phase 11 close 時点で、これらの read 経路を `dashboard/snapshot.ts` が
SQL 1 本で取れる shape にしておく (review_consensus + review_proposals の
join が成立)。

---

## 9. スコープ外 (Phase 12 以降)

- dashboard serve / HTTP API (= Phase 12)
- mutation API / dashboard 操作 (= Phase 13)
- project profile / policy / knowledge markdown の DB canonical 化 (= Phase 14)
- external blob store (= Phase 16)
- archive DB (= Phase 15)
- notification / Slack / email
- full RBAC

---

## 10. Risks (Phase 11 固有)

### Risk 11-α: consensus semantics が複雑になりすぎる

**Mitigation:**
- Phase 11 default rule (`mode: latest-proposal`) は pre-Phase11 と等価
- evaluator は pure function、test-first (Phase 11-4)
- complex rules は project-specific opt-in

### Risk 11-β: human override が safety boundary を弱める

**Mitigation:**
- reason required (空文字列も reject)
- audit row required
- allowed reviewer rule
- run_events に記録 (Phase 11-6)

### Risk 11-γ: project profile DB canonical 化前に rule 管理が中途半端

**Mitigation:**
- Phase 11 は rule snapshot を DB に保存 (file ↔ DB の hybrid)
- source は file-authored project profile YAML
- Phase 14 で DB canonical profile 化するときに rule source を移行

### Risk 11-δ: review_proposals 既存 row が `reviewer_id IS NULL` で残る

**Mitigation:**
- consensus evaluator は `reviewer_id IS NULL` row を `reviewer_type='unknown'`
  として group 不一致で除外 (consensus に算入しない)
- legacy 互換は Phase 14+ まで維持
- migration tool (`db migrate-legacy-reviewers`) は出さない (operator が
  manual で `UPDATE review_proposals SET reviewer_id = ?` を打てる範囲)

### Risk 11-ε: state_version の全 writer 統合 (Phase 10 残作業) と相互依存

Phase 11 の consensus が `runs.state_version` を invalidation clock として
読むなら、全 writer の bump 統合が必要。Phase 11-5 着手前に、consensus は
state_version を読まない (consensus の trigger は proposal insert / override)
ことを確定する。state_version は引き続き `applyReviewDecision` 内部の CAS
guard のみ。
