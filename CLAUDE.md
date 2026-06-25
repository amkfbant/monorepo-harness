# CLAUDE.md — monorepo-harness

このリポジトリで作業する際の指針。`codex exec` を駆動して **モノレポの 1 ドメイン
だけ** を安全に編集させる TypeScript CLI ハーネス。ハーネスは事後に `git diff` を
取り、policy の `write` / `deny_write` スコープで変更 path を検証する。

> グローバル規約（`~/.claude/CLAUDE.md` 配下: immutability / 小ファイル /
> Conventional Commits / TDD / セキュリティチェック）が前提。本ファイルはそれを
> このプロジェクト向けに具体化する。矛盾時はグローバル規約が優先。

---

## モード（dev / ops）

このリポジトリは2つの役割で使われる。**作業開始時にまずどちらのモードかを確定**
してから動く。安全境界（後述）は dev / ops で完全に同一で、モードによって緩むもの
は無い。違うのは「`src/` を触ってよいか」と「主タスク」だけ。

- **dev モード**: ハーネス自体を開発する。`src/` を TDD で編集し、typecheck/test を
  通し、spec を同じコミットで更新する。**本ファイル全体がそのまま適用される**。
- **ops モード**: 実運用。**不変の release タグ（`vX.Y.Z`）に pin された checkout**
  で本物の対象モノレポにハーネスを動かす。`src/`（ハーネス本体）は **read-only。
  編集しない**。役割は run 統括・finding triage・escalation 対応・DB / 認証 / secret
  等の運用。コード変更が要るなら **dev クローン側で issue / PR にする**（ops checkout
  で直接直すと pin が崩れる）。手順は **[`AGENTS.md`](./AGENTS.md)** と
  **[`docs/ops/`](./docs/ops/)** を正本とする。

**モードの見分け方（決定論的に）**: ops は通常 **detached HEAD で release タグに
pin**（`git describe --tags --exact-match` が成功）、dev は **`main` / feature
ブランチ上**。ディレクトリ規約（`ops/monorepo-harness` vs `dev/monorepo-harness`）も
補助。迷ったら**人間に確認**し、安全側（= ops とみなして `src/` を触らない）に倒す。

### 開発の駆動は必ず ops ハーネスで行う（不可侵）

**用語（このリポジトリ固有・厳密に区別する）**:

- **dev クローン** = `~/dev/monorepo-harness`。ハーネスの**編集対象（target）**。`main` /
  feature ブランチ上にあり、ここのコードを変更していく。
- **dev ハーネス** = dev クローン内で動かすハーネス CLI（`npm run harness`）。
  ＝**開発中の・まだ確定していないコード**で動くハーネス。
- **ops ハーネス** = 別 checkout `~/ops/monorepo-harness` で動かすハーネス CLI。
  ＝**release タグに pin した安定版**で動くハーネス。

**鉄則（これだけ守れば良い）**:
**「ops ハーネスで dev クローンを開発する。dev ハーネスで dev クローンを開発しない。」**

具体的には、course / hitch を `course orchestrate` / `hitch orchestrate` で回す
**駆動側（orchestrator）は必ず ops ハーネス**、**編集対象（`--repo`）は dev クローン**。
**dev ハーネスで開発を駆動してはならない**（＝開発中の未確定コードで自分自身を開発しない）。
※「ハーネス自身の開発（self-hosting）」を禁止しているのではない。**どのハーネスが駆動するか**
（安定版 ops か、未確定の dev か）の問題であり、答えは常に ops。

- **理由（bootstrapping）**: 開発中の（＝未確定の）dev ハーネスで開発を駆動すると、その
  被験コード自身の orchestrate / convergence / workspace-base のバグが駆動ループを壊す
  （例: command-kind close-check が充足不能 / run workspace が stale base から分岐 /
  良性 finding での誤 escalate）。**pin された安定版の ops ハーネスを driver にする**ことで、
  この自己参照的な不安定さを避けられる。
