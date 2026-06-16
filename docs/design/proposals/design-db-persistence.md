# 設計提案: 合議制アーティファクトの DB 永続化（統合計画 / epic #228・#229・#230・#231 横断）

> **生成方法**: 案C形式のマルチエージェント合議（独立起案5体[異レンズ] → DB アーキ前提の反証verify 5体 → 横断批判/MECE/採点 → 統合）+ codex exec gpt-5.5 xhigh レビュー（付録F）。**v2 で付録F の P1×4 / P2×4 / P3×2 を本文 DDL に織り込み確定**。
> **ステータス**: 計画のみ（コード未変更）。3案(#229/#230/#231) v2 ノートの永続化前提を横断統一し、共有 decision-log バックボーンに乗せる。
> **前提検証で grounding 訂正あり**（付録C参照）: convergence 表は `hitch_convergence_decisions`（payload列なし→recommended_next_action JSON）/ review_decisions は export-backed / phases.review_state_json は specApproval 用の専用書込経路が無い（既存 writer は note 用 setNote() のみ・CAS なし）。設計はこれを反映済み。
> 実装は dev クローンの `origin/main` ベース隔離ブランチで別セッション実施。**最終的な home**: dev クローンの `docs/design/` 配下へ。
> カレント検証元: ops checkout v0.7.10 (= origin/main)。file:line は全件実コードで裏取り済み。

---

## v2 改訂履歴（codex P1/P2/P3 反映）

> 付録F（codex exec gpt-5.5 xhigh レビュー、総合判定 GO-with-fixes）の指摘を本文 DDL・受け入れ条件・テスト計画に織り込んだ。実コードで裏取りした確定事項を下記に列挙する。

**P0**: なし（codex 判定どおり）。

- **P1-1（FK + `foreign_keys=ON` の矛盾 — 「orphan として残す」は実現しない）** → §2.6 / §3.1 / §3.2 / §3.4 / 受け入れ条件①⑧ を改訂。`openDb` は `foreign_keys = ON`（connection.ts:44）。親 FK を張ったまま `ON DELETE` 無しだと、親（runs/hitch_sessions/hitch_findings）削除時に audit 行は **orphan 化せず削除が FK で失敗**する。import reset は legacy-file の `runs` を消す（import-files.ts:114）ので、`run_id REFERENCES runs` を張ると reset が詰まる。**確定方針: `run_id` / `hitch_id` / `finding_id` は FK にせず advisory ID とし、doctor で orphan を検出**（これで「親 purge 後も audit 行を append-only に残す」が成立）。FK は **一切張らない**（v31 の 3 表すべて）。
- **P1-2（`hitch_id` と `finding_id` の別々 FK が別 hitch の finding を許す不整合）** → §3.2 を改訂。`hitch_findings` は `finding_id` 単独 PK・`hitch_id` は通常列（schema.ts:1342）で、既存 unique は `(hitch_id, stable_key)`（schema.ts:1575）であり `(hitch_id, finding_id)` ではない。FK を別々に張ると `hitch_id=h1` ∧ `finding_id=f2(別hitch)` が通る。**P1-1 で FK 自体を外したので、整合は repository insert と doctor で担保する**: insert は `finding_id` から `hitch_findings.hitch_id` を引いて一致を検査（不一致は reject）、doctor は `(stored hitch_id) == (join した hitch_id)` を advisory チェック。`hitch_id` 列は読み取り高速化のための **denormalized advisory** であり、権威は `finding_id` 経由の join。
- **P1-3（`review_state_json` の lost-update）** → §2.4 / §3.3 / 付録B を改訂。`review_state_json` は人間批准の load-bearing state。単純 read→merge→write は他 key や同時 approval を lost-update する。**確定方針: `updateReviewState()` / `recordSpecApproval()` は `db.transaction(...).immediate()` 内で read-modify-write し、`WHERE phase_id=? AND review_state_version=?` の CAS（新規 `review_state_version` 列、§3.3）で保護**。`add()` が既に `.transaction().immediate()` を使う（phase-repository.ts:45/70）のと同方式。specHash は設計どおり TS 側で canonical JSON から計算。
- **P1-4（「RESET list に足さない→import で空」は誤り）** → §2.6 / §3.4 / §6 / 受け入れ条件② を改訂。reset 対象は固定リストのみ（import-files.ts:45/60/67）。**新 DB-only 表を list に足さなければ、既存 DB の audit 行は import/reset 後も残る（消えない）**。空になるのは fresh DB の場合だけ。文言を **「file import は新 DB-only 表を変更しない。空になるのは fresh DB の場合のみ」** に訂正。DB-only audit を消す retention/repair は別コマンドに分離（§3.4・§9）。

**P2（反映済み）**:
- **P2-1（severity CHECK に `info` 不足）** → §3.2 `jury_severity_audits` を改訂。現 `hitch_findings.severity` は `info` を含む（schema.ts:1353 / types.ts:100-106）。CHECK に `info` を追加（`P0..P3,info`）。
- **P2-2（`unknown_inconclusive` が scope enum と不一致）** → §3.2 `jury_classification_proposals` を改訂。現 scope enum は `in_scope/out_of_scope/unknown/duplicate`（types.ts:110-115）。`proposed_scope` は **`unknown` に寄せ**、jury の「判定不能」は別列 **`proposal_status`**（`complete/timeout/parse_error/inconclusive`）で表す。
- **P2-3（`UNIQUE(...,created_at)` が retry dedupe として弱い）** → §3.1 / §3.2 を改訂。同一 timestamp 衝突があり得る。append-only audit は **UNIQUE を落として INDEX のみ**にし、dedupe が要る箇所は **実 business key**（refute は `(run_id, target_change_hash, reviewer_id, prompt_sha256)`、jury は `(finding_id, lens, reviewer_id, prompt_sha256)`）の UNIQUE にする。
- **P2-4（`run_usage` JOIN を `run_id` のみにすると invocation を一意に戻せない）** → §3.0 / §3.5 を改訂。v30 PK は `(run_id, kind, seq)`（schema.ts:1816）で writer は seq を増分採番（run-usage.ts:42）。各合議行に nullable **`usage_kind` / `usage_seq`** を持たせ、`(run_id, usage_kind, usage_seq)` で run_usage と JOIN 可能にする（FK は張らない＝P1-1）。
- **P2-5（UNIQUE INDEX が reviewer_id NULL 許容で SQLite UNIQUE NULL 重複 bug）** → §3.2 `jury_classification_proposals` を改訂。UNIQUE(finding_id, lens, reviewer_id, prompt_sha256) は reviewer_id=NULL を複数許し同一 finding/lens/prompt の重複行を生み、aggregateJuryVotes が GROUP BY で fail-closed split。**reviewer_id を NOT NULL に確定**（未登録 proposer は別流程で処理）。

**P3（反映済み）**:
- **P3-1（`escalate_flag` / `confidence` の CHECK 欠如）** → §3.2 を改訂。gate 監査 DDL なので厳格化。`CHECK (escalate_flag IN (0,1))`、`CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)` を全該当列に付与。
- **P3-2（`phase-repository.ts` の実パス）** → §2.4 / §3.3 を訂正。`src/db/phase-repository.ts` ではなく **`src/roadmap/phase-repository.ts`**（実ファイルで確認）。

**round10 訂正（独立多角監査の反映。codex App 非依存）**:
- **証拠強制を refute 票に限定（round9 の blanket 強制を訂正）**: round9 は全 passed 行に `counter_evidence_kind IN ('diff','test')` を課したが、反証層の participant は uphold/refute 両方（§3.1 validation_status の集約方針コメント・design-229 §3.5 / G3 表）。uphold（finding 維持＝反証しない）/inconclusive は本来 counter-evidence を持たず `kind='none'` が正当で、全 passed に証拠を課すと**証拠なし uphold が passed になれず「uphold も participant」という stated モデルが空文化**する（脱落方向は `evaluateConsensus` の quorum floor/rate 上 fail-CLOSED＝降格抑制で安全側だが participant モデルが死ぬ）。→ **G3 必須 DSL（refute_reason / counter_evidence / refute_condition / retract_condition）の強制を `refute_verdict='refute'`（降格票）に限定**。uphold/inconclusive は `target_change_hash`（列 NOT NULL）+ verdict のみで passed 可。fail-closed は維持（証拠なし refute は rejected＝降格を駆動しない）。§3.1 DDL（passed CHECK / 列コメント / reject_reason）・design-229 G3 item1 / 受け入れ条件(c) を改訂。
- **`source_sha256` の NULL-yaml 規則を明示（round9 の積み残し）**: `source_yaml` は nullable だったため `source_sha256 = sha256(source_yaml)` が NULL-yaml（malformed/no-output reject）で不定義だった。→ `source_yaml` を **NOT NULL DEFAULT ''**（raw 出力を空でも verbatim 保存）にし `source_sha256` を常に算出可能化。no-output 票の同一 reviewer/prompt 再試行は同一 hash で idempotent dedup（同一失敗の冪等記録＝許容）。

---

# 統合 DB 永続化設計ノート — 合議制アーティファクト (epic #228 / #229・#230・#231)

> 計画のみ。コード未変更。実装は別セッションが dev クローン `origin/main` ベース隔離ブランチで TDD。
> カレント検証元: ops checkout v0.7.10 (= origin/main)。file:line は全件実コードで裏取り済み。
> 採用バックボーン: **Lens 2 (table-vs-json-modeling)** を基盤に、Lens 3 の provenance/判断ログ、Lens 4 の consistency/doctor/import-export を graft。Lens 5 の deliberation_rounds super-table と Lens 1 の severity binding mode・新 JSON 列は**棄却**(理由は §3.6・§9)。

---

## 1. 背景 — なぜ DB 蓄積が要るか

epic #228 (AI 合議制) の sub-issue #229/#230/#231 は LLM 多体の **提案・票・分類・spec 候補**を生む。harness は **DB-canonical** (`.harness/harness.sqlite` が source of truth、files は互換 export) なので、これらを正しく DB に蓄積しないと:

- **判断ログ (deliberation.md §5/§7)**: 「会話全文でなく判断ログを残す」(:151) が成立しない。escalate/採点結果の統合フォーマット (§5, deliberation.md:111) を後から再構成できない。
- **監査**: どの lens がどの verdict を、どの prompt/model で出したか追跡不能 → 安全境界 (LLM 出力を状態根拠にしない) の事後検証ができない。
- **再現性**: codex は単発・ステートレス (`--ephemeral`)。provenance (prompt sha256 / template version / model / lineage) を残さないと rerun で同じ入力を再構成できない。
- **dashboard read-model (epic E / #233)**: 「jury verdict by finding」「escalate history」「severity 乖離レポート」を引くには **table-backed・query 可能**な蓄積が必要。free JSON では GROUP BY できない。

**設計目標**: 各案がアドホックに storage を発明せず、**共有 decision-log バックボーン** (provenance footprint + 提案/判定テーブル分離規約) に乗る。蓄積行は**監査/入力**であって状態遷移の権威にしない。

---

## 2. 検証済みの現状 (file:line)

### 2.1 migration 機構
- `src/db/schema.ts:21` `SCHEMA_VERSION = 30`。`src/db/migrations.ts:202` `LATEST_SCHEMA_VERSION = SCHEMA_VERSION`。
- `migrations.ts:45-49` `interface Migration = { version; name; statements: readonly string[] }`。`MIGRATIONS` 配列 v1–v30 (`:52-199`、末尾 v30 は `:194-198`)。**v31 は `MIGRATIONS` 配列末尾に `{ version: 31, name, statements: MIGRATION_V31_STATEMENTS }` を append し、`SCHEMA_VERSION` を 31 へ bump する**（`LATEST_SCHEMA_VERSION = SCHEMA_VERSION` なので 1 箇所）。
- `runMigrations`: per-migration IMMEDIATE txn + in-txn 再チェックで idempotent・concurrency-safe。
- `schema.ts` 末尾 `ALL_TABLE_NAMES` (`:1874-1895`) は `V1..V30_TABLE_NAMES` の**手動 union**。新テーブルは `V31_TABLE_NAMES` 定数を新設し union に `...V31_TABLE_NAMES` を append 必須。`DROPPED_TABLE_NAMES` (`:1898`) も維持（v31 は drop 無し）。

### 2.2 既存 review/hitch テーブルと **export-backed vs DB-only の正確な切り分け**
| テーブル | DDL | 分類 | 根拠 file:line |
|---|---|---|---|
| `review_decisions` | schema.ts:175 | **export-backed** | export-files.ts:162 (review-decision.yaml source_yaml), import-files.ts:70 (RESET_CHILD) |
| `review_required_changes` | schema.ts:184 (PK `(run_id, idx)`, `change_text` のみ) | **export-backed** | import-files.ts:71 (RESET_CHILD) |
| `review_proposals` | schema.ts:535 (+v11 `reviewer_id`/`prompt_sha256`/`prompt_provenance_json`/`lifecycle_status`/`archived_at`)。**active partial unique** `(run_id, reviewer) WHERE superseded_at IS NULL` (schema.ts:556) | **DB-only** | 全 RESET/import list に不在 |
| `review_consensus` / `review_rules` / `run_review_rule_snapshots` / `review_overrides` / `reviewers` | schema.ts:673-736。consensus も active partial unique `(run_id) WHERE superseded_at IS NULL` (schema.ts:735) | **DB-only** | 同上 |
| `hitch_convergence_decisions` | schema.ts:1406-1427 (`recommended_next_action TEXT` :1424、`metrics_json`、`reason`、**`payload` 列は無い**)。親 FK `hitch_id REFERENCES hitch_sessions ON DELETE CASCADE` (schema.ts:1789) | DB-only | 全 RESET/import list に不在 |
| `hitch_findings` | schema.ts:1342 (v16 `goal_findings`→v20 rename)。`finding_id` 単独 PK・`hitch_id` 通常列・親 FK `ON DELETE CASCADE`・unique `(hitch_id, stable_key) WHERE duplicate_of IS NULL` (schema.ts:1575)・severity CHECK に **`info` を含む** (schema.ts:1353) | DB-only | 同上 |

→ **新合議テーブルは DB-only パターン**。**FK は一切張らない**（P1-1）。refute が `review_required_changes` (export-backed) を FK 参照すると import で idx 再番号され orphan/詰まりが起きるし、`run_id REFERENCES runs` も import reset の legacy-file 削除（import-files.ts:114）で FK 違反を起こす。**refute は (run_id, idx) を FK 参照せず `sha256(normalized change_text)` (app 層計算) で bind** する (§3.2)。

### 2.3 packet 永続化先 (新 migration 不要を確認)
- `repository.ts:1791` INSERT は `recommended_next_action` 列に書く。`:1803-1805` `json(input.recommendedNextAction)` で serialize、`:2314-2317` `JSON.parse(...) as HitchNextAction` で round-trip。
- → `HitchNextAction` 型に **optional `decisionPacket`** を足すだけで packet 永続化可能。**migration 不要**。既存行は `decisionPacket===undefined` のまま壊れない (design-230:208-210)。

### 2.4 review_state_json は **specApproval 用の専用書込経路が無い**（既存 writer は note 用 `setNote()` のみ・CAS なし）— 操作上 load-bearing なギャップ
- `schema.ts` phases に `review_state_json TEXT` あり。**実ファイルは `src/roadmap/phase-repository.ts`**（P3-2 訂正、`src/db/` ではない）。`phase-repository.ts:14-20` で `reviewState: parse(r.review_state_json)` と読む。
- `phase-repository.ts:62-68` INSERT は `review_state_json` を**列挙しない**。`status`-only UPDATE が複数。**ただし `setNote()`（`phase-repository.ts:131-144`）は例外で `review_state_json` を read-modify-write（`reviewState` を読み `{ note }` を merge → `UPDATE phases SET review_state_json=? WHERE phase_id=?`）する既存 writer。これは `.immediate()`/CAS を使わない**。`cli/course.ts:667` UPDATE は `scope_json`/`close_conditions_json` のみ。
- → 「specApproval を review_state_json に migration 無しで書ける」は真。だが **specApproval 専用の書込メソッドが無い**（setNote は note 専用）。#231 着手前に `updateReviewState()` / `recordSpecApproval()` を新設し、**lost-update 対策（txn().immediate() + `review_state_version` CAS、§3.3 P1-3）を伴う**。**既存 `setNote()` も CAS（version bump）に揃えないと setNote↔specApproval 間で lost-update が残る**ため、P1-3 で setNote も CAS 経路へ移行する。design-231:170 が `updateSpec()` 経由を前提。
- 既存の `transitionStatus()`(`:116-152`) が CAS（`WHERE ... AND status IN (...)`）を、`add()`(`:45-70`) が `db.transaction(...).immediate()` を既に使っており、同方式で実装できる。

### 2.5 run_usage provenance (v30) と CHECK 制約
- `schema.ts:1815-1844` `run_usage(run_id, kind, seq, model, *_tokens, usage_source, PK (run_id,kind,seq))`。`kind` は**ハード CHECK IN ('coder','reviewer','evaluator')** (`:1818-1819`)。`usage_source` も CHECK。`kind` は PK 構成要素だが unique 単独でなく **FK 参照先にできない**。writer (`run-usage.ts:42`) は `(run_id,kind)` ごとに `MAX(seq)+1` で増分採番。
- 既存 v26 行は v30 で `kind='coder', seq=0` に backfill (`:1837-1839`、テーブル rebuild パターン)。
- → jury/refute proposer の usage は **既存 `kind='reviewer'` (lens proposer/refute reviewer) と `kind='evaluator'` (集約/severity audit pass) を再利用**。新 `kind` 値追加は CHECK を広げる rebuild migration が要るので**当面しない**。細粒度ラベル (jury_correctness 等) は**合議行自身の provenance 列**に持つ。`REFERENCES run_usage(kind)` は無効 SQL なので禁止。invocation を一意に戻すため、各合議行に nullable `usage_kind` / `usage_seq` を持たせ `(run_id, usage_kind, usage_seq)` で JOIN (P2-4)。

### 2.6 consistency / import / backup（**P1-1 / P1-4 反映**）
- `consistency.ts:395-403` RUNTIME 列挙は `runs` / `backlog_items` / `knowledge_candidates` の 3 つのみ (export drift check 対象)。新 DB-only テーブルは**ここに足さない**。
- `import-files.ts:45` `RESET_TABLES_FILE_DERIVED`、`:60` `RESET_TABLES_RUNTIME`、`:67-79` `RESET_CHILD_TABLES`。新テーブルは**どれにも足さない**。**訂正(P1-4)**: 足さないと既存 DB の audit 行は **import/reset 後も残る（消えない）**。空になるのは fresh DB の場合のみ（file source が無いから新規には作られない）。
- `import-files.ts:114` の reset は legacy-file の `runs` を削除する。**`run_id` を FK 参照すると、この削除が FK で詰まる（P1-1）** → v31 表は `run_id` を FK にしない。
- backup は `maintenance.ts:76` `await db.backup(opts.outPath)` (SQLite フル snapshot)。**テーブル列挙でなくファイル全体コピー** → 新テーブルは自動で backup に含まれる。`backup_catalog`/`archive_catalog` は backup の**メタ catalog** であり個別テーブル列挙はしない。

### 2.7 設計案の前提 (各 v2 ノートで確定済み)
- #229: profile→rule は `review_rules.source="project-profile"` 既存 enum 再利用、**新 table 不要** (design-229:268)。refute target binding は **Phase 2-0 として新規 schema+migration** が前提 (design-229:362-373)。free `review_refutes` 監査ゲート外 quorum は**明示棄却** (design-229:349-351)。
- #230: packet は `recommended_next_action` の additive JSON、**新 table 無し** (design-230:206-210)。severity audit は **advisory-only** (固定 mapping authoritative、降格は close gate を動かすため自動適用しない) (design-230:198-201)。
- #231: spec candidate は **harness 外 GitHub** (design-231:95)。批准記録は `review_state_json.specApproval` namespaced key (design-231:171-183)。link/start で specHash drift 検知 (design-231:200)。

---

## 3. 中核設計

### 3.0 共有 decision-log バックボーン (規約 + 最小テーブル)

「super-table を 1 本建てる」(Lens 5) ではなく、**①provenance footprint 規約 + ②提案/判定テーブル分離規約 + ③v31 で各案が乗る最小テーブル群**でフラグメンテーションを防ぐ。

**① provenance footprint (全合議入力行が持つ列の規約。GOAL_RULES に明記)**
```
run_id        TEXT      -- codex invocation の run lineage (advisory ID。FK しない: P1-1)
hitch_id      TEXT NULL -- hitch lineage (advisory ID。FK しない)
finding_id    TEXT NULL -- 対象 finding (advisory ID。FK しない。整合は §3.2 で repository/doctor 検査)
reviewer_id   TEXT NULL -- 登録済 reviewer (advisory。spec proposer は NULL 可、§Q5)
model         TEXT NULL -- codex/gpt-5.5/... (advisory)
prompt_sha256 TEXT NULL -- 組み立てた prompt の sha256 (app 層計算)
prompt_provenance_json TEXT NULL -- {template, version, knowledge, lens} (review_proposals v11 と同形)
usage_kind    TEXT NULL -- run_usage(kind) との相関 (P2-4)。'reviewer'|'evaluator'
usage_seq     INTEGER NULL -- run_usage(seq) との相関 (P2-4)
created_at    TEXT NOT NULL
```
run_usage との対応: invocation 単位は `run_usage(run_id, kind, seq)` で telemetry、合議行はその verdict を上記 footprint 付きで記録。JOIN は **`(run_id, usage_kind, usage_seq)`** で一意に戻す (P2-4)。**FK は一切張らない**（P1-1。親 purge 後も append-only に残し、doctor が orphan を advisory 報告）。

**② 提案/判定の構造的分離 (安全境界の DB 強制)**
- **提案テーブル** (`*_proposals` / `*_votes` / `*_audits`) = LLM 出力 = **append-only 入力/監査行**。`verdict`/`confidence`/`reasoning` を持つが、これらは決定論ゲートの**入力**であって状態を変えない。
- **判定** = 既存 `review_consensus` / `review_decisions` / `hitch_convergence_decisions` (harness 決定論ゲートが書く)。LLM 出力列をゲート入力に直結させない。
- 「判断ログ」= verdict + reasoning の構造化行 (会話全文は残さない、deliberation.md:151)。raw codex log は `.harness/audit/` のファイルに残し DB には載せない。

**③ v31 で建てる最小テーブル** (詳細 DDL §3.1–3.3): `review_refute_votes` (#229 P2-0)、`jury_classification_proposals` (#230)、`jury_severity_audits` (#230 advisory)。packet (#230) と specApproval (#231) は既存列の additive JSON。additive 列: phases に `review_state_version` (#231)。（#229 C4 の frozen set は **explicit reviewer_ids 前提で rule_json に載るため列追加不要**。listByGroup 自動解決の consensus は follow-up で別途 `run_review_rule_snapshots.resolved_reviewers_json` を追加。）

### 3.1 #229 — multi-lens consensus + refute

| アーティファクト | 決定 | storage | 理由 |
|---|---|---|---|
| (a) profile 由来 review rule | **既存再利用** | `review_rules.source="project-profile"` + `run_review_rule_snapshots` | enum 既存 (design-229:268)。schema 変更なし |
| (b) N proposals / consensus | **既存再利用** | `review_proposals` / `review_consensus` | distinct reviewer 複数 active、lifecycle_status supersede |
| (c) Phase 2 refute 票 target binding | **新 table `review_refute_votes` (v31)** | DB-only。target は `sha256(normalized change_text)` で bind (FK しない) | review_decisions/required_changes は global+text array のみ。決定論 bind 構造が無い (design-229:362-366) |
| (d) max_reviewers 等 | rule JSON 内 | (storage 不要) | |

**DDL — `review_refute_votes` (v31)** （P1-1: FK なし / P2-3: UNIQUE は business key / P2-4: usage_kind+seq / P3-1: confidence CHECK）
```sql
CREATE TABLE review_refute_votes (
  refute_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,        -- advisory ID。FK しない (P1-1)
  -- target binding: required_change を content hash で参照 (FK しない。export-backed 行の idx 再番号で orphan しないため)
  target_change_hash TEXT NOT NULL,   -- sha256(normalizeChangeText(change_text)) を app 層で計算。binding 不能/欠落(rejected)時は target_change_text or sentinel の harness 再計算 hash で常に非 NULL
  target_change_idx  INTEGER,         -- 記録時点の idx (advisory、binding には使わない)
  finding_id    TEXT,                 -- 対象 finding (advisory、FK しない)
  reviewer_id   TEXT NOT NULL,        -- 登録 reviewer の ID (advisory。FK しない)
  refute_verdict TEXT             -- rejected(malformed/missing_field)時は NULL 可。passed は必ず非 NULL(下の CHECK)
    CHECK (refute_verdict IS NULL OR refute_verdict IN ('uphold','refute','inconclusive')),
  confidence    REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),  -- advisory。gate を駆動しない (P3-1)
  reasoning     TEXT,                 -- 判断ログ (会話全文でない)
  -- G3 refute DSL 必須フィールドを構造化列で持つ (YAML 再パース不要・verifier/dashboard が直接 query 可。design-229 G3)
  refute_reason       TEXT,           -- passed の refute 票は非空 (下の CHECK。uphold/inconclusive は不要)
  counter_evidence_kind TEXT          -- diff | test | none。passed の refute 票は diff/test 必須、uphold/inconclusive は none/NULL 可 (下の CHECK)
    CHECK (counter_evidence_kind IS NULL OR counter_evidence_kind IN ('diff','test','none')),
  counter_evidence_ref  TEXT,         -- kind!=none のとき run artifact 参照 (refute layer の決定論 verifier が実在検証)
  refute_condition    TEXT,           -- 反証条件 (passed の refute 票は非空。uphold/inconclusive は不要)
  retract_condition   TEXT,           -- 撤回条件 (passed の refute 票は非空。uphold/inconclusive は不要)
  model         TEXT,
  prompt_sha256 TEXT NOT NULL,        -- CC11: business-key dedupe を NULL 重複で破らせない
  prompt_provenance_json TEXT,
  usage_kind    TEXT,                 -- run_usage(kind) 相関 (P2-4)
  usage_seq     INTEGER,              -- run_usage(seq) 相関 (P2-4)
  source_yaml   TEXT NOT NULL DEFAULT '',  -- refute agent の raw 出力 (監査)。malformed/no-output でも verbatim 保存し空文字で非 NULL 保証 (round10)
  source_sha256 TEXT NOT NULL,        -- = sha256(source_yaml)。source_yaml が常に非 NULL なので常に算出可。rejected の distinct 試行を一意化(codex round9/round10)
  validation_status TEXT NOT NULL DEFAULT 'rejected'   -- fail-closed default: 明示的に passed と書かれた票のみ集約対象 (codex round7)
    CHECK (validation_status IN ('passed','rejected')),  -- 全票を記録。集約に渡すのは passed ∧ verdict∈{uphold,refute} のみ (design-229 G2/G3。inconclusive は passed でも除外)
  reject_reason TEXT,                 -- rejected 時の決定論コード (unknown_target / hash_mismatch / missing_field / artifact_absent / evidence_none)。evidence_none は refute∧kind=none に限る（uphold/inconclusive の kind=none は正当で passed・rejected にしない）
  created_at    TEXT NOT NULL,
  CHECK (validation_status = 'passed' OR (reject_reason IS NOT NULL AND reject_reason <> '')),  -- rejected は必ず reason を持つ (audit 可能性、codex round3)
  CHECK (validation_status <> 'passed' OR refute_verdict IS NOT NULL),  -- passed は必ず verdict を持つ (codex round4: malformed は rejected 側で verdict NULL 可)
  -- passed の refute 票は G3 必須 DSL フィールド(儀式化対策)を構造的に持つ (codex round8 + round10: refute 限定)。
  -- 証拠強制は降格を駆動する refute_verdict='refute' に限定。uphold/inconclusive(降格を駆動しない)は
  -- target_change_hash(列 NOT NULL)+refute_verdict のみで passed 可(counter-evidence なし=kind∈{none,NULL})。
  -- これで「participant は uphold/refute 両方」(§3.1 validation_status コメント・design-229 G3)の stated モデルを満たす。
  -- malformed は rejected 側で verdict NULL 可。fail-closed: 証拠なし refute(kind=none/欠落)は passed CHECK 不成立→rejected。
  CHECK (validation_status <> 'passed' OR refute_verdict <> 'refute' OR (
    refute_reason IS NOT NULL AND refute_reason <> ''
    AND counter_evidence_kind IS NOT NULL AND counter_evidence_kind IN ('diff','test')  -- NOT NULL ガード必須: NULL IN(...) は NULL=非違反のため、kind 欠落 refute をすり抜けさせない(round10 fail-closed)
    AND counter_evidence_ref IS NOT NULL AND counter_evidence_ref <> ''
    AND refute_condition IS NOT NULL AND refute_condition <> ''
    AND retract_condition IS NOT NULL AND retract_condition <> ''))
);
-- passed のみ business key で一意 (集約入力の一意性・idempotent)。rejected には掛けない (codex round3/6)
CREATE UNIQUE INDEX review_refute_votes_passed_idx
  ON review_refute_votes(run_id, target_change_hash, reviewer_id, prompt_sha256)
  WHERE validation_status = 'passed';
-- rejected は監査 append-only。source_sha256(NOT NULL = sha256(source_yaml)、source_yaml も NOT NULL DEFAULT '') を
-- key に含め、distinct な失敗試行(source_yaml が違う = hash が違う)は共存・完全重複(同一 source)のみ dedup。
-- round9/round10: source_yaml/source_sha256 を NOT NULL 化し NULL distinct 問題を解消(COALESCE では別 source の
-- NULL 同士が '' に畳まれ誤 dedup していた)。no-output 票(source_yaml='')の同一 reviewer/prompt 再試行は同一 hash で
-- idempotent dedup(同一失敗の冪等記録＝許容)。
CREATE UNIQUE INDEX review_refute_votes_rejected_idx
  ON review_refute_votes(run_id, target_change_hash, reviewer_id, prompt_sha256, source_sha256)
  WHERE validation_status = 'rejected';
CREATE INDEX review_refute_votes_run_idx ON review_refute_votes(run_id, created_at);
CREATE INDEX review_refute_votes_target_idx ON review_refute_votes(run_id, target_change_hash);
```
- **DB-only** (export 非対象、既存 DB では import/reset 後も残る／fresh DB のみ空: P1-4)。**FK は一切張らない** (P1-1)。`target_change_hash` は app 層計算 (SQLite に sha256 関数は無い)。正規化は決定論 `normalizeChangeText()` を実装しテスト（付録B）。
- refute 票を decision に通すのは `evaluateConsensus` の決定論集約 (design-229 P2-C)。この表は**入力**で、**集約に渡すのは `validation_status='passed'` ∧ `refute_verdict ∈ {uphold,refute}` のみ**（`inconclusive` は passed でも quorum に数えない＝fail-closed 除外。`rejected` は監査保持＝binding 失敗/証拠欠落も追跡可能。design-229 G2/G3）。

### 3.2 #230 — classification jury / severity audit / decision packet

| アーティファクト | 決定 | storage | 理由 |
|---|---|---|---|
| (a) jury 分類提案 (3 lens) | **新 table `jury_classification_proposals` (v31)** | DB-only、1行/(finding,lens,reviewer) | 決定論集約は GROUP BY lens が要る。free JSON では引けない (Lens 2/3/5 一致) |
| (b) severity audit 票 | **新 table `jury_severity_audits` (v31)、advisory-only** | DB-only | 固定 mapping authoritative。降格自動適用しない (design-230:198) |
| (c) decision packet | **既存 `hitch_convergence_decisions.recommended_next_action` の additive JSON** | migration 不要 | round-trip 済 JSON 列 (§2.3) |
| (d) RACI | docs のみ | (DB 不要) | |

**DDL — `jury_classification_proposals` (v31)** （P1-1: FK なし / P1-2: hitch_id は denormalized advisory・整合は repository/doctor / P2-2: proposed_scope は `unknown`+別列 proposal_status / P2-3: UNIQUE は business key / P3-1: confidence CHECK）
```sql
CREATE TABLE jury_classification_proposals (
  proposal_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id    TEXT NOT NULL,        -- 権威キー。FK しない (P1-1)。整合は finding_id 経由 (P1-2)
  hitch_id      TEXT NOT NULL,        -- denormalized advisory (P1-2)。FK しない。
                                      --   repository insert で finding_id→hitch_findings.hitch_id 一致検査、
                                      --   doctor で (stored hitch_id)==(join hitch_id) を advisory チェック
  run_id        TEXT,                 -- codex invocation lineage (advisory。FK しない)
  lens          TEXT NOT NULL
    CHECK (lens IN ('correctness','scope_fit','spec_adherence')),
  reviewer_id   TEXT NOT NULL,        -- 登録 jury reviewer (advisory。FK しない。free-text proposer は別流)(P2-修正)
  proposed_scope TEXT NOT NULL
    CHECK (proposed_scope IN ('in_scope','out_of_scope','unknown')),  -- scope enum と一致 (P2-2)
  proposal_status TEXT NOT NULL
    CHECK (proposal_status IN ('complete','timeout','parse_error','inconclusive'))  -- 判定不能はここ (P2-2)
    DEFAULT 'complete',
  confidence    REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),  -- advisory (P3-1)
  reasoning     TEXT,                 -- 判断ログ
  model         TEXT,
  prompt_sha256 TEXT NOT NULL,        -- CC11: business-key dedupe を NULL 重複で破らせない
  prompt_provenance_json TEXT,
  usage_kind    TEXT,                 -- run_usage 相関 (P2-4)
  usage_seq     INTEGER,
  audit_dir_path TEXT,                -- jury/<hitch>/<finding>/<lens>.{stdout,stderr,events}
  created_at    TEXT NOT NULL
);
-- 1 invocation = 1 行。dedupe は business key (P2-3)
-- business key UNIQUE: finding_id + lens + reviewer_id(NOT NULL) + prompt_sha256 で dedupe
CREATE UNIQUE INDEX jury_classification_proposals_dedup_idx
  ON jury_classification_proposals(finding_id, lens, reviewer_id, prompt_sha256);
CREATE INDEX jury_classification_proposals_finding_idx
  ON jury_classification_proposals(finding_id, lens);
CREATE INDEX jury_classification_proposals_hitch_idx
  ON jury_classification_proposals(hitch_id, finding_id);
```

**DDL — `jury_severity_audits` (v31, advisory-only)** （P1-1: FK なし / P1-2: hitch_id advisory / P2-1: severity CHECK に info / P3-1: escalate_flag CHECK）
```sql
CREATE TABLE jury_severity_audits (
  audit_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id    TEXT NOT NULL,        -- 権威キー。FK しない (P1-1)
  hitch_id      TEXT NOT NULL,        -- denormalized advisory (P1-2)。整合は repository/doctor
  run_id        TEXT,                 -- advisory。FK しない
  harness_severity TEXT NOT NULL CHECK (harness_severity IN ('P0','P1','P2','P3','info')),  -- info 追加 (P2-1)
  jury_severity TEXT CHECK (jury_severity IN ('P0','P1','P2','P3','info')),                 -- info 追加 (P2-1)
  audit_status  TEXT NOT NULL CHECK (audit_status IN ('aligned','diverged','inconclusive')),
  escalate_flag INTEGER NOT NULL DEFAULT 0
    CHECK (escalate_flag IN (0,1)),   -- 1=人間 escalate (packet に積む)。severity は変えない (P3-1)
  reasoning     TEXT,
  model         TEXT,
  prompt_sha256 TEXT NOT NULL,        -- CC11: business-key dedupe を NULL 重複で破らせない
  usage_kind    TEXT,                 -- run_usage 相関 (P2-4)
  usage_seq     INTEGER,
  created_at    TEXT NOT NULL
);
-- NOTE: severity audit は **per-finding の単一集約行**（per-reviewer 票ではない）なので、§3.0 footprint の
-- reviewer_id 規約からは意図的に除外（business key に reviewer_id を含めない）。per-reviewer の severity 票が要る
-- なら follow-up で reviewer_id を追加し key を (finding_id, reviewer_id, prompt_sha256) にする。
CREATE UNIQUE INDEX jury_severity_audits_dedup_idx
  ON jury_severity_audits(finding_id, prompt_sha256);  -- business key (P2-3)
CREATE INDEX jury_severity_audits_finding_idx
  ON jury_severity_audits(hitch_id, finding_id);
```
- **`enforcement_mode='binding'` は schema に入れない** (Lens 1 棄却)。binding 列を持たせると LLM 由来行が severity 権威になり安全境界違反。**advisory のみで構造的に不可能**にする。
- 両表とも DB-only。**FK は一切張らない** (P1-1)。`hitch_id` は読み取り用 denormalized advisory で、権威は `finding_id` 経由の join。repository insert で `finding_id` から `hitch_findings.hitch_id` を引いて一致検査（不一致は reject）、doctor が `(stored)==(join)` を advisory チェック (P1-2)。**ON DELETE CASCADE は付けない**（そもそも FK なし。§3.4）。

**packet の型 (DDL 変更なし、`src/hitch/types.ts`)**
```ts
interface HitchNextAction {
  kind: ...; message: string; findingIds?: string[];
  decisionPacket?: HitchDecisionPacket;   // additive optional (design-230:209)
}
interface HitchDecisionPacket {
  packetVersion: 1;                        // バージョンは JSON 内に持つ (列にしない)
  decisionKind: 'classify_scope' | 'severity_audit' | 'operator_origin_unknown';
  evaluationAxes: Array<{ lens; lensVotes: {lens;scope;reasoning;confidence?}[]; consensus:'aligned'|'split' }>;
  severityAudit?: { harnessSeverity; juryConsensus; status; escalate: boolean };
  // ... design-230 §3.3
}
```

### 3.3 #231 — spec drafting / 人間批准（**P1-3 反映: lost-update 対策**）

| アーティファクト | 決定 | storage |
|---|---|---|
| (a) spec candidate / ギャップ行 | **harness 外 GitHub** (NGT/Delphi)。DB に table 持たない | .claude/ ファイル + PR (design-231:95) |
| (b) 人間批准記録 | **既存 `phases.review_state_json` の namespaced `{specApproval:{...}}`** | migration 不要。**ただし書き込み経路+CAS を新設 (§2.4 / P1-3)** |
| (c) spec approvals log | (b) から read-back | |

```jsonc
// phases.review_state_json (read-modify-write で他 key 保全)
{ "specApproval": { "approvedBy": "<actor>", "approvedAt": "<ISO>",
                    "reason": "<text>", "specHash": "sha256(canonical(scope)+canonical(close))" } }
```
- **書き込み経路の追加（migration 必要 — 軽微 additive 列）**: `review_state_json` の lost-update を防ぐため、phases に **`review_state_version INTEGER NOT NULL DEFAULT 0`** を v31 で additive 追加（P1-3）。`phase-repository.ts` に下記を新設:
  - `updateReviewState(phaseId, mutator)`: `db.transaction(...).immediate()` 内で `SELECT review_state_json, review_state_version` → mutator で merge → `UPDATE phases SET review_state_json=?, review_state_version=review_state_version+1, updated_at=? WHERE phase_id=? AND review_state_version=?` の **CAS**。`changes===0` なら再読込してリトライ（最大 N 回）か `LeaseGuardFailedError` 同様の競合エラー。read-modify-write は他 key を保全。
  - `recordSpecApproval(phaseId, {approvedBy, reason})`: `updateReviewState` を使い `specApproval` key のみ書く。specHash は **scope_json + close_conditions_json から TS 側で canonical JSON 計算**（SQLite sha256 無し）。
  - `add()`(`:45`) / `transitionStatus()`(`:116`) が既に `.immediate()` / CAS を使うのと同方式。`review_state_version` は v31 で既存行に DEFAULT 0 が入るので後方互換。
- specHash は link/start で drift 検知 (design-231:200、reject はしない warning)。

### 3.4 consistency / doctor / import-export / backup の扱い（**P1-1 / P1-4 反映**）

- **consistency.ts RUNTIME 列挙に新テーブルを足さない** (DB-only、export drift 非対象)。
- **import-files.ts の RESET/RUNTIME/CHILD list に足さない**。**訂正(P1-4)**: 足さないことで既存 DB の audit 行は import/reset 後も **残る（消えない）**。空になるのは fresh DB のみ。DB-only audit を消す retention/repair は **別コマンドに分離**（§9 follow-up。reset で巻き込まない）。
- **doctor**: 新規 integrity check を `doctor_runs`/`doctor_findings`/`repair_actions` フローに追加 (§TDD)。チェックは TS で recompute (SQLite sha256 無いため doctor の SQL で sha256 を呼ばない):
  - orphan proposal/vote/audit (finding_id/run_id/hitch_id が消えた行) → **advisory finding**。**FK を張らない (P1-1) ので親 purge 後も行は残り、doctor が orphan を報告する**（これが「append-only audit を保つ」設計の要）。
  - hitch_id 整合 (P1-2): `(stored hitch_id) != (finding_id から join した hitch_findings.hitch_id)` → advisory finding。
  - refute hash 不整合: TS で `sha256(normalizeChangeText(change_text))` を再計算し `target_change_hash` と比較。
  - packet↔votes 整合 (packet が unanimous と言うが proposals が split) → advisory。
  - **repair の DELETE は破壊的なので default dry-run + operator 明示承認の後ろに gate** (fail-closed)。auto-DELETE しない。
- **FK を張らない理由 (P1-1)**: `openDb` は `foreign_keys = ON`(connection.ts:44)。親 FK + `ON DELETE` 無しだと親削除が FK で**失敗**し「orphan として残す」が成立しない。かつ import reset の legacy-file `runs` 削除(import-files.ts:114)が詰まる。よって `run_id`/`hitch_id`/`finding_id` を FK にせず advisory ID とし、doctor で orphan を検出する（監査 append-only と両立）。
- **backup**: `db.backup()` フル snapshot で自動包含 (§2.6)。table 列挙不要。**retention/容量上限は follow-up** (jury votes × lens × findings で増大、§9)。
- **ALL_TABLE_NAMES に `V31_TABLE_NAMES` を追加** (`review_refute_votes`, `jury_classification_proposals`, `jury_severity_audits`)。union (schema.ts:1894) に `...V31_TABLE_NAMES` を append。phases への列追加 (`review_state_version`) は table 名を変えないので V31_TABLE_NAMES には載らない（ALTER のみ）。

### 3.5 provenance / 判断ログ モデル (run_usage 一貫)

- 各 codex invocation: `run_usage(run_id, kind, seq)` に telemetry (jury lens/refute reviewer → `kind='reviewer'`; 集約/severity audit pass → `kind='evaluator'`)。**CHECK は広げない** (§2.5)。
- verdict 行 (refute/jury/severity): §3.0 footprint を inline 列で持つ。**`(run_id, usage_kind, usage_seq)` で run_usage と一意 JOIN** (P2-4。FK は張らない: P1-1)。
- 判断ログ = verdict + reasoning の構造化行。会話全文は DB に載せない (deliberation.md:151)。raw log は `audit_dir_path` のファイル参照のみ。
- 集約結果 (`hitch_convergence_decisions.recommended_next_action.decisionPacket`) は決定論ゲート出力。`evaluationAxes` に lens votes を advisory 記録。

### 3.6 共有 backbone の一般化度 (採用/棄却)

- **採用 (中道、Lens 2/3)**: v31 で 3 テーブル + footprint 規約 + packet/specApproval を既存列 JSON + phases に `review_state_version` 1 列 additive。`deliberation_rounds`/`agent_proposals` の anchor super-table は**建てない**。
- **棄却 (Lens 5)**: super-table は D/E 設計が未確定の段階で過剰一般化。かつ具体 DDL が無効 (`agent_proposals.run_usage_id REFERENCES run_usage(invocation_id)` — そんな列無し、v30 PK は `(run_id,kind,seq)`; `REFERENCES run_usage(kind)` — kind は unique でない)。
- **棄却 (Lens 1)**: severity `enforcement_mode='binding'`、新 `judgment_log_json`/`decision_packet_json` 列 (既存 round-trip JSON 列で足りる churn)。
- **アンチフラグメンテーションは「規約 (GOAL_RULES の footprint + 分離ルール) を文書化」で 80% 達成** — D/E が後から乗れる。

---

## 4. work item DAG

(下の workItemDag 参照。サマリ: **DB-WI-0 (review_state_json 書き込み経路 + `review_state_version` CAS、#231 の前提・軽微 additive 列)** → **DB-WI-1 (v31 schema/migration の 3 テーブル + phases ALTER)** → repository 層 (refute/jury/severity、finding_id→hitch_id 整合検査)、packet 型、specApproval 書き込み (txn+CAS) → consistency/doctor (orphan/hash/hitch_id 整合) → docs/tests。各 WI は #229/#230/#231 紐付けを明記。)

**migration 連番の単一予約ブロック**: #229/#230/#231 は**全て v31 を共有** (1 migration block)。各案で v31/v32/v33 に分けない (v29↔v30 renumber 再発回避)。schema.ts に `// RESERVED v31 for epic #228 consensus artifacts` コメントを置き、PR merge 順を強制。LATEST bump は v31 へ 1 回のみ。**v31 statements**: 3 テーブル CREATE + index + `ALTER TABLE phases ADD COLUMN review_state_version INTEGER NOT NULL DEFAULT 0`（#229 C4 frozen set は explicit reviewer_ids 前提で rule_json に載るため列追加なし。listByGroup 自動解決は follow-up）。

---

## 5. 安全境界マッピング

| 不可侵境界 | DB 設計での守り方 | 該当 |
|---|---|---|
| LLM 出力 ≠ 状態遷移の権威 | refute/jury/severity は append-only **提案/監査テーブル** (§3.0②)。verdict/confidence 列はゲートの**入力**。状態遷移は `evaluateConsensus`/`aggregateJuryVotes`/`processReviewDecision`/convergence の決定論ゲートのみ | 全 v31 表 |
| severity 自動降格禁止 | `jury_severity_audits` は **advisory-only**。`enforcement_mode` 列を**作らない**。固定 mapping (review-integration.ts:291/310/330) authoritative。escalate_flag は packet に積むだけ (CHECK IN (0,1)) | jury_severity_audits |
| 状態遷移は harness のみ | LLM 出力列 → 状態テーブルへの直接 UPDATE 経路を作らない。提案表と decision/consensus 表を物理分離 | 全表 |
| 蓄積行が権威にならない | confidence は float gate にしない (design-230:187、CHECK 0..1 は範囲健全性のみ)。refute_verdict は決定論集約に通す入力 | refute/jury |
| provenance/再現性 | footprint (prompt_sha256/template_version/model/lineage/usage_kind+seq) を全行に。判断ログのみ・会話全文残さない | §3.5 |
| migration additive・後方互換 | v31 は CREATE TABLE/INDEX + phases に 1 列 additive(DEFAULT 0) + 既存列 additive JSON のみ。DROP/RENAME/列削除無し。**FK 一切無し** (orphan/import 詰まり回避) | §3.1-3.3 |
| 人間批准 state の lost-update 防止 | `recordSpecApproval`/`updateReviewState` は txn().immediate() + `review_state_version` CAS で他 key/同時 approval を保護 | §3.3 (P1-3) |
| 迷ったら fail-closed | refute hash 不一致=reject (design-229:370)。doctor DELETE repair は dry-run + operator 承認 gate。jury split→escalate (auto-confirm しない)。CAS 競合→リトライ/エラー(後勝ち禁止) | §3.4 |

---

## 6. TDD テスト計画

**migration**: (1) `MIGRATIONS` に v31 が version 順・name・statements 非空。`LATEST_SCHEMA_VERSION=31`。(2) fresh DB v1→v31 適用後 `schema_migrations` に 31 行。3 テーブル存在 + phases に `review_state_version` 列 (PRAGMA table_info)。(3) v30→v31 upgrade で既存 review/hitch テーブル無変更、3 テーブル追加、既存 phase 行に `review_state_version=0` が入る。(4) idempotent: 2 回目 run は no-op。(5) `ALL_TABLE_NAMES` に V31 名が含まれ重複なし。(6) **FK が無いことの確認**: PRAGMA foreign_key_list が v31 3 表で空。

**round-trip / import-export (P1-4 反映)**: (1) v31 表に行を入れ `db export-files` → 表は file 化されない (DB-only)。(2) **既存 DB に v31 行を入れて `db import --from-files`（reset 含む）→ v31 行は残る（消えない）。fresh DB を import したときだけ空**（P1-4 を明示 assert）。(3) refute 行を入れ、import で required_changes 再構築 → refute 行は `target_change_hash` 経由で参照保持 (idx 変化に影響されない)。(4) **legacy-file run を reset で削除しても、`run_id` を FK 参照しない v31 行は FK 違反で詰まらず残る**(P1-1)。(5) `db.backup()` snapshot に v31 表行が含まれ restore で復元。

**consistency / doctor (P1-1 / P1-2 反映)**: (1) RUNTIME 列挙に v31 表が出ない。(2) orphan proposal/vote/audit (finding/run/hitch 削除後も行が残る) → advisory finding。(3) **hitch_id 整合: stored hitch_id != finding_id から join した hitch_id → advisory** (P1-2)。(4) refute hash 不整合 → TS recompute で検出。(5) packet↔votes 不整合検出。(6) repair DELETE は dry-run default、--apply 必須。

**determinism**: (1) `aggregateJuryVotes` 純関数: 同 proposals → 同 decision。confidence 変えても decision 不変 (no-float-gate)。(2) `auditSeverity` 純関数: aligned/diverged/inconclusive 決定論、固定 mapping 不変、severity 自動降格しない。(3) proposal/refute insert の business-key UNIQUE (P2-3) で retry 二重挿入を防ぐ。(4) **repository insert が finding_id→hitch_id 不一致を reject** (P1-2)。

**refute votes CHECK / disposition (G3 / round10。証拠強制は refute 限定)**: (a) passed ∧ refute ∧ kind=none → passed CHECK 違反（=rejected 側へ、reject_reason=evidence_none で記録可）。(a') passed ∧ refute ∧ kind=NULL（列欠落）∧ 他 DSL 充足 → passed CHECK 違反（`NULL IN(...)` すり抜け防止の NOT NULL ガードを assert）。(b) passed ∧ refute ∧ refute_reason / refute_condition / retract_condition / counter_evidence_ref のいずれか欠落 → CHECK 違反。(c) passed ∧ refute ∧ kind∈{diff,test} ∧ 全 DSL 充足 ∧ ref 非空 → INSERT OK。(d) **passed ∧ uphold ∧ kind=none かつ DSL フィールド NULL → INSERT OK**（uphold は target_change_hash+verdict のみで passed＝refute-conditional の核。証拠強制で誤って participant 分母から脱落しないことを assert）。(e) passed ∧ inconclusive ∧ kind=none → INSERT OK。(f) rejected ∧ reject_reason NULL/空 → CHECK 違反（round3）。(g) passed ∧ refute_verdict NULL → CHECK 違反（round4）。(h) `source_yaml` NOT NULL DEFAULT '' / `source_sha256` NOT NULL（round10）: NULL yaml で INSERT 不能、空出力は '' で記録可。(i) partitioned UNIQUE: passed は business-key で二重挿入 dedup、rejected は source_sha256 を含み distinct 失敗試行が共存。(j) **集約入力 filter**: passed ∧ verdict∈{uphold,refute} のみ集計に渡り、inconclusive は passed でも除外。

**review_state CAS (P1-3)**: (1) `recordSpecApproval` で specApproval 記録、specHash = sha256(canonical scope+close)、`review_state_version` が +1。(2) **並行 read-modify-write シミュレーション**: stale version での CAS が `changes===0` で no-op（後勝ちで他 key を消さない）→ リトライ後に両 key 保全。(3) 他 key (任意の review fact) を保全。

**後方互換 / 回帰**: (1) Phase 11 review (review_proposals/consensus/review-processor) 無影響。(2) `recommended_next_action` の既存 packet 無し行が `decisionPacket===undefined` で parse OK。(3) phase INSERT/UPDATE 既存挙動不変（`review_state_version` DEFAULT 0 で既存テスト緑）。(4) `info` severity を持つ finding が severity audit を通せる/明示除外できる (P2-1)。

**#231 spec gate**: (1) link/start で specHash drift → warning。(2) scope 拡大は `--allow-scope-widen` 無しで reject。

---

## 7. docs/specs 更新 (同コミット)

(下の specUpdates 参照。db.md に「v31 合議アーティファクト DB-only 監査表」節、export-backed vs DB-only 切り分け表、**FK を張らない理由（foreign_keys=ON + import reset、P1-1）**、**import で空になるのは fresh DB のみ（P1-4）**、refute content-hash binding、`hitch_id` denormalized advisory + 整合検査（P1-2）、doctor 非破壊 repair。GOAL_RULES に provenance footprint 規約（usage_kind+seq 含む、P2-4） + 提案/判定分離 + severity advisory-only + 共有 v31 予約。hitch-convergence.md に decisionPacket format。roadmap.md に specApproval namespaced key + `updateReviewState`/`recordSpecApproval` 書き込み経路 + `review_state_version` CAS（P1-3）。)

---

## 8. 受け入れ条件

1. v31 migration が additive・後方互換 (v30→v31 で既存テーブル/行/import 無破壊。phases に `review_state_version` DEFAULT 0 を additive 追加)。fresh DB と upgrade DB の両方で適用、idempotent。
2. `review_refute_votes`/`jury_classification_proposals`/`jury_severity_audits` が DB-only (export 非対象、backup 包含)。**既存 DB では import/reset 後も残り、空になるのは fresh DB のみ**(P1-4)。`ALL_TABLE_NAMES` に登録。
3. refute target が content hash bind (export-backed 行に FK せず import round-trip 不破壊)。**3 表とも FK 一切無し** (P1-1)。
4. severity audit が advisory-only (binding 列無し、`info` も扱える: P2-1)。固定 mapping/close gate 不変の回帰緑。`escalate_flag` は CHECK IN (0,1) (P3-1)。
5. packet が既存 `recommended_next_action` JSON に additive (migration 無し、既存 reader 不破壊)。
6. specApproval が review_state_json namespaced key、**書き込み経路 `recordSpecApproval` 新設 + `review_state_version` CAS で lost-update 防止**(P1-3)、他 key 保全。
7. provenance footprint が全合議行に一貫 (`(run_id, usage_kind, usage_seq)` で run_usage と一意 JOIN: P2-4、`kind` CHECK 不変)。
8. doctor が orphan/hash 不整合/**hitch_id 整合**(P1-2)を advisory 検出 (FK を張らないので親 purge 後も行が残る: P1-1)、DELETE repair は非破壊 default。
9. 関連テスト + typecheck 緑 (サブ Phase)、フルスイート + typecheck 緑 (大 Phase)。回帰禁止。
10. docs/specs を同コミット更新。

---

## 9. スコープ外 / follow-up

- **normalized `decision_packets` テーブル** (dashboard が packet フィールド検索を要求したら): epic E/#233 と紐づく後続 migration へ defer。今は JSON。
- **run_usage.kind 細粒度化** (jury_correctness 等の telemetry): CHECK rebuild migration が要るので reporting 要件が固まってから。今は `usage_kind`+`usage_seq` で reviewer/evaluator に相関 (P2-4)。
- **jury 監査表の retention/容量上限 + DB-only audit の prune コマンド** (votes × lens × findings 増大): 自動 prune は follow-up。**reset では消さない (P1-4) ので、明示的な別コマンド `db prune-audit` 等を別途設計**。今は全保持。
- **spec proposer の reviewers 登録** (#231 agent を FK 化するか free-text か): §Q5。当面 free-text + 監査性低下を docs 明記。
- **dashboard read-model materialized view** (E): provenance/lineage キーを予約するのみ。view は建てない。
- **needs_classification jury の quorum/tie-break 決定論集約ロジック** (`aggregateJuryVotes`): #230 本体スコープ。**v31 表は決定論ゲート spec が固まってから/と同時に出荷** (提案行だけ先行させて LLM→状態直結を招かない)。
- **operator が packet を read/override する CLI/MCP UX**: read は既存 listDecisions 流用、専用 UX は follow-up (design-230:458)。

---

# 付録A: 人間批准が必要な争点（open questions）

## Q1. 共有 backbone の一般化度: v31 で deliberation_rounds/agent_proposals の anchor super-table を建てるか、案ごとの最小テーブル (refute/jury/severity の 3 表) + provenance footprint 規約に留めるか。
**→ 委員会推奨**: A (中道。3 表 + footprint 規約のみ)。Lens 5 の super-table 案は具体 DDL が無効かつ D/E 設計未確定で過剰一般化。C は #230 の決定論集約が GROUP BY する対象を失い strand する。

## Q2. spec candidate を DB テーブルに materialize するか、harness 外 GitHub ファイルのみに留めるか。
**→ 委員会推奨**: A (harness 外ファイルのみ。design-231:95 と整合)。dashboard が候補直接 query を要求したら C で v32 materialize に昇格。

## Q3. migration 粒度: #229/#230/#231 を全て単一 v31 にまとめるか。
**→ 委員会推奨**: A (全て単一 v31、RESERVED コメント + PR merge 順強制)。3 issue は additive で相互依存が薄く、衝突点を 1 つに集約し renumber リスク最小。

## Q4. spec proposer を reviewers レジストリに登録するか、free-text のまま監査性を一段下げるか。
**→ 委員会推奨**: A (free-text agent_id)。spec candidate は harness 外生成で run_usage 相関が元々無い。批准記録 (specApproval.approvedBy) は人間 actor で監査の本丸はそこ。候補 provenance は GitHub git history が正本。

## Q5（新規 — codex P1-3 / P2-4 由来）. `review_state_version` の競合解決ポリシー: CAS 失敗時にリトライ（read→merge→retry）か即エラーか。並行 writer が複数現れた場合の merge 規則。
**→ 委員会推奨**: A (CAS + bounded リトライ)。`add()`/`transitionStatus()` の既存 CAS 流儀に合わせ、stale version は read 再取得して merge し直す（最大 N 回。超過は競合エラーで fail-closed、後勝ち禁止）。複数 module が同時に別 key を書く想定が今は無いので read-modify-write + CAS で十分。専用 merge 関数は writer が増えたら検討。

---

# 付録B: 残余リスク

- export-backed→DB-only FK ハザード: **FK を一切張らない方針 (P1-1) で根本回避**。代わりに refute を content hash bind にするが、`normalizeChangeText()` の正規化規則 (whitespace/case/punctuation) が未定義。app 層に決定論 `normalizeChangeText()` を実装しテストしないと、同一 change の hash が環境差でブレて binding が壊れる。
- review_state_json の並行書き込み: **`review_state_version` CAS + txn().immediate() で対策 (P1-3)**。CAS リトライ上限超過時の競合エラー UX を docs 化しないと、operator が稀な競合で混乱する。
- needs_classification jury の決定論集約 (aggregateJuryVotes) が #230 本体スコープで未実装。v31 提案テーブルだけ先行着地すると、実装者が LLM verdict→状態を直結する誘惑が生じる。「決定論ゲート spec が固まってから/と同時に表を出荷」を強制しないと安全境界が崩れる。
- doctor の DELETE repair が破壊的: orphan/hash/hitch_id 不整合の repair を auto-apply にすると保全すべき監査行を消す。dry-run default + operator 明示承認 gate を入れ忘れると監査 trail 喪失。**reset で消さない (P1-4) ので prune は別コマンドに分離する設計を守る**。
- jury 監査表の無制限増大: votes × 3 lens × findings/hitch で行数が膨らみ backup サイズと query 性能を圧迫。retention/prune は follow-up としたが、大規模 hitch で doctor の orphan full-scan が遅くなる (finding_id index で緩和するが未保証)。
- decisionPacket JSON のスキーマ進化: packetVersion を JSON 内に持つが、将来フィールド追加で旧行を読む reader が壊れる可能性。optional chaining + デフォルト fallback を全 reader (dashboard/MCP/CLI) に徹底しないと後方互換が崩れる。
- hitch_id denormalized の drift (P1-2): `hitch_id` を advisory で持つので、repository insert の一致検査を忘れると stored hitch_id がずれる。insert 検査 + doctor advisory の両方を実装しないと整合が緩む。
- run_usage.kind 再利用 (reviewer/evaluator) で jury/refute を区別する細粒度が失われる。`usage_kind`/`usage_seq` で invocation には戻せるが (P2-4)、run_usage 単独集計では jury と通常 review が混ざる。telemetry-by-jury-kind は合議行の provenance 列 JOIN でしか引けない。

---

# 付録C〜E: 反証検証・起案要旨・批判ラウンド

（v1 から不変。付録C の前提1〜5 反証検証、付録D の起案5体要旨、付録E の MECE ギャップ/採点/推奨 backbone は v1 のまま保持。要点: backbone = Lens 2、grafted with Lens 3 provenance + Lens 4 consistency。MECE ギャップが指摘した「export-backed→DB-only FK ハザード」「SQLite に sha256 無し」「review_state_json 書込経路ゼロ」「CASCADE vs audit-immutability 矛盾」は本 v2 の P1 反映で全て解消済み。）

---

# 付録F: codex exec gpt-5.5 xhigh レビュー（**v2 で本文反映済み**）

> 下記は付録F 原文（v1 で取得）。**本 v2 で P1-1〜P1-4 / P2-1〜P2-4 / P3-1〜P3-2 を §2/§3/§6/§8 本文に織り込み確定した**（v2 改訂履歴参照）。原文は監査のため保持。

**総合判定**: GO-with-fixes。backbone 方針、v31 単一 migration、packet/specApproval の additive 方針は妥当。FK ライフサイクル / import-reset 期待値 / jury 表の整合制約を DDL 確定前に直すべき → **v2 で全て反映**:
- **P1-1** FK + `foreign_keys=ON`(connection.ts:44) の矛盾 → §3.0/§3.1/§3.2: `run_id`/`hitch_id`/`finding_id` を FK にせず advisory ID、doctor で orphan 検出。
- **P1-2** `hitch_id`/`finding_id` 別々 FK の不整合 → §3.2: `hitch_id` を denormalized advisory にし、`finding_id` から join で整合検査（repository insert + doctor）。
- **P1-3** `review_state_json` lost-update → §3.3: `updateReviewState`/`recordSpecApproval` を txn().immediate() + `review_state_version` CAS で保護。
- **P1-4** 「RESET list に足さない→import で空」誤り → §2.6/§3.4/§6/受け入れ条件②: 「file import は新 DB-only 表を変更しない。空になるのは fresh DB のみ」に訂正。
- **P2-1** severity CHECK に `info` → §3.2: `P0..P3,info`。
- **P2-2** `unknown_inconclusive` が scope enum 不一致 → §3.2: `proposed_scope` は `unknown`、判定不能は `proposal_status` 別列。
- **P2-3** `UNIQUE(...,created_at)` 弱い → §3.1/§3.2: business key UNIQUE + INDEX 化。
- **P2-4** run_usage JOIN を run_id のみは不一意 → §3.0/§3.5: `usage_kind`/`usage_seq` 列で `(run_id, usage_kind, usage_seq)` JOIN。
- **P3-1** `escalate_flag`/`confidence` CHECK 欠如 → §3.2: `CHECK (escalate_flag IN (0,1))`、`CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)`。
- **P3-2** `phase-repository.ts` パス → §2.4/§3.3: `src/roadmap/phase-repository.ts` に訂正。

---

# 付録C: 反証検証した主要アーキ前提

### 前提1 — **partial**
- 主張: The stated DB architecture premises: (1) ".harness/harness.sqlite" is DB-canonical; (2) files are compatibility export; (3) migration system is {version, name, statements} arrays; (4) LATEST_SCHEMA_VERSION=30; (5) new schemas are v31+ with LATEST bump; (6) schema_migrations table tracks applied versions; (7) existing review/consensus tables exist; (8) jury/refute/classification/packet tables are absent (by design for Phase 2); (9) migrations are strictly additive/backward-compatible; (10) DB-only monitoring/audit tables don't export to files.
- 根拠: ✓ **Confirmed (verified in code)**:

### 前提2 — **confirmed**
- 主張: 既存の review_proposals / review_consensus / review_rules / run_review_rule_snapshots / review_required_changes / review_decisions / review_overrides / reviewers テーブルが在り、needs_classification jury 分類提案 / escalation 決定パケット / 反証 refute 票 / spec candidate を格納する専用テーブルは無い。
- 根拠: 

### 前提3 — **refuted**
- 主張: The DB architecture premise states: "convergence の決定は goal_convergence_decisions に格納され(recordConvergenceDecisionWithStatus 経由)、payload に JSON を持つ。phases テーブルは scope_json/close_conditions_json/review_state_json の free-JSON 列を持ち、spec 批准は review_state_json に migration 無しで記録できる。"
- 根拠: **CRITICAL DIVERGENCE FOUND — 3 points of failure:**

### 前提4 — **partial**
- 主張: Premise: DB-only consensus tables (review_proposals, review_consensus model) are not file-exported, so on import they remain NULL/empty. New tables follow this pattern.
- 根拠: Code verification of export/import architecture: (1) RUNTIME export drift checks (consistency.ts:395-422) monitor only [runs, backlog_items, knowledge_candidates]. Correct. (2) review_decisions is export-backed (NOT DB-only): export-files.ts:157-164 exports review_decisions.sourc

### 前提5 — **confirmed**
- 主張: The v30 run_usage table (per-invocation token tracking with kind='coder'|'reviewer'|'evaluator') provides a **proven provenance + telemetry foundation**, and **no jury/refute/severity-audit DB tables currently exist** that the 3 design proposals (#229/#230/#231) require. The existing additive migration pattern (v1-v30, LATEST_SCHEMA_VERSION=30) is backward-compatible and extensible.
- 根拠: 

---

# 付録F: codex exec gpt-5.5 xhigh レビュー（v1 への指摘 = v2 改訂根拠）

**前提確認**
`SCHEMA_VERSION=30` / `LATEST_SCHEMA_VERSION=SCHEMA_VERSION` は確認済みです。実 DB も `schema_migrations max=30 count=30` でした。`hitch_sessions` / `hitch_findings` / `hitch_convergence_decisions` は実在し、`goal_*` は v20 で rename 済みです。提案 DDL は最小親テーブル付き `:memory:` DB では CREATE 自体は通りました。

**P0**
なし。

**P1**
1. 該当箇所: §3.2 / §3.4 DDL と “CASCADE delete を付けないので orphan として残す”
問題: FK を張ったまま `ON DELETE` なしにすると、親削除時に audit 行が orphan として残るのではなく、削除が FK で失敗します。`review_refute_votes.run_id REFERENCES runs` も同じく、file import/reset が legacy-file run を消すときに詰まる可能性があります。
根拠: `openDb` は `foreign_keys = ON` を有効化しています [connection.ts](/Users/kn/ops/monorepo-harness/src/db/connection.ts:42)。`hitch_findings` / `hitch_convergence_decisions` の親 FK は実在します [schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:1342), [schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:1406)。import reset は子リスト外の新 DB-only 表を消さず、legacy-file `runs` を消します [import-files.ts](/Users/kn/ops/monorepo-harness/src/db/import-files.ts:67), [import-files.ts](/Users/kn/ops/monorepo-harness/src/db/import-files.ts:114)。
推奨修正: audit 行を親 purge 後も残すなら `run_id`/`hitch_id`/`finding_id` は FK にせず advisory ID とし、doctor で orphan を検出。参照整合を優先するなら `ON DELETE CASCADE`/`SET NULL` にし、§3.4 の “orphan として残す” と import 期待値を修正してください。

2. 該当箇所: §3.2 `jury_classification_proposals` / `jury_severity_audits`
問題: `hitch_id` と `finding_id` を別々に FK しているため、`hitch_id=h1` かつ `finding_id` は別 hitch の `f2` という不整合を DB が許します。
根拠: `hitch_findings` は `finding_id` 単独 PK で、`hitch_id` は通常列です [schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:1342)。既存 unique は `(hitch_id, stable_key)` で、`(hitch_id, finding_id)` ではありません [schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:1575)。
推奨修正: `hitch_id` を保存せず `finding_id` から join で引く、または `hitch_findings(hitch_id, finding_id)` unique index + composite FK にする。FK を外す場合も repository insert と doctor で不一致を検出してください。

3. 該当箇所: §3.3 `updateReviewState()` / `recordSpecApproval()`
問題: read-modify-write 競合対策が設計に不足しています。`review_state_json` は人間批准の load-bearing state になるため、単純な read → merge → update では他 key や同時 approval を lost update します。
根拠: 現状は parse read のみ [phase-repository.ts](/Users/kn/ops/monorepo-harness/src/roadmap/phase-repository.ts:14)、INSERT は `review_state_json` を書きません [phase-repository.ts](/Users/kn/ops/monorepo-harness/src/roadmap/phase-repository.ts:63)、既存 UPDATE は status または scope/close のみです [phase-repository.ts](/Users/kn/ops/monorepo-harness/src/roadmap/phase-repository.ts:105), [course.ts](/Users/kn/ops/monorepo-harness/src/cli/course.ts:667)。
推奨修正: `db.transaction(...).immediate()` 内で read/merge/write し、可能なら `WHERE phase_id=? AND review_state_json IS ?` の CAS、または phase 用 `state_version` を導入。specHash は設計通り TS 側で canonical JSON から計算。

4. 該当箇所: §3.4 / §6 import-export テスト
問題: “RESET list に足さない → file import で空のまま” は誤りです。足さなければ既存 DB-only 行は import/reset 後も残ります。空になるのは fresh DB の場合だけです。
根拠: reset 対象は固定リストのみ [import-files.ts](/Users/kn/ops/monorepo-harness/src/db/import-files.ts:45), [import-files.ts](/Users/kn/ops/monorepo-harness/src/db/import-files.ts:60), [import-files.ts](/Users/kn/ops/monorepo-harness/src/db/import-files.ts:67)。
推奨修正: 受け入れ条件を “file import は新 DB-only 表を変更しない。fresh import では空” に修正。DB-only audit を消す repair/retention は別コマンドに分離。

**P2**
1. 該当箇所: §3.2 `jury_severity_audits`
問題: `harness_severity` / `jury_severity` CHECK が `P0..P3` のみで、現行 `hitch_findings.severity` の `info` を扱えません。
根拠: 現 schema/type は `info` を含みます [schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:1353), [types.ts](/Users/kn/ops/monorepo-harness/src/hitch/types.ts:100)。
推奨修正: `info` を CHECK に含めるか、severity audit 対象から `info` を明示除外して repository 側で保証。

2. 該当箇所: §3.2 `jury_classification_proposals.proposed_scope`
問題: `unknown_inconclusive` は現行 `HITCH_SCOPE_STATUSES` と一致しません。最終状態は `unknown` です。
根拠: scope enum は `in_scope/out_of_scope/unknown/duplicate` [types.ts](/Users/kn/ops/monorepo-harness/src/hitch/types.ts:110)。
推奨修正: `proposed_scope` は `unknown` に寄せ、inconclusive は別列 `proposal_status` などで表す。

3. 該当箇所: §3.1-3.2 UNIQUE
問題: `UNIQUE (..., created_at)` は retry dedupe として弱く、同一 timestamp 衝突もあり得ます。
根拠: 既存は active partial unique や business key unique を使う傾向です [schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:555), [schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:735)。
推奨修正: append-only なら UNIQUE を落として index のみにする。dedupe が必要なら `evaluation_id` / `cycle_id` / `(run_id, finding_id, lens, reviewer_id, prompt_sha256)` など実キーにする。

4. 該当箇所: §3.0 / §3.5 provenance footprint
問題: `run_usage` との JOIN を `run_id` のみにすると、複数 reviewer/evaluator invocation のどれか一意に戻せません。
根拠: v30 PK は `(run_id, kind, seq)` [schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:1816)、writer は `seq` を増分採番します [run-usage.ts](/Users/kn/ops/monorepo-harness/src/db/repositories/run-usage.ts:42)。
推奨修正: FK までは不要でも、各合議行に nullable `usage_kind` / `usage_seq`、または同等の invocation key を provenance JSON に必ず入れる。

**P3**
1. 該当箇所: §3.2 `escalate_flag`, `confidence`
問題: `escalate_flag` に 0/1 CHECK がなく、`confidence` も範囲制約なしです。
根拠: 既存 schema は一部 boolean-ish INTEGER に CHECK を置いていませんが、ここは gate 監査に使う新規 DDLなので厳格化した方が安全です。
推奨修正: `CHECK (escalate_flag IN (0,1))`、`CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)`。

2. 該当箇所: §2.4 file path
問題: `phase-repository.ts` の実パスは `src/db/phase-repository.ts` ではなく `src/roadmap/phase-repository.ts` です。
根拠: 実ファイル [phase-repository.ts](/Users/kn/ops/monorepo-harness/src/roadmap/phase-repository.ts:1)。
推奨修正: 設計ノートの file path を修正。

**総合判定**
GO-with-fixes。backbone 方針、v31 単一 migration、packet/specApproval の additive 方針は妥当です。ただし FK ライフサイクル、import/reset 期待値、jury 表の整合制約はこのまま実装すると DB 運用で詰まるので、DDL 確定前に直すべきです。

---

# 付録G: v2 changeLog（codex finding ごとの対処）

### P1-1: FK + foreign_keys=ON の矛盾。親 FK を張ったまま ON DELETE 無しだと親削除が FK で失敗し『orphan として残す』が実現しない。import reset の legacy-file runs 削除(import-files.ts:114)も run_id FK で詰まる。
- 対処: v31 の 3 表すべてで FK を一切張らない方針に確定。run_id/hitch_id/finding_id は advisory ID とし、doctor で orphan を検出する(append-only audit と両立)。connection.ts:44 で foreign_keys=ON を実コード確認。DDL の REFERENCES 句を全削除し、§3.4/§5/§6 に FK なし方針と doctor orphan 検出を明記。
- 反映 §: v2 改訂履歴, §2.2, §2.6, §3.0, §3.1 review_refute_votes DDL, §3.2 両 DDL, §3.4, §5 安全境界, §6 TDD(round-trip/doctor), §8 受け入れ条件①③⑧, 付録F

### P1-2: hitch_id と finding_id を別々に FK すると hitch_id=h1 ∧ finding_id=別hitchのf2 が通る。hitch_findings は finding_id 単独 PK・hitch_id 通常列(schema.ts:1342)、既存 unique は (hitch_id,stable_key)(schema.ts:1575) で (hitch_id,finding_id) ではない。
- 対処: FK 自体を外した(P1-1)上で、hitch_id を denormalized advisory 列に位置づけ、権威は finding_id 経由の join に統一。repository insert で finding_id→hitch_findings.hitch_id 一致検査(不一致 reject)、doctor で (stored)==(join) を advisory チェック。jury 2 表 DDL のコメントと §3.2/§6/§8/付録B に明記。
- 反映 §: v2 改訂履歴, §3.2 jury_classification_proposals/jury_severity_audits DDL, §6 TDD(doctor/determinism), §8 受け入れ条件⑧, 付録B, 付録F

### P1-3: review_state_json の lost-update。人間批准 load-bearing state を単純 read→merge→write すると他 key や同時 approval を lost-update する。現状 phase-repository.ts:14-20 は read のみ、INSERT(:62-68) は列挙せず、UPDATE は status/scope/close のみ(書込経路ゼロ)。
- 対処: phases に review_state_version INTEGER DEFAULT 0 を v31 で additive 追加し、updateReviewState()/recordSpecApproval() を db.transaction().immediate() + WHERE review_state_version=? の CAS で実装する設計を §3.3 に確定。既存 add()(:45,.immediate())/transitionStatus()(:116,CAS) と同方式と裏取り。specHash は TS 側 canonical JSON 計算。Q5(新規)で CAS 競合解決ポリシーを open question 化。
- 反映 §: v2 改訂履歴, §2.4, §3.3, §4 work item DAG, §5 安全境界, §6 TDD(review_state CAS), §8 受け入れ条件⑥, 付録A Q5, 付録B, 付録F

### P1-4: 『RESET list に足さない→file import で空』は誤り。reset 対象は固定リストのみ(import-files.ts:45/60/67) で、足さなければ既存 DB の DB-only 行は import/reset 後も残る。空になるのは fresh DB のみ。
- 対処: 文言を『file import は新 DB-only 表を変更しない。空になるのは fresh DB の場合のみ』に全箇所訂正。DB-only audit を消す retention/repair は reset で巻き込まず別コマンドに分離する方針を §3.4/§9 に明記。受け入れ条件②と round-trip テストを『既存 DB では残る/fresh のみ空』に修正。
- 反映 §: v2 改訂履歴, §2.6, §3.1, §3.4, §6 TDD(round-trip), §8 受け入れ条件②, §9 follow-up, 付録B, 付録F

### P2-1: jury_severity_audits の severity CHECK が P0..P3 のみで、現行 hitch_findings.severity(schema.ts:1353)/HITCH_FINDING_SEVERITIES(types.ts:100-106) が含む info を扱えない。
- 対処: harness_severity/jury_severity の CHECK を P0,P1,P2,P3,info に拡張。受け入れ条件④と回帰テストに info finding を audit 通過/明示除外できる確認を追加。実コードで info を裏取り。
- 反映 §: v2 改訂履歴, §3.2 jury_severity_audits DDL, §6 TDD(後方互換), §8 受け入れ条件④, 付録F

### P2-2: proposed_scope の unknown_inconclusive が現行 HITCH_SCOPE_STATUSES(in_scope/out_of_scope/unknown/duplicate, types.ts:110-115) と不一致。最終状態は unknown。
- 対処: proposed_scope の CHECK を in_scope/out_of_scope/unknown に寄せ、jury の判定不能は別列 proposal_status(complete/timeout/parse_error/inconclusive) で表現。DDL とコメントに反映。
- 反映 §: v2 改訂履歴, §3.2 jury_classification_proposals DDL, 付録F

### P2-3: UNIQUE(...,created_at) は retry dedupe として弱く、同一 timestamp 衝突があり得る。既存は active partial unique や business key unique(schema.ts:556/735) を使う。
- 対処: append-only audit は UNIQUE(created_at) を落とし INDEX のみに。dedupe が要る箇所は business key UNIQUE(refute: (run_id,target_change_hash,reviewer_id,prompt_sha256) / jury: (finding_id,lens,reviewer_id,prompt_sha256) / severity: (finding_id,prompt_sha256)) に変更。review_proposals/consensus の active partial unique を §2.2 に裏取り記載。
- 反映 §: v2 改訂履歴, §2.2, §3.1 DDL, §3.2 両 DDL, §6 TDD(determinism), 付録F

### P2-4: provenance JOIN を run_id のみにすると、複数 reviewer/evaluator invocation のどれか一意に戻せない。v30 PK は (run_id,kind,seq)(schema.ts:1816)、writer は seq 増分採番(run-usage.ts:42)。
- 対処: footprint 規約と全 v31 表に nullable usage_kind/usage_seq 列を追加し (run_id,usage_kind,usage_seq) で run_usage と一意 JOIN(FK は張らない)。§3.0/§3.5/受け入れ条件⑦/§9 に反映。
- 反映 §: v2 改訂履歴, §2.5, §3.0 footprint, §3.1 DDL, §3.2 両 DDL, §3.5, §8 受け入れ条件⑦, §9, 付録F

### P3-1: escalate_flag に 0/1 CHECK、confidence に範囲 CHECK が無い。gate 監査用 新規 DDL なので厳格化すべき。
- 対処: 全該当列に CHECK (escalate_flag IN (0,1))、CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1) を付与。
- 反映 §: v2 改訂履歴, §3.1 DDL, §3.2 両 DDL, §8 受け入れ条件④, 付録F

### P3-2: phase-repository.ts の実パスは src/db/ でなく src/roadmap/phase-repository.ts。
- 対処: §2.4/§3.3 の file path を src/roadmap/phase-repository.ts に訂正。実ファイルで line 14/45/62/103/116/143 を裏取り。
- 反映 §: v2 改訂履歴, §2.4, §3.3, 付録F

### migration 連番/insertion パターンの具体性不足(SCHEMA_VERSION bump 箇所、ALL_TABLE_NAMES union、phases ALTER の扱い)。
- 対処: 実コードで MIGRATIONS 末尾(:194-198)・SCHEMA_VERSION=30(:21)・LATEST=SCHEMA_VERSION(:202)・ALL_TABLE_NAMES 手動 union(:1874-1895) を裏取りし、v31 は {version:31,...} append + SCHEMA_VERSION→31 + ...V31_TABLE_NAMES append + phases ALTER(table 名不変なので V31_TABLE_NAMES に載せない) と §2.1/§3.4/§4 に明記。
- 反映 §: §2.1, §3.4, §4 work item DAG

---

# 付録H: v2 残件（人間批准）

## H1. review_state_version CAS の競合解決ポリシー(付録A Q5): CAS 失敗時に bounded リトライ(read→merge→retry)で吸収するか、即エラーで fail-closed にするか。並行 writer が将来複数現れた場合の per-key merge 規則をいつ設計するか。
推奨: A 案(CAS + bounded リトライ、超過時は競合エラーで後勝ち禁止)を推奨。add()/transitionStatus() の既存 CAS 流儀に揃う。現状 specApproval を書く writer は recordSpecApproval 1 経路のみで競合確率が低いので per-key merge 関数は writer 増加時まで defer。リトライ上限 N と競合エラーの operator 向け文言を docs 化する。

## H2. P1-3 対策の review_state_version を additive 列で足すと、v31 が『純 CREATE TABLE のみ』でなく phases への ALTER を 1 つ含む。これを単一 v31 ブロックに入れるか、CAS を JSON 内 version フィールド(列を足さない)で代替するか。
推奨: additive 列(review_state_version INTEGER NOT NULL DEFAULT 0)を v31 に含めることを推奨。ALTER ADD COLUMN ... DEFAULT は additive・後方互換で既存行に 0 が入り SQLite で安全。JSON 内 version は同一 review_state_json を read-modify-write する以上 CAS の WHERE 条件に使えず lost-update を構造的に防げないため、別列が必要。

## H3. finding_id を FK にしない(P1-1)ことで、存在しない finding_id を持つ合議行を insert できてしまう。repository insert 時の存在検査を hard reject にするか、doctor advisory に委ねるか。
推奨: repository insert で finding_id の存在 + hitch_id 一致を hard 検査して reject(fail-closed)、かつ doctor でも事後 orphan を advisory 検出する二重化を推奨。insert 検査だけだと後から親が purge された行を拾えず、doctor だけだと不正 insert を即時に止められないため両方要る。

## H4. DB-only audit 表の prune を reset で巻き込まない(P1-4)とした結果、jury votes × lens × findings の無制限増大に対する retention/上限の責任主体と発火タイミングが未定。
推奨: 別コマンド(例 db prune-audit --before <date> / --hitch <id>)を follow-up として設計し、reset/import とは独立に operator 明示承認 + dry-run default で実行する方針を推奨。今サイクルは全保持で出荷し、容量が問題化してから prune コマンドを切る。doctor の orphan full-scan 性能のため finding_id index は v31 で先に張っておく(本ノートで反映済み)。

