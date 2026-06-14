# agent usage テレメトリ再設計 — 設計レポート

- 日付: 2026-06-14
- 種別: 設計提案（design spike / 実装前）
- 状態: 設計合意済み・**実装未着手**。本レポートは方向性の記録であり、`src/`
  への変更は伴わない。
- 関連: `docs/specs/workflow.md`（run_usage 記録）/ `docs/specs/db.md`
  （run_usage スキーマ v26 / v30）/ #85・#200（run_usage per-invocation 化）

---

## 1. 背景と動機

ハーネスは `codex exec` を `CodexExecRunner` 経由で起動し、`--json` の JSONL
イベント（`turn.completed.usage`）からトークン使用量を抽出して `run_usage` テーブル
に記録している（`src/codex/usage-parser.ts` → `src/db/repositories/run-usage.ts`）。

この仕組みには 2 つの欠落がある。

### 1.1 ハーネス外 codex exec が一切記録されない

ハーネスのコード経路（workflow-runner / reviewer-agent / review-evaluator /
course-orchestrate / mcp mutation-tools）は必ず usage を記録する。しかし、規約
（`CLAUDE.md` / `GOAL_RULES.md`）に従って **人間/LLM が Bash で直接叩く PR 差分
レビュー**は、ハーネスを通らないため `run_usage` に残らない。

```
codex exec -m gpt-5.5 -c model_reasoning_effort="xhigh" -s read-only -o <out> "<prompt>" < /dev/null
```

このコマンドは `--json` を付けていないため、そもそも JSONL イベントが stdout に
出ず、`turn.completed.usage` を取得できない。

### 1.2 ハーネス内も記録粒度が粗い（turn 内訳の喪失）

記録は実際には 3 層に分かれている。

| 層 | 単位 | 実体 |
|----|------|------|
| 1 | codex プロセス 1 回 = 1 行 | `recordCodexUsage()` が `codexRunner.run()` ごとに 1 行 INSERT（per-invocation）|
| 2 | プロセス内の複数 turn = 合算 | `parseCodexUsage()` が全 `turn.completed` を**合計して 1 行に潰す** |
| 3 | 表示時 roll-up = 合算 | `tokenUsageSummary()` / `hitchTokenUsage()` がクエリ時に SUM |

保存は per-invocation だが、**層 2 で turn ごとの内訳が消える**。長い multi-turn
セッションの「どの turn で大量消費したか」を後から監査できない。改善・監査の観点で
これは細粒度に持ちたい。

### 1.3 付随する既存の弱点

- `run_usage.model` 列が常に `NULL` 固定（`run-usage.ts` の INSERT が `NULL` を
  ハードコード）。モデル混在時のモデル別集計ができない。
- 記録経路が 3 箇所に分散しており、外部ラッパを足すと 4 経路目になる。

---

## 2. 設計目標

1. **細粒度・監査可能**: turn 単位で DB に保管する（生 JSONL artifact は従来どおり
   全件ディスク保存が前提。DB はクエリ可能な層として turn まで持つ）。
2. **経路統一**: 内部 3 経路＋外部ラッパを単一の記録口に集約する。
3. **タスクごとに集計可能**: 統一後も run / hitch / course 単位で正しく集計できる。
4. **将来のツール拡張**: codex 以外（claude CLI 等）も同じ箱に入る汎用設計にする。
5. **ひも付けは任意**: タスク文脈（run/hitch/course）へのリンクは強制せず nullable。
6. **後方互換**: 既存の集計 API / dashboard を無改修で動かす。
7. **fail-open 維持**: telemetry の失敗が run / review の動作に影響しない。

---

## 3. 設計判断（合意済み）

| 論点 | 決定 |
|------|------|
| DB 保管の最小粒度 | **turn 単位**（1 `turn.completed` ＝ 1 行） |
| 統一アンカー | **`agent_invocation` テーブル新設**（「1 回の agent 起動」を表す箱） |
| 命名 | `agent_invocation` + `tool` 列（codex/claude…）、明細は `agent_usage_turn` |
| タスクへのひも付け | run/hitch/course への FK は**全て nullable（任意）** |
| 既存 run_usage | **新スキーマに一本化 + 互換 view** で run_usage を導出（API/dashboard 無改修）|

`codex_invocation` ではなく `agent_invocation` としたのは、ハーネスが codex を
coder/reviewer/evaluator の「agent」として動かしており、かつ将来 codex 以外の
ツールも同じ箱に入れるため。「どのツールか」は行データ（`tool` 列）で表す。

---

## 4. データモデル

```
agent_invocation
  invocation_id    PK
  tool             'codex' | 'claude' | …            -- 将来拡張。どのツールを呼んだか
  role             'coder' | 'reviewer' | 'evaluator' | 'external'
  model            'gpt-5.5' | …                      -- 旧 run_usage.model=NULL 固定を解消
  run_id?          FK → runs        (nullable)        -- 任意のタスクリンク
  hitch_id?        FK → hitches     (nullable)
  course_id?       FK → courses     (nullable)
  external_label?  TEXT             (nullable)        -- 外部実行のメモ（例 "pr-review #207"）
  invocation_seq   INTEGER                            -- 同一 (run_id, role) 内採番（互換 view 用）
  started_at, exit_code, duration_ms, usage_source

agent_usage_turn
  invocation_id    FK → agent_invocation
  turn_seq         INTEGER                            -- 0,1,2… invocation 内の turn 連番
  input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
  PK (invocation_id, turn_seq)
```