- **構成**: course / hitch レコードは **ops DB**（`~/ops/monorepo-harness/.harness`）に置く。
  駆動は ops checkout から `node dist/cli/run.js course|hitch orchestrate --repo
  /Users/kn/dev/monorepo-harness --base-branch <branch> …`。target は ops に project 登録済みの
  `monorepo-harness`（profile は dev クローン由来）。PR は dev クローンのブランチから `main` へ。
- **dev ハーネスの用途は限定**: dev クローン内の `npm run harness` は、編集の局所確認
  （typecheck / test / 単発 CLI 動作確認 / `--dry-run`）に留める。**self course / hitch の
  orchestrate ループ駆動には使わない。**
- 迷ったら安全側: ops 駆動が確立できないときは**人間に確認**し、dev 自己駆動に倒さない。

---

## hitch モードのとき（最重要）

このハーネスを **hitch モード**（`harness hitch` 系で実装/レビュー/修正ループを
回す）で動かす・実装する際は、以下を**必ず**参照する。

1. **roadmap（DB 正本）** — 「何を作るか」。大 Phase / サブ Phase / 実装順 / スコープは
   **DB の `course → phase` roadmap**（SP-1/SP-2）が正本。`harness course list` /
   `harness course status <id>` / `harness course export <id> --md` で読む（仕様は
   [`docs/specs/roadmap.md`](./docs/specs/roadmap.md)）。旧 `GOAL.md`（markdown
   roadmap）は廃止済み（git 履歴に残置）。
2. **[`GOAL_RULES.md`](./GOAL_RULES.md)** — 「どう作るか」。レビューのリトライ
   と続行判断（未解決 P0 ゼロが続行/close の必須条件）、finding の P0〜P3 分類、
   close 条件、テスト粒度、ブランチ/マージ運用、スコープ管理、安全境界、開発規律、
   codex レビューテンプレート（サブ用 / 大用）。
3. **[`AGENTS.md`](./AGENTS.md)** — hitch convergence の運用ルール（hitch session
   を先に立てる / read → dry-run → guarded mutation の順 / 各レビュー後に finding
   記録 / `harness hitch check-convergence` / escalate・diverging・budget_exhausted・
   needs_classification で自動修正を止める / MCP `confirmation_required` を shell で
   迂回しない）。

**codex レビューコマンドは常に `harness codex exec` 透過ラッパ経由で起動する。**
**course / hitch 駆動中は `--harness-course-id=<id>` / `--harness-hitch-id=<id>` を必須**とし
（usage を course/hitch に紐付け。READ 経路は #403）、`--` を挟んで
`-m gpt-5.5 -c model_reasoning_effort="xhigh"` を渡す（サブ Phase は最大 3 回、大 Phase は
最大 5 回リトライ。詳細は `GOAL_RULES.md`）。

**サブエージェント（Claude 側）は軽量ポリシー**（`GOAL_RULES.md` §I）: 探索は
`Explore` 等に常用、実装の subagent-driven 化は任意、**レビューの正本は codex**
（Claude 側レビューは codex 提出前の自己レビュー前段に限定し二重ゲートにしない）。
ハーネス内部の codex coder/reviewer agent とは別層。

---

## 安全境界（不可侵）

どの作業でも侵してはならない。`GOAL_RULES.md` §G と同一。

- **policy 検証は事後 `git diff` ベース**。検証を緩める/バイパスする変更は不可。
- **LLM の出力を信用しない**。severity や「修正した」等の自己申告を状態遷移の
  根拠にしない。判定は決定論的な harness 側ロジックで行う。
- **状態遷移は harness のみ**。hitch / run / finding / review のライフサイクルを
  LLM やレビュー出力が直接書き換えることを許さない。
- **MCP `confirmation_required` を shell で迂回しない**。dangerous operation は
  `operation confirm` / `operation reject` で out-of-band に処理する。
