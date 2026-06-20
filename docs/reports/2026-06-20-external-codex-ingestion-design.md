# 外部 codex exec usage 取り込み — 設計（#206 Phase-2）

> #206 epic の **コア最後の deliverable**（epic タイトル「… + ハーネス外 codex exec のラップ + …」）。
> Phase-1（PR #346・schema v36・`agent_invocation`/`agent_usage_turn`/`recordAgentUsage`）の上に、
> **ハーネス外で実行される `codex exec` の usage を捕捉**して `agent_invocation(tool='codex',
> role='external')` に記録する透明 wrapper を足す。

## 1. 背景・動機

ハーネス内部の codex（coder/reviewer/evaluator）は `CodexExecRunner` が `codex exec --json` を
使い usage を `run_usage` / v36 telemetry に記録する。一方 **ハーネス外の `codex exec`**（`CLAUDE.md`
/ `GOAL_RULES.md` の PR 差分レビュー `codex exec -m gpt-5.5 … -o <out>`、人間/エージェントの ad-hoc
実行）は:

- ハーネスを通らず **usage が一切記録されない**。
- `-o <file>`（最終メッセージのテキスト）だけで **`--json` 未指定 → `turn.completed.usage` が取れない**。

Phase-2 はこの欠落を埋める。**usage を取るには実行時に `--json` が要る**ため、形態は「実行を包む
wrapper」一択（既存 `-o` 出力を後から読む post-hoc importer は usage を持たないので無意味）。

## 2. スコープ

**In scope**: ハーネス外 `codex exec` を包み usage を v36 に記録する透明 drop-in wrapper。

**Non-goals（follow-up / 別 issue）**:
- Claude サブエージェント usage（#235・別データ源 = `~/.claude/.../subagents/*.jsonl`）。
- `claude -p` 内部バックエンド（#191）。
- コスト換算（USD）。
- 未ひも付けプールの自動ひも付け（文脈推定）。
- 監査用 redacted JSONL artifact の永続化（§6 参照・本 Phase は DB usage のみ）。

## 3. 形態の決定（user 承認済）

| 決定 | 採用 | 理由 |
|------|------|------|
| 形態 | **一体型 wrapper**（run+record を1コマンド） | usage は `--json` 実行時にしか取れない。importer 単体は不可 |
| 出力 | **透明 drop-in** | 既存レビューコマンドが `codex exec`→`harness codex exec` の差し替えだけで動く |
| 永続化 | **DB usage のみ**（JSONL 非永続） | DB 行は数値+enum+label+model のみ＝secret 漏洩面ゼロ→redaction も本 Phase は不要 |

## 4. アーキテクチャ / CLI surface

新サブコマンド **`harness codex exec [wrapper-flags] <codex-args…>`** — `codex exec` の透明 drop-in。

- **wrapper 固有フラグ**（消費し codex へ渡さない。衝突回避で `--harness-` prefix）:
  - `--harness-label <L>` — `external_label`（既定 `"external"`）。
  - `--harness-run-id <id>` / `--harness-hitch-id <id>` / `--harness-course-id <id>` — 任意リンク。
    env fallback: `HARNESS_RUN_ID` / `HARNESS_HITCH_ID` / `HARNESS_COURSE_ID`。
- **それ以外の引数は全て codex へ素通し**（`-m` / `-s` / `-c` / `-o` / 位置 prompt 等）。wrapper は
  内部で **`--json` を1個だけ追加**する。
- 新モジュール:
  - `src/cli/codex.ts` — サブコマンド（argv 分離・wrapper フラグ解釈・出力再現・exit 伝搬）。
  - `src/codex/external-exec.ts` — 薄い passthrough spawner（DI 可・`codex-bin-resolution` 再利用）。
    内部 coder/reviewer 用 `CodexExecRunner`（args を opinionated に構築・prompt は stdin）とは
    **別層**（責務分離。external は任意 args を verbatim 通す）。
  - 記録は Phase-1 の `recordAgentUsage`（`tool:'codex', role:'external'`）を再利用（並行経路を作らない）。

