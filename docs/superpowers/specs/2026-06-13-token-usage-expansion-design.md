# Token Usage 収集範囲の拡張（design）

- 日付: 2026-06-13
- 対象: monorepo-harness（dev）
- 前提: telemetry Phase C（PR #174）で `run_usage`（migration V26）+ `tokenUsageSummary` を実装済み。
  現状の計測対象は **workflow-runner 経由の coder run の codex 実行のみ**（per-run 1 行、
  `usage_source ∈ exact | unavailable`）。

## 背景と問題

トークン計測は coder run の codex 1 回分しか記録していない。1 つの coder run の配下には
coder 1 回に加えて reviewer N 回・evaluator M 回の codex 実行が共存する（reviewer-agent /
review-evaluator はいずれも同じ `runId` 配下で `codexRunner.run` を呼び、
`publishRedactedCodexEvents` で `codex-events.jsonl` を出す）。しかし `run_usage` は
`run_id` を主キーとする 1 run = 1 行のため、reviewer/evaluator 分を収容できない。

結果として「1 run の総コスト」「hitch 単位（リトライ込み）の合計」「course 単位の合計」が
見えず、GitHub issue #85（per-hitch / session のトークン計測レポート）が未充足のまま。

### スコープ

- **収集対象に含める**: coder / reviewer / evaluator の codex 実行（ハーネスが
  `codex exec --json` で起動し、`runId` と DB アクセスを持つ経路）。
- **集計の露出**: per-hitch（`hitch status`）/ per-course（`course status` の rollup）/
  時間窓・scope（既存 `tokenUsageSummary`）の 3 単位。
- **非対象（YAGNI / 別軸）**:
  - コスト推定（USD）。model→単価テーブルの保守が継続的に必要なため defer（issue #85 の
    コスト部分は別 follow-up に残す）。
  - ハーネス外の codex 実行（operator/Claude が orchestration で手動実行する
    `codex exec`）。ハーネスが関与しないため構造的に収集不能。収集するには codex 呼び出しの
    全ラッパー化という大きな前提変更が要るため対象外。

## データモデル — `run_usage` を per-invocation 粒度に再設計（migration V30）

> 実装時、main が先行マージ（#185）で V29（`hitch_lifecycle_events`）を取得していたため、
> この migration は **V30** に renumber した（当初設計は V29）。以下の番号は V30 を指す。

現 `run_usage` は `run_id TEXT PRIMARY KEY`。これを「1 run 配下の各 codex 実行 = 1 行」に
変更する。SQLite は主キー変更ができないためテーブル再作成で移行する。

```sql
-- migration V30
CREATE TABLE run_usage_v30 (
  run_id                 TEXT NOT NULL REFERENCES runs(run_id),
  kind                   TEXT NOT NULL CHECK (kind IN ('coder','reviewer','evaluator')),
  seq                    INTEGER NOT NULL DEFAULT 0,
  model                  TEXT,
  input_tokens           INTEGER,
  cached_input_tokens    INTEGER,
  output_tokens          INTEGER,
  reasoning_output_tokens INTEGER,
  total_tokens           INTEGER,
  usage_source           TEXT NOT NULL CHECK (usage_source IN ('exact','parsed_log','estimated','unavailable')),
  created_at             TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, seq)
);
INSERT INTO run_usage_v30 (run_id, kind, seq, model, input_tokens, cached_input_tokens,
  output_tokens, reasoning_output_tokens, total_tokens, usage_source, created_at)
  SELECT run_id, 'coder', 0, model, input_tokens, cached_input_tokens,
    output_tokens, reasoning_output_tokens, total_tokens, usage_source, created_at
  FROM run_usage;
DROP TABLE run_usage;
ALTER TABLE run_usage_v30 RENAME TO run_usage;
CREATE INDEX run_usage_run_idx ON run_usage(run_id);
```

