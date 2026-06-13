# `claude -p` をサブスク範囲で codex exec コーダー代替にできるか（実機検証）

**Date:** 2026-06-13
**Trigger:** 「ハーネスのコーディングを codex exec から `claude -p` に代替できるか調査（機能取り込みはせず調査のみ）」というユーザー依頼。さらに「サブスク範囲で」という制約が追加された。
**Harness range:** `9cfa7f6` → `9cfa7f6`（**コード変更なし**。調査のみ。`src/` は read-only で扱った ops checkout）
**Scope tag:** `design-review`

> 機能としては取り込んでいない。実機 `claude` CLI を叩いて feasibility と制約を確定するための調査ログ。

## Scope

ハーネスのコーダー（実装エージェント）を現行の `codex exec` から `claude -p` に差し替え可能かを、**Claude Max サブスク認証のまま**（従量 API＝`--bare` を使わない）成立させられるかという観点で実機検証した。検証は `/tmp` の使い捨て git repo に対し `claude -p` 2.1.177 を実走（計4コール、後片付け済み）。コードは一切変更していない。containment の permission 境界の網羅検証は次サイクル送り。

実機認証状態（`claude auth status`）:
```json
{ "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max" }
```
全 run で `init.apiKeySource = none` を確認 → サブスク認証が維持されたまま動作（従量課金に切り替わっていない）。

---

## Part 1 — 現行コントラクト（消費側の結合点）

### CodexExecRunner が何を返し、ハーネスが何を消費しているか

**前提:** 代替可否は「runner interface を満たせるか」ではなく「ハーネスが run から消費する4物を provider 非依存に供給できるか」で決まる。

**対応:** `src/codex/codex-exec-runner.ts:11-19` の `run(inputs): Promise<CodexRunResult>` を起点に消費物を棚卸し。

**結果:** 消費物は4つ。

| # | 消費物 | 出所 | provider 依存度 |
|---|--------|------|-----------------|
| ① | worktree への実 diff | filesystem | **非依存**（policy 検証は事後 `git diff`＝正本） |
| ② | `exitCode` / `timedOut` / `durationMs` | プロセス終了 | **非依存** |
| ③ | 最終エージェントメッセージ | codex `-o <file>`（`codex-cli-runner.ts:89-90`） | 形式依存（小） |
| ④ | `--json` の JSONL イベント | codex stdout（`codex-cli-runner.ts:75,119`） | **強依存**（大） |

①② が provider 非依存なのが効く。④ が最大コスト。

**verdict:** ✅ runner 追加自体は容易。本丸は ④ events 層と containment。

---

## Part 2 — サブスク範囲での実機検証

### シナリオ A — 隔離フラグ付きで実編集 + イベント型観測

**前提:** `--bare` はサブスク不可（`ANTHROPIC_API_KEY` 強制）。`--bare` なしで codex の `--ignore-rules` + `--ephemeral` 相当のクリーンさを出せるかが鍵。

**対応:** `/tmp` の git repo で以下を実走。
```bash
claude -p "Create a file named hello.txt containing exactly HELLO. Use the Write tool." \
  --output-format stream-json --verbose \
  --permission-mode acceptEdits \
  --setting-sources "" --strict-mcp-config --disable-slash-commands
```

**結果:**
- `hello.txt` が実書込みされ、worktree に diff が出た（① 成立）。
- `init` イベント:
  - `apiKeySource: none`（= サブスク維持）
  - `mcp_servers: []`、`slash_commands: 0`、`plugins: []`、`skills: []`
  - `memory_paths: { auto: ".../memory/" }` のみ → **global `~/.claude/CLAUDE.md` も project CLAUDE.md も消滅**
  - stream に hook イベント無し（プレーン実行時は `SessionStart` hook が混入していた）
- イベント型: `system/init`, `assistant`(text/tool_use), `user`(tool_result), `result/success`, `rate_limit_event`

**verdict:** ✅ `--setting-sources ""` がサブスク互換の `--ignore-rules` 相当。「サブスク vs 隔離」の二択は解消。

### シナリオ B — `acceptEdits` 下での Bash 実行可否 + `--tools` 制限

**前提:** codex は test/build を回す。claude が `-p` 非対話・`bypassPermissions` なしで Bash を実行できるかが capability の前提。