- 迷ったら安全側（停止・エスカレーション）に倒す（fail-closed）。

---

## 主要コマンド

```bash
npm run typecheck      # tsc --noEmit。commit 前に必須
npm test               # vitest run（フルスイート）
npm run test:watch     # vitest（watch）
npm run build          # dist/ ビルド
npm run harness -- <args>   # 開発時の CLI 起動（tsx 経由、HARNESS_ROOT 指定）
```

- **commit 前に必ず `npm run typecheck`。**
- サブ Phase = 関連テスト + typecheck 緑、大 Phase = フルスイート + typecheck 緑
  （回帰禁止。テストを弱める/skip する形の「緑化」は禁止）。
- CLI の全 subcommand は [`docs/specs/cli.md`](./docs/specs/cli.md)。

---

## 参照すべきドキュメント

| 場所 | 内容 | いつ読む |
|------|------|---------|
| roadmap（DB 正本: `harness course` / [`docs/specs/roadmap.md`](./docs/specs/roadmap.md)） | 実装ロードマップ（大/サブ Phase）。旧 `GOAL.md` は廃止 | hitch モードの実装着手前 |
| [`GOAL_RULES.md`](./GOAL_RULES.md) | hitch モード実行ルール | hitch モードの実装中ずっと |
| [`AGENTS.md`](./AGENTS.md) | hitch convergence 運用ルール | hitch セッション運用時 |
| [`docs/ops/release-and-upgrade.md`](./docs/ops/release-and-upgrade.md) | リリース（release-please）/ ハーネスのアップデート手順 | 版上げ・ops checkout 更新時 |
| [`docs/README.md`](./docs/README.md) | docs 全体の index | 迷ったらまず |
| [`docs/specs/overview.md`](./docs/specs/overview.md) | 何ができて何ができないか | 全体像把握 |
| [`docs/specs/cli.md`](./docs/specs/cli.md) | 全 CLI subcommand リファレンス | コマンドを使う前 |
| [`docs/specs/policy.md`](./docs/specs/policy.md) | policy YAML 形式と評価順 | policy を書く前 |
| [`docs/policy-semantics.md`](./docs/policy-semantics.md) | minimatch root-anchored の落とし穴 | policy を書く前（必読） |
| [`docs/specs/workflow.md`](./docs/specs/workflow.md) | run の status machine / codex 起動方式 / artifact | run/codex 周りを触る前 |
| [`docs/specs/db.md`](./docs/specs/db.md) | `harness.sqlite`（DB read/canonical）と import | DB を触る前 |
| [`docs/specs/mcp.md`](./docs/specs/mcp.md) | MCP server（tools/resources/permission/confirmation） | MCP を触る前 |
| [`docs/specs/dashboard.md`](./docs/specs/dashboard.md) | dashboard（read-only API + mutation API） | dashboard を触る前 |
| [`docs/specs/hitch-convergence.md`](./docs/specs/hitch-convergence.md) | hitch convergence controller の仕様 | hitch 内部を触る前 |
| [`docs/specs/roadmap.md`](./docs/specs/roadmap.md) | course → phase ロードマップ層（SP-1/SP-2）のデータモデル・API・ロールアップ・orchestrate 仕様 | course/phase を触る前 |
| [`docs/specs/workspace.md`](./docs/specs/workspace.md) | agent workspaces（per-agent worktree / checkpoint / 並行安全モデル） | workspace を触る/使う前 |
| [`docs/specs/project.md`](./docs/specs/project.md) | Project Abstraction 層 | project profile を触る前 |
| [`docs/future-features.md`](./docs/future-features.md) | 将来 feature（スコープ外の保留事項） | スコープ外を見つけたとき |
| [`docs/ops/`](./docs/ops/) | 認証/secret・DB メンテ・運用 manual | 運用設定時 |
| [`docs/reports/`](./docs/reports/) | 実機検証ログ + finding registry | 過去の経緯確認時 |
| [`docs/examples/mini-commerce.md`](./docs/examples/mini-commerce.md) | 検証用ダミー monorepo の構成 | テスト/検証時 |