- 既存 coder 行は `kind='coder', seq=0` として保存（データ欠落なし）。
- `seq` は同一 `(run_id, kind)` 内の連番。reviewer リトライ等で同 kind が複数回走るため必要。
  記録時に `COALESCE(MAX(seq)+1, 0)` で採番する（INSERT と同一 `BEGIN IMMEDIATE`
  トランザクション内で、course/phase の position 採番と同じ流儀）。
- `parsed_log` / `estimated` は引き続き予約値（V26 同様、書かない）。
- `V26_TABLE_NAMES` 等のテーブル定数・`CURRENT_TABLE_NAMES` は `run_usage` 名のまま不変
  （rename で同名に戻すため）。

### 既存参照箇所の追従（同 PR 内）

- `tokenUsageSummary`（`src/db/repositories/aggregates.ts`）: 現状 `run_usage` を run と 1:1 で
  JOIN している前提を、`SUM` 集約（kind 問わず合算）に変更。kind 別内訳
  （`byKind: { coder, reviewer, evaluator }`）も追加する。
- metrics snapshot payload（`metrics_snapshots`）: payload に含まれる tokenUsage 形が変わる。
  `payload_schema` を 1→2 に上げ、旧 payload（schema 1）は読み出し時に kind 内訳なしとして
  互換読みする。
- import / reset child（`src/db/import-files.ts` / `src/db/import/runs.ts`）: `run_usage` は
  既に child table 登録済み。per-invocation 化で 1 run に複数行になるため、run 単位の
  DELETE→再構築が複数行に対応していることを確認（run_id での DELETE は不変なので問題なし）。

## 収集経路

`recordCodexUsage` を `kind` 引数付きに一般化し、3 経路から呼ぶ。すべて **fail-open**
（記録失敗は run/review を止めない）で、入力は redaction 済み `codex-events.jsonl` のみ
（raw dotfile は読まない＝安全境界維持）。usage は codex CLI の `turn.completed.usage`
だけを使い、LLM の自己申告値はパースしない。

- **coder**: `src/core/workflow-runner.ts`（現行 `recordCodexUsage` 呼び出し、~802 行）を
  `kind='coder'` に。
- **reviewer**: `src/core/reviewer-agent.ts`（`publishRedactedCodexEvents` の後、~520 行）で
  `kind='reviewer'` 記録。
- **evaluator**: `src/core/review-evaluator.ts`（events publish の後）で `kind='evaluator'` 記録。

### 未確定点（G2 着手時にコードで確認）

reviewer/evaluator は `reviewed-run-workflow` や `cli review auto` 等、coder run とは別プロセスで
走る経路がある。その文脈で「同じ runId の DB ハンドル（書き込み可能）」を保持しているかを
G2 着手時に確認する。保持していれば記録、していない経路は **記録なし（unavailable のまま）**
とし、無理に DB 接続を新設しない（安全側）。確認結果は G2 のコミット message と本 spec の
追補に残す。

#### G2 着手時の確認結果（2026-06-14, commit で実装）

- **reviewer**（`src/core/reviewer-agent.ts` `runReviewerAgent`）: `publishRedactedCodexEvents` の
  直後に `inputs.dbPath` が存在すれば短命の writable managed db を開いて `kind='reviewer'` を記録する
  （`recordReviewerUsage`）。**timeout / 非ゼロ exit / unparseable YAML を含む全 outcome** で記録できるよう、
  gate（throw）より前・publish 直後に配置（codex は verdict 失敗時もトークンを消費するため）。redaction 済み
  official events のみ読む。`dbPath` 未指定（`review auto` を DB 無しで動かす経路）は記録なし（unavailable）。
- **evaluator**（`src/core/review-evaluator.ts` `evaluateReviewer`）: sample ループは元来 readonly probe しか
  持たない。`opts.dbPath` が指定されているときのみ writable managed db を 1 本開き、各 sample の publish 後に
  `kind='evaluator'` を per-sample 記録（`finally` で close）。`dbPath` 未指定の経路は記録なし（unavailable、
  無理に接続を新設しない＝設計の安全ガイダンスどおり）。