登録: **`harness codex` グループ + `exec` サブコマンド**（= `harness codex exec`・bare の
`codex exec` を鏡写し）。`run.ts` の subcommand 階層に追加。

## 5. データフロー

```
harness codex exec --harness-label pr-review -m gpt-5.5 -s read-only -o out.txt "<prompt>"
  1. argv 分離: --harness-* を消費 / 残り = codex passthrough args
  2. codex binary 解決（codex-bin-resolution 再利用）
  3. spawn: codex exec --json -m gpt-5.5 -s read-only -o out.txt "<prompt>"
       · --json を1個追加（他は verbatim）
       · codex が -o(out.txt) に最終メッセージを native 書き込み（bare と同一・--json と独立）
       · stdout(JSONL) を capture / stderr は user の stderr へ素通し（進捗透明）
  4. 終了時: capture した JSONL を parseCodexTurns / sumCodexTurns で usage 化
       · model は passthrough の -m <model> / --model <model> から sniff（実値 = ground truth）
  5. recordAgentUsage({ tool:'codex', role:'external', model, externalLabel,
       runId?/hitchId?/courseId?, usageSource, turns })   ← fail-open
  6. 出力再現: JSONL から最終 assistant message を抽出し stdout へ print
       （-o 利用時は out.txt に codex が native 書き込み済／非-o 利用者にも結果が見える）
  7. codex の exit code を伝搬
```

> **実装時検証点**: bare `codex exec`（`--json` 無し）の stdout/stderr 出力形態と、wrapper の
> 再現（最終メッセージ stdout print + stderr 素通し）の微細な差は、実 codex でゴールデン確認する
> （契約の核は **`-o` file 内容・exit code の完全一致**。stdout は最終メッセージ可視性を満たせば可）。

要点:
- `codex exec` の `--json`（JSONL→stdout）と `-o`（最終メッセージ→ファイル）は **独立フラグ**
  （`codex-cli 0.139.0` で確認）。よって codex が `-o` を native 処理 → wrapper は usage を読むだけで
  出力忠実度が保てる。
- **model は `-m` から sniff = 実値**（ハーネスは内部経路で `-m` 非注入ゆえ best-effort advisory
  だが、wrapper では user が渡した実 model を記録できる）。
- stdout の生 JSONL は user に出さず、最終メッセージのみ再現（透明性）。

## 6. 記録内容・永続化

### 6.1 `agent_invocation` + `agent_usage_turn`（Phase-1 external 経路を再利用）

| 列 | 値 |
|----|----|
| tool / role | `codex` / `external` |
| model | `-m` から sniff（無ければ null） |
| external_label | `--harness-label`（既定 `"external"`） |
| run_id / hitch_id / course_id | `--harness-*` フラグ or env（無ければ null。`role='external'` ゆえ `CHECK (role='external' OR run_id IS NOT NULL)` 充足） |
| session_id / agent_id | null（codex ゆえ `CHECK (tool<>'codex' OR session/agent NULL)` 充足） |
| invocation_id / invocation_seq | `recordAgentUsage` の external 経路（`ext:`+sha256・seq は `(role, run_id, external_label)` 系列で採番） |
| usage_source / turns | parse 成否で `exact`/`unavailable`・per-turn 行（unavailable は synthetic 1 行 turn_seq=0） |
| description | **null**（prompt は secret 含み得るため自動取得しない） |

### 6.2 永続化・redaction（YAGNI）

- **DB usage のみ記録**（`agent_invocation` + `agent_usage_turn`）。**JSONL artifact は永続化しない**。
- DB 行は token 数値 + model 名 + label + 時刻のみ = **codex 出力テキストを保存しない → secret 漏洩面
  ゼロ**。よって **redaction（`redactCodexEvents`）は本 Phase 不要**（§6 設計レポートの redaction は
  「生 JSONL を保存する場合」の要件・本 Phase は非永続ゆえ N/A）。
