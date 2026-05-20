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
    README.md, TEMPLATE.md, 2026-05-20-mvp-validation-initial.md, 2026-05-20-mvp-validation-followup.md
  superpowers/plans/       ← 実装計画 (history 含む; 完了後も残す)
    2026-05-20-codex-exec-harness-mvp.md
    2026-05-20-mini-commerce-validation.md
```

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