**対応:**
```bash
claude -p "Run 'echo HELLO_FROM_BASH' using the Bash tool and report output." \
  --permission-mode acceptEdits \
  --setting-sources "" --strict-mcp-config --disable-slash-commands \
  --tools "Bash Read Edit Write" --output-format stream-json --verbose
```

**結果:**
- granted tools が正確に `['Bash','Edit','Read','Write']` に制限（`--tools` が効く → network/orchestration tool を外せる）。
- `echo` が **拒否されず実行**（`tool_result.is_error=false`、`result.permission_denials=[]`）。

**verdict:** ⚠ Bash は通る（capability OK）が、観測は `echo` のみ。`-p` の permission 境界（どのコマンドが auto-allow / deny か、worktree 外書込みの扱い）は未網羅 → F15。

---

## Findings

| ID | カテゴリ | 一行要約 |
|----|---------|---------|
| F13 | info | `--setting-sources ""` でサブスク維持のままクリーン隔離が可能（核心発見） |
| F14 | P1 | events/usage スキーマが codex と完全別物 → 中立アダプタ層が必須 |
| F15 | P1 | `-p` の permission/containment 境界が未検証（OS サンドボックス欠如） |
| F16 | info | サブスクのレート枠（5h/週）を対話利用と共有・ephemeral の cache コスト |

### F13 — サブスク互換の隔離レシピ (info, closed: observed)

**問題:** 前段調査では「rule 隔離するなら `--bare`＝従量課金でサブスク外」という二択に見えた。

**観察:** `--setting-sources ""`（+ `--strict-mcp-config` + `--disable-slash-commands`）で global/project CLAUDE.md・MCP・hooks・slash・plugins・skills を全排除でき、かつ `apiKeySource=none`（サブスク維持）。`--bare` は不要。

**verdict:** observed（no change）。実装に進む場合の PoC 既定フラグとする。

### F14 — events/usage スキーマ非互換 (P1)

**問題:** claude `stream-json` は Anthropic SDK 形式で、codex の `item.completed`/`turn.completed` とは別物。codex 専用にハードコードされた3ファイルがそのままでは再利用不可:
- `src/codex/usage-parser.ts:63-84`（`turn.completed.usage` 前提）
- `src/codex/events-summary.ts:87-119`（`item.completed`/`turn.completed` 前提）
- `src/codex/redact-events.ts:15-20,105`（`item.command`/`aggregated_output`/`text` の codex フィールド名で secret scan）

claude のイベント型（実測）:
```
system/init       … cwd, tools[], mcp_servers[], memory_paths, model, permissionMode, apiKeySource
assistant         … message.content[]: {type:"text"} / {type:"tool_use", name, input}
user              … message.content[]: {type:"tool_result", is_error, content}
result/success    … result, usage{...}, total_cost_usd, num_turns, permission_denials, stop_reason
rate_limit_event  … rate_limit_info{...}
```

usage 意味論の非対称（`run_usage` / #85 V29 と整合させる必要）:

| codex (`turn.completed.usage`) | claude (`result.usage`) |
|---|---|
| `input_tokens` | `input_tokens` |
| `cached_input_tokens` | `cache_read_input_tokens` ＋ `cache_creation_input_tokens`（2分割） |
| `output_tokens` | `output_tokens` |
| `reasoning_output_tokens` | **対応物なし** |
| （なし） | `total_cost_usd`（サブスク時は名目値・実課金ではない） |

**修正（未実施・提案）:** 中立イベントスキーマを定義し codex/claude 両方をそこへ正規化。redaction も tool_use/tool_result 構造向けに書き直し。

**verdict:** deferred（調査のみ。実装は別サイクル）。

### F15 — `-p` の containment 境界が未検証 (P1)

**問題:** codex の `--sandbox workspace-write` は worktree 外書込みを OS レベルで封じる。claude に FS サンドボックスは無く、permission system + `--tools`/`--allowedTools` 頼み。シナリオ B（F15）で `echo` は通ったが、(a) どのコマンドが auto-allow / deny か、(b) worktree 外（`~/.ssh` 等）への書込みが止まるか、は未検証。