- 記録先 = harness DB（`.harness/harness.sqlite`・内部 usage と同一・`HARNESS_ROOT`/`harnessPaths`
  で解決）。
- 各 wrapper 起動 = 新 invocation 1 件（再実行は新行・dedup しない＝別 codex run ゆえ正しい）。
- **follow-up**: 監査用に redacted JSONL を保存したくなったら別 Phase で（保存先・redaction・file
  管理を伴う）。

## 7. エラー処理 / fail-open

**不変条件: codex の結果（stdout / `-o` / exit code）は、usage 記録の成否に関わらず byte-identical。
記録は純粋な副作用。**

- **codex spawn 不能**（binary 解決失敗）= wrapper のコア機能失敗 → 明確にエラー終了（fail-open 対象外）。
- **codex が非ゼロ / timeout** → codex の exit code を **そのまま伝搬**。usage は取れた分だけ記録
  （内部 reviewer 同様、全 outcome で記録）。
- **JSONL parse 不能 / usage 無し** → `usage_source='unavailable'`（fail-open）。
- **`recordAgentUsage` 失敗**（DB lock / 欠落）→ stderr に warn、**codex 出力 / exit に一切影響しない**
  （`recordAgentUsage` は既に single-try fail-open・onError）。
- **DB 不在**（`.harness` 無し）→ 記録 skip + warn（codex は通常実行・`reviewer-agent-usage.ts` と
  同パターン）。

## 8. テスト戦略（TDD）

DI で **fake codex spawner**（scripted JSONL + exit code を出す・`createFakeCodexRunner` 相当の
external 版）を使用:

1. arg 素通し + `--json` がちょうど 1 個注入される（既に `--json` がある場合の冪等も）。
2. `--harness-*` が codex に渡らず・label / run / hitch / course が適用される。
3. usage capture → `agent_invocation`（codex/external/model/label）+ `agent_usage_turn` 行。
4. model を `-m`（と `--model`）から sniff（無ければ null）。
5. unavailable（usage 無し）→ unavailable 行 + synthetic 1 turn。
6. **exit code 伝搬**（codex 非ゼロ→wrapper 非ゼロ）+ usage は記録される。
7. 出力再現（最終メッセージ→stdout / `-o` 保持・exit 伝搬）。
8. **fail-open**（DB 欠落 / DB エラーで codex 出力・exit 不変・warn 1 回）。
9. linking（`--harness-run-id` で run_id・env fallback・両方無しで null + external_label）。
10. multi-turn（synthetic 2 turn）→ per-turn 2 行・サマリは sum。

- サブ Phase 緑 = 関連テスト + typecheck、最終 = フルスイート + typecheck（弱化/skip 禁止）。

## 9. docs 同コミット（spec 駆動）

- `docs/specs/cli.md` — `harness codex exec` subcommand 追記。
- `docs/specs/workflow.md` — external codex 記録経路の注記（内部 3 経路に続く 4 つ目の writer・
  ただし run lifecycle 外）。
- `docs/specs/db.md` — `agent_invocation` 節に external/wrapper 由来行の注記（既存 external 記述の補強）。
- `CLAUDE.md` / `GOAL_RULES.md` の codex レビューコマンドを `harness codex exec` 化するかは **別途**
  （adoption は doc 変更・本 PR では wrapper を land し、レビューコマンド差し替えは follow-up で可）。

## 10. 安全境界（不可侵・Phase-1 と同一）

- usage 記録は state を gate しない（telemetry-never-gates・G7 で機械強制）。
- 記録失敗は codex 実行を止めない（fail-open）。
- LLM 出力（codex の自然文）を状態遷移の根拠にしない。external 行も token 数値 + enum のみ。
- 並行経路を作らない（`recordAgentUsage` 単一 choke point を再利用）。