- いずれも **fail-open**: 記録失敗（DB 不在 / events 読めない / 書込失敗）は warn して握りつぶし、
  review/evaluation の成否に波及させない。usage は codex の `turn.completed.usage` のみ。

## 集計の露出（3 単位）

1. **per-hitch** — 新 `hitchTokenUsage(db, hitchId)`:
   `hitch_attempts` の `run_id`（DISTINCT, NULL 除外）→ `run_usage` を SUM。
   返り値は総計（`{ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens,
   totalTokens, runsWithUsage }`）+ kind 別内訳。`hitch status --json` に `tokenUsage`
   フィールドとして追加。テキスト表示にも 1 行追加。リトライ込み合計になる（attempts が
   全 rerun を含むため）。
2. **per-course** — `rollupCourse`（`src/roadmap/rollup.ts`）に `tokenTotals` を追加:
   course→phase→hitch を辿り各 hitch の `hitchTokenUsage` を合算。`course status` に表示。
   live 集計（rollup は導出値）の原則を維持し、snapshot 化しない。
3. **時間窓 / scope** — 既存 `tokenUsageSummary`（CLI `harness metrics` / dashboard /
   MCP）が per-invocation SUM になることで reviewer/evaluator 分を自動合算。kind 別内訳も
   出す。MCP の project-restricted 可視性は既存挙動を変えない（runs JOIN で scope が効く）。

## 安全境界

- 計測は codex CLI 構造化出力（`turn.completed.usage`）のみ。LLM 自己申告を状態遷移にも
  集計にも使わない。
- 記録は fail-open。テレメトリ欠損が run/review の成否に波及しない。
- redaction 済み events のみ読む。raw quarantine dotfile は読まない。
- lease guard / 状態遷移の流儀を変えない（記録は副作用のみ）。

## テスト

- migration V30: 既存 coder 行が `kind='coder', seq=0` に移行されること、PK・index、24→30 や
  既存 vN→30 の前方移行（既存 migration テスト群の applied 配列追従）。
- `recordCodexUsage`: 各 kind の記録、同 `(run_id,kind)` の seq 採番、fail-open（壊した DB で
  throw しない）。
- reviewer/evaluator 経路: 失敗/成功それぞれで該当 kind 行が入る（記録経路を持つ場合）。
- `tokenUsageSummary`: per-invocation SUM、kind 内訳、scope（project/repo/domain/since）、
  reviewer 込みの合算。
- `hitchTokenUsage`: attempts 経由の SUM、リトライ込み、kind 内訳、usage なし hitch で 0/null。
- `rollupCourse`: phase ツリーの token 合算。
- snapshot payload schema 1→2 の互換読み。

## サブ Phase 分割（feature branch `feat/token-usage-expansion` 1 本）

- **G1**: migration V30 + `recordCodexUsage` の kind/seq 化 + coder 経路の per-invocation 化 +
  `tokenUsageSummary` / snapshot payload(schema 2) の追従。既存挙動を per-invocation に
  置き換える土台。
- **G2**: reviewer / evaluator 経路の記録（未確定点の DB アクセス確認込み）。
- **G3**: per-hitch 集計（`hitchTokenUsage` + `hitch status` 表示）。
- **G4**: per-course 集計（`rollupCourse` + `course status` 表示）。

各サブ Phase は GOAL_RULES.md に従い codex xhigh レビュー（サブ最大 3 / 大最大 5）・未解決
P0 ゼロ gate・spec 同コミット更新（`docs/specs/db.md` / `cli.md` / `dashboard.md` /
`mcp.md` / `hitch-convergence.md` / `roadmap.md` の該当箇所）を満たす。

## 完了の定義

- `run_usage` が coder/reviewer/evaluator の per-invocation 行を持つ。
- `hitch status` / `course status` / `harness metrics` がトークン合計（+ kind 内訳）を出す。
- フルスイート + typecheck 緑、回帰なし。
- issue #85 のうち「per-run / per-hitch / per-course / 時間窓のトークン集計」を充足
  （コスト推定は別 follow-up として残す旨を #85 にコメント）。