`reasoning_output_tokens` は別途報告される値で `total` には加算しない（現行の
`ParsedCodexUsage` の定義を踏襲）。`total_tokens = input + output`。

### 4.1 互換 view

```
view run_usage  ←  agent_usage_turn を invocation 単位で SUM し、
                   (run_id, role→kind, invocation_seq→seq) に射影
```

これにより `tokenUsageSummary()` / `hitchTokenUsage()` / dashboard は現行スキーマと
同じ列を読み続けられる（無改修）。`role='external'` や `run_id IS NULL` の行は
view の射影対象外（run_usage は run に紐づく行のみ）にして互換性を保つ。

---

## 5. 記録経路の統一

現状バラバラな 3 経路（workflow-runner / reviewer-agent / review-evaluator が
各々 publish → read → `recordCodexUsage`）と、新しい外部ラッパを、単一の記録関数に
集約する。

```
recordAgentUsage({
  tool, role, model,
  links: { runId?, hitchId?, courseId? },   // 任意
  externalLabel?,
  eventsContent,                             // redact 済み JSONL
  meta: { exitCode?, durationMs? },
  beforeWrite?, onError?,                    // fencing / fail-open は踏襲
})
```

- 各呼び出し側は「redact 済み JSONL」と「文脈リンク」を渡すだけ。
- parse → turn 分解 → `agent_invocation` + `agent_usage_turn` への INSERT は
  この関数の責務。
- 既存の `parseCodexUsage()` は「全 turn 合算」から「turn ごとに分解して返す」へ
  拡張（合算は view 側に移す）。redaction（`redact-events.ts`）はそのまま再利用。

---

## 6. ハーネス外実行のラップ

外部 codex exec を包むラッパ（形態は実装時に決定。候補: `harness` の subcommand /
シェルラッパ）が満たすべき要件:

1. **`--json` を強制付与**して JSONL イベントを取得（`-o` と併用可）。これが無いと
   `turn.completed.usage` が取れない。
2. **redaction を通す**（`redact-events.ts` 相当）。生 JSONL を保存しない。
3. `recordAgentUsage({ tool:'codex', role:'external', model, … })` を呼ぶ。
4. タスクリンクは**分かるときだけ**渡す（環境変数 or 引数で run_id/hitch_id を注入、
   不明なら null）。null のものは「未ひも付けプール」として残り、`external_label`
   で後から識別・手動集計できる。リンクが無くても記録自体は必ず残る。

---

## 7. 設計前提の検証ポイント（重要・未確認）

turn を**加算**してよいのは、codex の `turn.completed.usage` が **incremental
（その turn 分の差分）** の場合のみ。もし **cumulative（累積）** なら現行コードも
新設計も二重計上になる。

**前提タスク**: 実機の `codex-events.jsonl` を 1 本取得し、複数 turn 間の usage 数値が
単調増加（累積）か否かを確認する。これは既存実装の潜在バグでもあり、再設計のついでに
必ず確かめる。

- incremental の場合: turn 行をそのまま保存、invocation 合計は単純 SUM。
- cumulative の場合: turn 行は「最終 turn の値＝invocation 合計」とし、turn 間差分を
  別途計算するか、保存方式を見直す。

---

## 8. テスト戦略（TDD）

- `parseCodexUsage`（拡張）: multi-turn 入力 → 複数 turn 行を返す。malformed /
  usage 欠落 → `unavailable`（fail-open）。
- 互換 view: 旧 `run_usage` と同一出力になる golden テスト（移行前後で集計 API の
  結果が一致）。
- 外部ラッパ: link 注入あり / null（未ひも付けプール）、redaction 適用、fail-open。
- `recordAgentUsage`: fencing guard（`assertActiveLease`）が同一 transaction で
  動くこと、エラーが run に伝播しないこと。

---

## 9. 移行

- 既存 `run_usage` 行 → `agent_invocation`(role=旧 kind, invocation_seq=旧 seq,
  tool='codex', model=NULL) + `agent_usage_turn`(turn_seq=0 に合算値 1 行) として
  取り込む。
- turn 内訳は遡及復元できないため、**移行分は turn_seq=0 集約**と割り切る
  （`usage_source` で区別可能）。
- DB schema migration（新版）+ import + consistency 確認を伴う（`docs/specs/db.md`
  の規律に従う）。`docs/specs/workflow.md` / `docs/specs/db.md` を同じ変更で更新。

---

## 10. スコープ外（follow-up 候補）

- ラッパの最終形態（subcommand / シェル関数）の確定。
- claude CLI など codex 以外ツールの usage パーサ実装（`tool` 列の受け皿は用意済み）。
- 未ひも付けプールの自動ひも付け（文脈推定）。
- コスト換算（トークン → 金額）レイヤー。
