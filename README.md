# monorepo-harness

`codex exec` を駆動して **モノレポの 1 ドメインだけ** を安全に編集させる TypeScript CLI ハーネス。

Codex はワークツリー内のファイルを直接編集し、ハーネスは事後に `git diff` を取って **policy の `write` / `deny_write` スコープ** で変更 path を検証する（`read` は codex への prompt/context 用で、読み取りの enforcement はしない）。スコープ外への書き込み・secret 漏洩・symlink 追従などを検出し、レビュー用の artifact 一式を `runs/<runId>/` に残す。

> **Status:** Phase 3 close。Phase 2（ファイルベースで `codex 実行 → 検証 → レビュー → 再実行 → 知見昇格 → cleanup`）に加え、Phase 3 で review-driven retry loop / reviewer 品質評価 / knowledge context 注入 / SQLite index / GitHub PR 連携を追加。`stronger sandbox`（Phase 3-7）は Deferred。

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

## Phase 3 で追加した機能

Phase 2（ファイルベースで人間がトリガする運用）の上に、Phase 3 で次を追加:

| コマンド | Phase | 内容 |
|----------|-------|------|
| `harness workflow reviewed-run` | 3-1 | run → review auto → review process → rerun を bounded loop で束ねる |
| `harness knowledge build-context` / `harness run --with-knowledge` | 3-4 | promote 済み knowledge を domain 別に集約し、次回 run の prompt に注入 |
| `harness review evaluate` / `review compare` | 3-2 | reviewer agent を N 回サンプリングして verdict のばらつきを観測 |
| （prompt template の名前+version 化、`meta.promptTemplate`） | 3-3 | coder / reviewer / harness の role boundary を明文化 |
| `harness index rebuild / status / show` / `review list --use-index` | 3-5 | SQLite run index（派生キャッシュ。source of truth は `runs/` files） |
| `harness pr create` | 3-6 | approved run を GitHub draft PR にする |

**Phase 3-7（stronger sandbox / Docker）は Deferred** — コンテナ内 `codex` の認証が現時点で解決できないため Phase 3 では実装しない（`tmp/phase3/phase3-7-*.md`）。

詳細な close 状況は [`docs/reports/2026-05-21-phase3-close.md`](./docs/reports/2026-05-21-phase3-close.md)（Phase 2 は [`2026-05-21-phase2-close.md`](./docs/reports/2026-05-21-phase2-close.md)）。

## Phase 4 以降の候補

Phase 3 でも次はゴールにしない: 完全自律 merge / 人間レビューなしの本番反映 / OS・Container サンドボックス（Phase 3-7 deferred）/ Web UI / 大規模 multi-agent swarm。
