# docs/

monorepo-harness のドキュメント。コードと **同じリポジトリ** で git 管理する。

## ディレクトリ構成

```txt
docs/
  README.md                ← このファイル (index)
  policy-semantics.md      ← minimatch root-anchored の落とし穴 (policy 書く前に必読)
  specs/                   ← 現状仕様 (実装と同期、TODO は書かない)
    README.md, overview.md, policy.md, workflow.md, cli.md
  examples/                ← サンプル / 検証 fixture の仕様
    mini-commerce.md
  reports/                 ← 開発サイクルの記録 + finding registry
    README.md, TEMPLATE.md,
    2026-05-20-mvp-validation-*.md,
    2026-05-21-phase2-*.md   (review-commands-cleanup / 2-4〜2-9 demo / phase2-close)
  superpowers/plans/       ← 実装計画 (history 含む; 完了後も残す)
```

## harness の機能（run の後段）

`harness run` の後に続く一連の subcommand（Phase 2〜4）。詳細は [`specs/cli.md`](./specs/cli.md)。クローズ状況は [`reports/2026-05-21-phase2-close.md`](./reports/2026-05-21-phase2-close.md) / [`reports/2026-05-21-phase3-close.md`](./reports/2026-05-21-phase3-close.md) / [`reports/2026-05-21-phase4-close.md`](./reports/2026-05-21-phase4-close.md)。個人運用ルーティンは [`ops/personal-operating-manual.md`](./ops/personal-operating-manual.md)。

| subcommand | 役割 |
|------------|------|
| `harness review list [--all\|--status\|--domain\|--limit\|--json]` | review queue（needs_review + changes_requested）を一覧 |
| `harness review auto --run-id <id>` | reviewer agent（read-only codex）が `review-decision.yaml` を生成 |
| `harness review evaluate / compare` | reviewer agent を N 回走らせ verdict のばらつきを観測 / 2 decision を比較（Phase 3-2） |
| `harness review process --run-id <id>` | `review-decision.yaml` を適用し status 遷移 |
| `harness rerun --from-review <id> [--max-attempts <n>]` | `changes_requested` から `required_changes` を組み込んだ新 run（収束制御つき） |
| `harness rerun chain --run-id <id>` | 再実行系譜（root → 子孫）をツリー表示 |
| `harness knowledge list / reject / promote` | 候補をレビュー（status 表示 / reject 記録 / `--reviewer` 付き昇格 + 重複制御） |
| `harness knowledge build-context --domain <d>` | promote 済み knowledge を domain 別に集約（`run --with-knowledge` 用、Phase 3-4） |
| `harness cleanup --run-id <id> [--scope …]` | worktree / branch / run dir を scope 単位で削除 |
| `harness workflow reviewed-run …` | run → review auto → review process → rerun を bounded loop で束ねる（Phase 3-1） |
| `harness goal ...` | scope / findings / close checks / convergence decision を DB に記録し、長い agent loop を止める（Phase 19）。`goal orchestrate` / `goal await-merge`（close_ready の PR を poll でマージ）/ `goal finding classify --then-rerun`（分類→coder rerun 自動連鎖）を含む |
| `harness workspace create/adopt/list/status/conflicts/inspect/checkpoint/recover/remove` | per-agent 隔離 worktree。並行 multi-agent 作業の競合 pre-check・状態同期・heartbeat（[`specs/workspace.md`](./specs/workspace.md)） |
| `harness mcp serve` | coding agent 向け MCP server（tools / resources / prompts・[`specs/mcp.md`](./specs/mcp.md)） |
| `harness index` | Phase 8-7 で撤去（`harness.sqlite` read model に置換）。exit 1 の stub のみ残置 |
| `harness pr create --run-id <approved-id>` | approved run を GitHub draft PR にする（Phase 3-6） |
| `harness run show / timeline / artifacts` | 1 run の状態を read-only で集約表示（Phase 4-1） |
| `harness inbox` | 今日見るべきもの（needs_review / changes_requested / failed / cleanup / knowledge）を集約（Phase 4-2） |
| `harness backlog add/list/show/run/done/defer` | 個人 backlog。run と双方向リンク（Phase 4-3） |
| `harness maintenance check / cleanup` | stale lock / orphan worktree 等の残骸を検出・掃除（Phase 4-4） |
| `harness knowledge digest` | knowledge candidate / promoted / rejected を期間・domain 別集計（Phase 4-5） |
| `harness metrics summary / domain / failures` | run / review / retry / safety 指標（Phase 4-6） |
| `harness session plan / start / summary` | ルール順の作業セッション提案（提案のみ、Phase 4-7） |
| `harness dashboard export` | read-only な静的 HTML ダッシュボード（Phase 4-8） |

