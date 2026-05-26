# Harness specs

monorepo-harness の **現状仕様** をまとめたディレクトリ。

実装の真は `src/` にあるが、頻繁に参照される構造（policy YAML format / RunStatus 遷移 / artifact レイアウト / CLI subcommand）を読み物として独立させたもの。新しい人が `src/` を読まずに「何ができて何ができないか」を 30 分で把握できることを目指す。

## ToC

- [`overview.md`](./overview.md) — ハーネスは何で、何ができて、何ができないか
- [`policy.md`](./policy.md) — policy YAML の形式（global / repo / domain）と評価順
- [`project.md`](./project.md) — Project Abstraction 層（project profile / domain registry / templates / context pack、Phase 5）
- [`db.md`](./db.md) — `harness.sqlite`（DB read model）と file からの import、source-of-truth transition（Phase 6）
- [`dashboard.md`](./dashboard.md) — DB-backed な project-aware ダッシュボード（Phase 6）
- [`mcp.md`](./mcp.md) — coding agent 向け MCP server（tools / resources / prompts / permission / confirmation）
- [`goal-convergence.md`](./goal-convergence.md) — Phase 19 goal convergence controller（scope freeze / finding lifecycle / close decision）
- [`workflow.md`](./workflow.md) — `domain-coding` workflow の status machine と artifact レイアウト
- [`cli.md`](./cli.md) — 全 CLI subcommand リファレンス（`run` / `lock` / `review list` / `review auto` / `review process` / `rerun` / `cleanup` / `knowledge promote`）

関連 docs:

- [`docs/policy-semantics.md`](../policy-semantics.md) — minimatch root-anchored の落とし穴（policy 書く前に必読）
- [`docs/examples/mini-commerce.md`](../examples/mini-commerce.md) — 検証用ダミー monorepo の構成
- [`docs/reports/`](../reports/) — 実機検証ログと finding 履歴

## 更新方針

- src/ や policy の動作が変わったら、対応するファイルも同じコミットで更新
- breaking change の場合は report (`docs/reports/`) も別途残す
- 「TODO」は書かない。原則 specs/ は現状のスナップショットだが、実装 phase 中の target spec はファイル冒頭でその状態を明記する
