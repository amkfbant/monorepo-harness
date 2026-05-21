# monorepo-harness

`codex exec` を駆動して **モノレポの 1 ドメインだけ** を安全に編集させる TypeScript CLI ハーネス。

Codex はワークツリー内のファイルを直接編集し、ハーネスは事後に `git diff` を取って **policy の `write` / `deny_write` スコープ** で変更 path を検証する（`read` は codex への prompt/context 用で、読み取りの enforcement はしない）。スコープ外への書き込み・secret 漏洩・symlink 追従などを検出し、レビュー用の artifact 一式を `runs/<runId>/` に残す。

> **Status:** Phase 2 close（試験運用可能なファイルベースのハーネス）。`codex 実行 → 検証 → レビュー → 再実行 → 知見昇格 → cleanup` までを人間が安全に操作できる。

## 必要環境

- Node.js >= 20
- `codex` CLI（`HARNESS_CODEX_BIN` で上書き可能）
- `git`

## セットアップ

```bash
npm install
npm run typecheck
npm test
```

CLI は `npm run harness -- <args>` で起動する（`HARNESS_ROOT` に `policies/` `runs/` `workspaces/` `locks/` の親を指定）。

## Phase 2 quick start

mini-commerce（検証用ダミー monorepo）を題材にした一連の流れ。`HARNESS_ROOT="$PWD"` 前提。

### 1. policy を置く

`policies/global.yaml`（全 run 共通）と `policies/repos/<repo-id>.yaml`（repo ごとの domain 定義）を用意する。形式は [`docs/specs/policy.md`](./docs/specs/policy.md)。サンプルは `policies/repos/mini-commerce.yaml`。

### 2. run — codex に 1 ドメインを編集させる

```bash
npm run --silent harness -- run \
  --repo /path/to/target-repo \
  --repo-id mini-commerce \
  --domain apps/catalog \
  --goal "商品検索に在庫フィルタを追加" \
  --base-branch main
```

policy 解決だけ確認するなら `--dry-run`。run は `runs/<runId>/` に meta.json / events.jsonl / final-diff.patch / summary.md / review-request.md / review-decision.yaml などを残し、`needs_review` で終わる（scope 違反なら `failed-policy-violation`）。

### 3. レビュー待ちを一覧する

```bash
npm run --silent harness -- review list            # needs_review + changes_requested
npm run --silent harness -- review list --all      # 全ステータス
```

### 4. レビューする

reviewer agent（read-only sandbox の codex）に `review-decision.yaml` を生成させるか、人間が手編集する:

```bash
npm run --silent harness -- review auto --run-id <runId>     # codex が verdict を提案
# または runs/<runId>/review-decision.yaml を手編集
npm run --silent harness -- review process --run-id <runId>  # decision を meta.status に適用
```

`review auto` は status を変えない（2 段階構成）。`review process` が `approved` / `changes_requested` / `rejected` に遷移させる。

### 5. changes_requested なら再実行する

```bash
npm run --silent harness -- rerun --from-review <runId>      # required_changes を組み込んだ新 run
npm run --silent harness -- rerun chain --run-id <runId>     # 再実行系譜をツリー表示
```

子 run は `needs_review` で生まれるので、4 に戻ってレビューする。`--max-attempts`（default 2）で収束しない chain を止める。

### 6. 後片付け

```bash
npm run --silent harness -- cleanup --run-id <runId>                 # worktree+branch 削除（run dir は保持）
npm run --silent harness -- cleanup --run-id <runId> --scope run     # run dir も削除
```

`changes_requested` の run は retry base として `--force` でも保護される。

### 7. 知見の昇格（任意）

run が `knowledge-candidates.yaml` に観測シグナルを残していれば:

```bash
npm run --silent harness -- knowledge list --run-id <runId>
npm run --silent harness -- knowledge promote --run-id <runId> --reviewer <name>
npm run --silent harness -- knowledge reject --run-id <runId> --index <n> --reviewer <name> --reason "..."
```

採用した知見は `docs/knowledge/<kind>/*.md`（YAML frontmatter 付き）に展開され、run のライフサイクルとは独立して残る。

## ドキュメント

| 場所 | 内容 |
|------|------|
| [`docs/README.md`](./docs/README.md) | docs 全体の index |
| [`docs/specs/`](./docs/specs/) | 現状仕様 — overview / policy / workflow / cli |
| [`docs/specs/cli.md`](./docs/specs/cli.md) | 全 CLI subcommand のリファレンス |
| [`docs/examples/mini-commerce.md`](./docs/examples/mini-commerce.md) | 検証用ダミー monorepo の構成 |
| [`docs/reports/`](./docs/reports/) | 実機検証ログ + finding registry |
| [`docs/policy-semantics.md`](./docs/policy-semantics.md) | minimatch root-anchored の落とし穴（policy を書く前に） |

## Phase 2 のスコープと Phase 3

Phase 2 は **ファイルベース** で、人間がトリガする運用までを対象とする。次が Phase 3 候補（Phase 2 では実装しない）:

- `review process → rerun → review` の完全自動 retry loop
- multi-agent（reviewer / coder の分離並走）
- DB / SQLite index、Web UI
- GitHub PR 連携
- knowledge md の LLM への自動注入

詳細な close 状況は [`docs/reports/2026-05-21-phase2-close.md`](./docs/reports/2026-05-21-phase2-close.md)。