---

## 開発規律

- **TDD**: RED（失敗するテスト）→ GREEN（最小実装）→ REFACTOR。production コードの
  前にテストを書く。
- **Conventional Commits**（`feat:` / `fix:` / `refactor:` / `test:` / `docs:` /
  `chore:` / `perf:` / `ci:`）。attribution（Co-Authored-By）は付けない。
- **spec 駆動**: `src/` や policy の動作が変わったら、対応する `docs/specs/*` を
  **同じコミットで**更新する。`docs/specs/` は現状のスナップショット（TODO を
  書かない）。
- **codex exec レビュー（hitch モード外の通常 PR にも適用）**: 実質的な変更の PR は
  **merge 前に `harness codex exec` 経由で差分レビュー**する。コマンドは常に
  `harness codex exec --harness-label=pr-review -- -m gpt-5.5 -c model_reasoning_effort="xhigh" -s read-only -o <out> "<prompt>" < /dev/null`
  （`-s read-only` ＋ **stdin クローズ（`< /dev/null`）で hang 回避**。course/hitch 駆動の
  一環なら `--harness-label` の代わりに `--harness-course-id` / `--harness-hitch-id` を付ける）。**P0 / P1 は
  修正必須**、P2 は修正 or `docs/future-features.md` に defer（理由を記録）。PR の
  bot レビュー（codex App / Copilot）の受け入れ指摘も併せて反映する。hitch モードの
  リトライ上限（サブ ≤3 / 大 ≤5）・レビューテンプレート・未解決 P0 ゼロ gate は
  [`GOAL_RULES.md`](./GOAL_RULES.md) を正本とする。
- **immutability**（新オブジェクトを作り、mutate しない）、適切なエラーハンドリング、
  `console.log` を残さない。
- **cohesion-first ファイル分割（#125 RP1-RP5）**: 行数でなく cohesion（1 ファイル＝
  1 責務）を一次基準とする。ただし **800 行は HARD cap**（review/diff 粒度が破綻するため
  超過は分割必須）で、`tests/meta/file-size.test.ts` が grandfather ratchet 付きで機械強制
  する（既存の 800 超は現サイズを baseline に「増やさない」、新規/縮小済は 800 以下、
  schema.ts/tool-registry.ts は append-only 台帳ゆえ構造的恒久例外）。関数は単一責務・
  上限 80 行目安。コメントは「何を」でなく **why / 不変条件 / 落とし穴 / 編集前に読む doc**
  に焦点（behavior の再記述は docs/specs が正本）。always-on の `CLAUDE.md` は薄く保つ
  （詳細は on-demand な `GOAL_RULES.md`／`docs/` へ relocate）。詳細規約は
  [`GOAL_RULES.md`](./GOAL_RULES.md) §H。
- **スコープを広げない**: 作業中に見つけたスコープ外の事項は backlog /
  `docs/future-features.md` / follow-up に積む（その場で直さない）。

---

## アーキテクチャの要点

- **DB-canonical**: `.harness/harness.sqlite`（現行 schema）が runtime の source of
  truth。files は互換 export。DB を触る変更は migration / import / consistency を
  確認する（`docs/specs/db.md`）。
- **codex は単発・ステートレス**: `codex exec --ephemeral` で毎回新規 prompt。
  会話セッションは持たない（再現性・監査性のための設計判断。`docs/future-features.md`
  の「Codex session continuation」参照）。文脈は prompt 注入（rerun の
  `required_changes` / knowledge context）と run lineage（`parentRunId` /
  `rootRunId`）で引き継ぐ。
- **runner は DI 抽象**: `CodexExecRunner`（`src/codex/`）。テストは
  `createFakeCodexRunner()` を使う。