`policy.commands.allow` の structured form（`{id, cmd, args, timeout_ms, env}`）と `commands.defaults` も Phase 2 で追加（[`specs/policy.md`](./specs/policy.md)）。各機能の実機デモ結果は `reports/2026-05-21-phase2-*.md`。

## monorepo-harness と mini-commerce の関係

```txt
/Users/kn/dev/
  monorepo-harness/          ← このリポジトリ (codex runner)
    src/, tests/, policies/, docs/
    runs/, workspaces/       ← runtime (ignored)
  mini-commerce/             ← sibling: 検証用ダミー monorepo
    apps/, packages/, docs/
```

| 何 | どこ | 何を入れる |
|----|------|-----------|
| **harness 実装** | `monorepo-harness/src/` | CLI / policy resolver / workflow runner / codex runner / reporter |
| **harness テスト** | `monorepo-harness/tests/` | unit + integration（fake codex runner で完結） |
| **harness 仕様** | `monorepo-harness/docs/specs/` | 上記の **現状** 仕様 (`overview / policy / workflow / cli`) |
| **検証 fixture** | `/Users/kn/dev/mini-commerce/` | 小さな TS monorepo。実 git repo |
| **fixture 仕様** | `monorepo-harness/docs/examples/mini-commerce.md` | mini-commerce のディレクトリ / domain / policy を文書化 |
| **fixture 用 policy** | `monorepo-harness/policies/repos/mini-commerce.yaml` | mini-commerce に対する domain ごとの read/write/deny |
| **検証ログ** | `monorepo-harness/docs/reports/` | 実機 codex run での発見 + finding registry |
| **計画 (history)** | `monorepo-harness/docs/superpowers/plans/` | 何をどう作る計画だったかの記録 |

要約: **harness は mini-commerce の sibling として動作する。mini-commerce 自体の中身（apps/catalog 等）は harness の検証に必要なだけの最小スタブで、本番アプリではない。**

## 読み方ガイド

### 「ハーネスを動かしたい」(新しい人向け)

1. `specs/overview.md` — 何ができるか
2. `specs/cli.md` — どう叩くか
3. `examples/mini-commerce.md` — 実物を見たい / fixture をどう作るか
4. (必要なら) `policy-semantics.md` — policy 書く前の必読

### 「policy を編集したい」

1. `policy-semantics.md` — minimatch の落とし穴 (`dist/**` と `**/dist/**` の違い)
2. `specs/policy.md` — global / repo YAML の完全リファレンス
3. `policies/global.yaml` と `policies/repos/<id>.yaml` の中身

### 「ハーネスの挙動を変えたい」(コードを書く人向け)

1. `specs/workflow.md` — status machine と artifact 生成順
2. `src/core/workflow-runner.ts` — 実装本体
3. `tests/integration/workflow-fake-codex.test.ts` — 既存テストの形

### 「実機で何が起こっているか追跡したい」

1. `docs/reports/` の最新 report — 最近の finding と現状
2. `runs/<runId>/meta.json` + `events.jsonl` — 1 run の生データ
3. `runs/<runId>/review-request.md` — reviewer 向けサマリ

## 編集ルール

| ディレクトリ | 編集タイミング | rewrite OK? |
|-------------|---------------|-------------|
| `specs/` | 実装が変わった同じコミットで更新 | OK（仕様は現在形） |
| `examples/` | fixture を変えたとき | OK |
| `reports/` | サイクル完了時に追加 | **NG**（過去ログ） |
| `superpowers/plans/` | 計画を立てたとき | **NG**（history） |
| `policy-semantics.md` | minimatch 関連の挙動が変わったら | OK |

`reports/` と `plans/` は **後から書き換えない**。修正したいことがあれば新規 report で扱う。

## 関連 ext docs

ハーネス特有でない一般的な docs（Codex CLI / プラットフォーム） は本リポジトリには置かない。
- Codex CLI: `codex --help`
- Node / TypeScript: 公式 docs
- minimatch: https://github.com/isaacs/minimatch