**影響範囲:** ハーネスの安全正本＝事後 `git diff` policy 検証は provider 非依存で不変（壊れない）。失うのは**多層防御の1層**（worktree 外書込みの封じ込め）。事後 diff は repo 内スコープ外 path は検出するが repo 外書込みは見ない。

**修正（提案）:** `--tools` で network/危険 tool を外す ＋ 必要なら `sandbox-exec`(macOS)/`bwrap`(Linux) でラップ、または `--allowedTools "Bash(npm test) Bash(git *)"` でコマンド allowlist 化。`GOAL_RULES.md §G` 観点で要エスカレーションの設計判断。

**verdict:** deferred（containment 設計前に専用検証が必要。過信しない）。

### F16 — サブスク消費の実態 (info, observed)

**観察:** 実測 `rate_limit_event`:
```json
{ "rateLimitType":"five_hour", "status":"allowed",
  "overageStatus":"rejected", "overageDisabledReason":"org_level_disabled" }
```
- 5時間/週ウィンドウを**対話 Claude Code 利用と共有**。長い hitch ループは枠を食い、手元利用と取り合う。overage は org 無効 → 上限到達＝ハーネス停止（fail-closed だが運用は痛い）。
- 1編集タスクの実測 usage: input 244 / cache_creation 17.9k / cache_read 17.5k / output 115、名目 `total_cost_usd≈0.19`。**ephemeral stateless 起動のため cache_creation が毎回乗る** → ループ回数 × このオーバーヘッドを枠計画に入れる。

**verdict:** observed（no change）。

---

## Test inventory

- 単体/typecheck: **実行せず**（コード変更なしのため対象外）。
- 実機 `claude -p` run: 計4コール（auth status 確認1 + json schema 確認1 + シナリオ A 1 + シナリオ B 1）。概算 wall time 各 2–15s、サブスク枠消費（名目 cost 合計 < $0.5 相当、実課金なし）。
- 検証対象 repo: `/tmp` の使い捨て git repo（後片付け済み）。

---

## このサイクルで明確になったこと

1. **runner 追加は容易、本丸は events 層と containment** — `CodexExecRunner`（`codex-exec-runner.ts:11-19`）は worktree diff / exitCode / timedOut / durationMs が provider 非依存なので、`createClaudeCliRunner` はそのまま interface を満たせる。難所は F14（スキーマ）と F15（封じ込め）。
2. **サブスク維持と隔離は両立する** — `--setting-sources ""` が鍵。`--bare`（従量課金）に逃げる必要はない。
3. **capability は足りている** — `-p`＋`acceptEdits` でファイル編集も Bash も無確認実行でき、`--tools` で面を絞れる。`--json-schema`（構造化出力）まである。
4. **コスト構造が codex と違う** — サブスクのレート枠共有 + ephemeral の cache_creation オーバーヘッド。`total_cost_usd` はサブスク時は名目値で実課金計測には使えない。

---

## Commits in this cycle

```
(none — investigation only, no code changes)
```

---

## Next phase / Open items

実装に進む場合の要決定（このサイクルでは未着手。理由: 調査のみの依頼スコープ）:

- **F15 permission/containment 網羅検証**: `-p` での Bash allow/deny 境界・worktree 外書込みの実挙動。containment 設計の前提なので最優先。OS サンドボックスでラップするか / リスク受容かは安全側エスカレーション。
- **F14 中立イベントスキーマ**: codex/claude 両 provider を正規化する層 + redaction 書き直し。`run_usage`（#85 V29）の usage 非対称（`reasoning_output_tokens` 欠如・cache 2分割・`total_cost_usd`）を吸収する方針決め。
- **auto-memory の扱い**: `memory_paths.auto` が残る。再現性重視なら抑止 or 無視を明文化（`--bare` なら消えるがサブスク不可のトレードオフ）。
- **PoC 推奨フラグ**（サブスク維持・隔離込み、ops checkout なので実装は dev クローン側で）:
  ```bash
  claude -p \
    --output-format stream-json --verbose \
    --permission-mode acceptEdits \
    --setting-sources "" --strict-mcp-config --disable-slash-commands \
    --tools "Bash Read Edit Write" \
    --no-session-persistence \
    --add-dir <worktree>
  # cwd=<worktree>, prompt=stdin, result.result→最終メッセージ, stream-json→新パーサ
  ```
